// Gartic Phone Clone - Cloudflare Worker + Durable Object
// 1部屋 = 1 Durable Object インスタンス（部屋コードで識別）

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { id, name }
    this.data = null;
  }

  async initData() {
    if (this.data === null) {
      this.data = (await this.state.storage.get("data")) || null;
    }
  }

  async save() {
    await this.state.storage.put("data", this.data);
  }

  broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(str);
      } catch (e) {
        // ignore broken sockets, cleaned up on close event
      }
    }
  }

  publicState() {
    return {
      code: this.data.code,
      phase: this.data.phase,
      players: this.data.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.isHost,
      })),
      round: this.data.round,
      totalRounds: this.data.totalRounds,
      settings: this.data.settings,
      submittedCount: Object.values(this.data.submissions || {}).filter(Boolean)
        .length,
      connectedCount: this.data.players.filter((p) => p.connected).length,
    };
  }

  async fetch(request) {
    await this.initData();
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    const name = (url.searchParams.get("name") || "Player").slice(0, 20);
    const id = url.searchParams.get("id") || crypto.randomUUID();
    const create = url.searchParams.get("create") === "1";
    const code = url.searchParams.get("code");

    if (!this.data) {
      if (!create) {
        return new Response("room not found", { status: 404 });
      }
      this.data = {
        code,
        phase: "lobby", // lobby | playing | reveal
        players: [],
        order: [],
        round: 0,
        totalRounds: 0,
        submissions: {},
        chains: {},
        settings: { drawSeconds: 70, writeSeconds: 45 },
      };
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let player = this.data.players.find((p) => p.id === id);
    if (!player) {
      if (this.data.phase !== "lobby") {
        server.send(
          JSON.stringify({
            type: "error",
            message: "このゲームはすでに開始されているため参加できません。",
          })
        );
        server.close(1000, "game in progress");
        return new Response(null, { status: 101, webSocket: client });
      }
      player = {
        id,
        name,
        connected: true,
        isHost: this.data.players.length === 0,
      };
      this.data.players.push(player);
    } else {
      player.connected = true;
      player.name = name;
    }
    this.sessions.set(server, { id: player.id, name: player.name });
    await this.save();

    server.send(
      JSON.stringify({ type: "welcome", you: player, state: this.publicState() })
    );
    this.broadcast({ type: "state", state: this.publicState() });

    if (this.data.phase === "playing") {
      const turn = this.getTurnFor(player.id);
      if (turn) server.send(JSON.stringify({ type: "your_turn", turn }));
      if (this.data.submissions[player.id]) {
        server.send(JSON.stringify({ type: "waiting" }));
      }
    }
    if (this.data.phase === "reveal") {
      server.send(
        JSON.stringify({ type: "reveal", chains: this.buildRevealChains() })
      );
    }

    server.addEventListener("message", (evt) => this.handleMessage(server, evt));
    server.addEventListener("close", () => this.handleClose(server));
    server.addEventListener("error", () => this.handleClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleClose(ws) {
    const sess = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (sess && this.data) {
      const p = this.data.players.find((pl) => pl.id === sess.id);
      if (p) p.connected = false;
      await this.save();
      this.broadcast({ type: "state", state: this.publicState() });
    }
  }

  async handleMessage(ws, evt) {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }
    const sess = this.sessions.get(ws);
    if (!sess || !this.data) return;
    const player = this.data.players.find((p) => p.id === sess.id);
    if (!player) return;

    if (msg.type === "start") {
      if (!player.isHost || this.data.phase !== "lobby") return;
      const connected = this.data.players.filter((p) => p.connected);
      if (connected.length < 2) {
        ws.send(
          JSON.stringify({ type: "error", message: "開始には2人以上必要です。" })
        );
        return;
      }
      await this.startGame(msg.settings || {});
      return;
    }

    if (msg.type === "submit") {
      if (this.data.phase !== "playing") return;
      if (this.data.submissions[player.id]) return;
      const turn = this.getTurnFor(player.id);
      if (!turn) return;
      if (typeof msg.content !== "string" || msg.content.length === 0) return;
      if (msg.content.length > 400000) return; // ~400KB safety cap

      const chain = this.data.chains[turn.chainOwnerId];
      chain[this.data.round] = {
        type: turn.expect,
        content: msg.content,
        authorId: player.id,
        authorName: player.name,
      };
      this.data.submissions[player.id] = true;
      await this.save();
      this.broadcast({ type: "state", state: this.publicState() });
      ws.send(JSON.stringify({ type: "waiting" }));

      const allIn = this.data.players
        .filter((p) => p.connected)
        .every((p) => this.data.submissions[p.id]);
      if (allIn) {
        await this.advanceRound();
      }
      return;
    }

    if (msg.type === "kick") {
      if (!player.isHost || this.data.phase !== "lobby") return;
      this.data.players = this.data.players.filter((p) => p.id !== msg.id);
      await this.save();
      this.broadcast({ type: "state", state: this.publicState() });
      return;
    }

    if (msg.type === "restart") {
      if (!player.isHost) return;
      this.data.phase = "lobby";
      this.data.round = 0;
      this.data.totalRounds = 0;
      this.data.chains = {};
      this.data.order = [];
      this.data.submissions = {};
      await this.save();
      this.broadcast({ type: "state", state: this.publicState() });
    }
  }

  async startGame(settings) {
    const players = this.data.players.filter((p) => p.connected);
    const order = shuffle(players.map((p) => p.id));
    this.data.order = order;
    this.data.totalRounds = order.length;
    this.data.round = 0;
    this.data.phase = "playing";
    this.data.chains = {};
    for (const id of order) this.data.chains[id] = new Array(order.length).fill(null);
    this.data.submissions = {};
    this.data.settings = {
      drawSeconds: Math.min(Math.max(settings.drawSeconds || 70, 15), 300),
      writeSeconds: Math.min(Math.max(settings.writeSeconds || 45, 10), 180),
    };
    await this.save();
    this.broadcast({ type: "state", state: this.publicState() });
    this.sendAllTurns();
  }

  getTurnFor(playerId) {
    const n = this.data.order.length;
    const p = this.data.order.indexOf(playerId);
    if (p === -1) return null;
    const r = this.data.round;
    const chainOwnerIdx = (((p - r) % n) + n) % n;
    const chainOwnerId = this.data.order[chainOwnerIdx];
    const chain = this.data.chains[chainOwnerId];
    const prev = r === 0 ? null : chain[r - 1];
    const expect = r === 0 ? "text" : prev.type === "text" ? "drawing" : "text";
    return {
      chainOwnerId,
      round: r,
      totalRounds: n,
      expect,
      prompt: prev ? prev.content : null,
      promptType: prev ? prev.type : null,
      seconds:
        expect === "drawing" ? this.data.settings.drawSeconds : this.data.settings.writeSeconds,
    };
  }

  sendAllTurns() {
    for (const [ws, sess] of this.sessions) {
      const turn = this.getTurnFor(sess.id);
      if (turn) {
        try {
          ws.send(JSON.stringify({ type: "your_turn", turn }));
        } catch (e) {}
      }
    }
  }

  async advanceRound() {
    this.data.round += 1;
    this.data.submissions = {};
    if (this.data.round >= this.data.totalRounds) {
      this.data.phase = "reveal";
      await this.save();
      this.broadcast({ type: "state", state: this.publicState() });
      this.broadcast({ type: "reveal", chains: this.buildRevealChains() });
    } else {
      await this.save();
      this.broadcast({ type: "state", state: this.publicState() });
      this.sendAllTurns();
    }
  }

  buildRevealChains() {
    return this.data.order.map((ownerId) => {
      const owner = this.data.players.find((p) => p.id === ownerId);
      return {
        ownerName: owner ? owner.name : "???",
        entries: this.data.chains[ownerId],
      };
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9]{4,10})\/ws$/);
    if (match) {
      const code = match[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.searchParams.set("code", code);
      const forwarded = new Request(forwardUrl.toString(), request);
      return stub.fetch(forwarded);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("Gartic Phone Clone Worker: OK", {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
      });
    }

    return new Response("not found", { status: 404, headers: corsHeaders() });
  },
};
