// Cloudflare Worker - お絵描き伝言ゲーム バックエンド
// Durable Objects を使ったゲームセッション管理

export { GameSession } from './gameSession.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // POST /api/create — 新しいゲームを作る
    if (path === '/api/create' && request.method === 'POST') {
      const body = await request.json();
      const { hostName, maxPlayers } = body;
      if (!hostName) return json({ error: 'hostName required' }, 400);

      const code = generateCode();
      const id = env.GAME_SESSIONS.idFromName(code);
      const stub = env.GAME_SESSIONS.get(id);

      const resp = await stub.fetch('https://internal/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, hostName, maxPlayers: maxPlayers || 8 }),
      });
      const data = await resp.json();
      return json(data);
    }

    // GET /api/join/:code — 参加情報を取得
    const joinMatch = path.match(/^\/api\/join\/([A-Z0-9]{6})$/);
    if (joinMatch && request.method === 'GET') {
      const code = joinMatch[1];
      const id = env.GAME_SESSIONS.idFromName(code);
      const stub = env.GAME_SESSIONS.get(id);
      const resp = await stub.fetch('https://internal/info');
      const data = await resp.json();
      return json(data);
    }

    // POST /api/join/:code — 参加者を追加
    if (joinMatch && request.method === 'POST') {
      const code = joinMatch[1];
      const body = await request.json();
      const id = env.GAME_SESSIONS.idFromName(code);
      const stub = env.GAME_SESSIONS.get(id);
      const resp = await stub.fetch('https://internal/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      return json(data, resp.status);
    }

    // POST /api/game/:code/start — ゲーム開始
    const startMatch = path.match(/^\/api\/game\/([A-Z0-9]{6})\/start$/);
    if (startMatch && request.method === 'POST') {
      const code = startMatch[1];
      const body = await request.json();
      const id = env.GAME_SESSIONS.idFromName(code);
      const stub = env.GAME_SESSIONS.get(id);
      const resp = await stub.fetch('https://internal/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      return json(data, resp.status);
    }

    // POST /api/game/:code/submit — 絵または答えを提出
    const submitMatch = path.match(/^\/api\/game\/([A-Z0-9]{6})\/submit$/);
    if (submitMatch && request.method === 'POST') {
      const code = submitMatch[1];
      const body = await request.json();
      const id = env.GAME_SESSIONS.idFromName(code);
      const stub = env.GAME_SESSIONS.get(id);
      const resp = await stub.fetch('https://internal/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      return json(data, resp.status);
    }

    // GET /api/game/:code/state — ゲーム状態取得（ポーリング用）
    const stateMatch = path.match(/^\/api\/game\/([A-Z0-9]{6})\/state$/);
    if (stateMatch && request.method === 'GET') {
      const code = stateMatch[1];
      const playerId = url.searchParams.get('playerId');
      const id = env.GAME_SESSIONS.idFromName(code);
      const stub = env.GAME_SESSIONS.get(id);
      const resp = await stub.fetch(`https://internal/state?playerId=${playerId || ''}`);
      const data = await resp.json();
      return json(data);
    }

    // GET /api/game/:code/result — 結果を取得
    const resultMatch = path.match(/^\/api\/game\/([A-Z0-9]{6})\/result$/);
    if (resultMatch && request.method === 'GET') {
      const code = resultMatch[1];
      const id = env.GAME_SESSIONS.idFromName(code);
      const stub = env.GAME_SESSIONS.get(id);
      const resp = await stub.fetch('https://internal/result');
      const data = await resp.json();
      return json(data);
    }

    return json({ error: 'Not found' }, 404);
  },
};
