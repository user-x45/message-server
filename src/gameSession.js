// Durable Object: GameSession
// ゲームセッションのすべての状態を管理する

export class GameSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    // ゲームデータを読み込む
    let game = (await this.state.storage.get('game')) || null;

    // POST /init — 初期化
    if (path === '/init') {
      const body = await request.json();
      const { code, hostName, maxPlayers } = body;
      if (game) return json({ error: 'Already initialized' }, 400);

      const hostId = crypto.randomUUID();
      game = {
        code,
        status: 'waiting', // waiting | drawing | guessing | finished
        maxPlayers,
        players: [{ id: hostId, name: hostName, isHost: true, joinedAt: Date.now() }],
        topic: null,
        drawings: [],   // [{ playerId, playerName, imageData, submittedAt }]
        guess: null,    // { playerId, playerName, text, submittedAt }
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        currentTurn: 0, // 何番目の人が描く番か
      };
      await this.state.storage.put('game', game);
      return json({ ok: true, code, hostId, game: this._publicGame(game, hostId) });
    }

    if (!game) return json({ error: 'Game not found' }, 404);

    // GET /info — 参加前の情報
    if (path === '/info') {
      return json({
        code: game.code,
        status: game.status,
        playerCount: game.players.length,
        maxPlayers: game.maxPlayers,
        players: game.players.map(p => ({ name: p.name, isHost: p.isHost })),
      });
    }

    // POST /join — 参加
    if (path === '/join') {
      const body = await request.json();
      const { playerName } = body;
      if (!playerName) return json({ error: 'playerName required' }, 400);
      if (game.status !== 'waiting') return json({ error: 'Game already started' }, 400);
      if (game.players.length >= game.maxPlayers) return json({ error: 'Room is full' }, 400);
      if (game.players.find(p => p.name === playerName)) {
        return json({ error: 'Name already taken' }, 400);
      }

      const playerId = crypto.randomUUID();
      game.players.push({ id: playerId, name: playerName, isHost: false, joinedAt: Date.now() });
      await this.state.storage.put('game', game);
      return json({ ok: true, playerId, game: this._publicGame(game, playerId) });
    }

    // POST /start — ゲーム開始（ホストのみ）
    if (path === '/start') {
      const body = await request.json();
      const { playerId, topic, imageData } = body;
      const player = game.players.find(p => p.id === playerId);
      if (!player || !player.isHost) return json({ error: 'Only host can start' }, 403);
      if (game.status !== 'waiting') return json({ error: 'Already started' }, 400);
      if (game.players.length < 2) return json({ error: 'Need at least 2 players' }, 400);
      if (!topic) return json({ error: 'topic required' }, 400);
      if (!imageData) return json({ error: 'imageData required' }, 400);

      game.topic = topic;
      game.status = 'drawing';
      game.startedAt = Date.now();
      game.currentTurn = 1; // 2番目の人（index 1）の番
      game.drawings.push({
        playerId: player.id,
        playerName: player.name,
        imageData,
        submittedAt: Date.now(),
        turnIndex: 0,
      });
      await this.state.storage.put('game', game);
      return json({ ok: true, game: this._publicGame(game, playerId) });
    }

    // POST /submit — 絵または答えを提出
    if (path === '/submit') {
      const body = await request.json();
      const { playerId, imageData, guess } = body;
      const player = game.players.find(p => p.id === playerId);
      if (!player) return json({ error: 'Player not found' }, 404);
      if (game.status === 'waiting' || game.status === 'finished') {
        return json({ error: 'Not in a submittable state' }, 400);
      }

      const playerIndex = game.players.findIndex(p => p.id === playerId);
      if (playerIndex !== game.currentTurn) {
        return json({ error: 'Not your turn' }, 400);
      }

      const isLastPlayer = game.currentTurn === game.players.length - 1;

      if (isLastPlayer) {
        // 最後の人は答えを当てる
        if (!guess) return json({ error: 'guess required for last player' }, 400);
        game.guess = {
          playerId: player.id,
          playerName: player.name,
          text: guess,
          submittedAt: Date.now(),
        };
        game.status = 'finished';
        game.finishedAt = Date.now();
      } else {
        // それ以外の人は絵を描いて提出
        if (!imageData) return json({ error: 'imageData required' }, 400);
        game.drawings.push({
          playerId: player.id,
          playerName: player.name,
          imageData,
          submittedAt: Date.now(),
          turnIndex: playerIndex,
        });
        game.currentTurn += 1;

        // 次の人が最後かチェック → guessing フェーズへ
        if (game.currentTurn === game.players.length - 1) {
          game.status = 'guessing';
        }
      }

      await this.state.storage.put('game', game);
      return json({ ok: true, game: this._publicGame(game, playerId) });
    }

    // GET /state — 現在の状態（プレイヤー個別に情報を返す）
    if (path === '/state') {
      const playerId = url.searchParams.get('playerId');
      return json(this._publicGame(game, playerId));
    }

    // GET /result — ゲーム結果（全データ）
    if (path === '/result') {
      if (game.status !== 'finished') return json({ error: 'Game not finished' }, 400);
      return json({
        code: game.code,
        topic: game.topic,
        players: game.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
        drawings: game.drawings.map(d => ({
          playerName: d.playerName,
          imageData: d.imageData,
          turnIndex: d.turnIndex,
        })),
        guess: game.guess,
        correct: game.guess?.text?.trim().toLowerCase() === game.topic?.trim().toLowerCase(),
      });
    }

    return json({ error: 'Not found' }, 404);
  }

  // プレイヤーごとに見せる情報を制御する
  _publicGame(game, playerId) {
    const playerIndex = game.players.findIndex(p => p.id === playerId);
    const isMyTurn = playerIndex === game.currentTurn;
    const isLastPlayer = playerIndex === game.players.length - 1;

    // 自分が描く番のときだけ、前の人の絵を渡す
    let prevDrawing = null;
    if (isMyTurn && game.drawings.length > 0) {
      prevDrawing = game.drawings[game.drawings.length - 1];
    }

    return {
      code: game.code,
      status: game.status,
      players: game.players.map(p => ({ name: p.name, isHost: p.isHost })),
      currentTurn: game.currentTurn,
      myTurn: isMyTurn,
      myIndex: playerIndex,
      isLastPlayer,
      prevDrawing: prevDrawing
        ? { playerName: prevDrawing.playerName, imageData: prevDrawing.imageData }
        : null,
      drawingCount: game.drawings.length,
    };
  }
}
