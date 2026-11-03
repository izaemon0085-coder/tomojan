// ともじゃん：じゃんけん対戦の API と画面（public/）。外部パッケージなし
// 「ともはねでログイン」：ともはねが出した短い時間だけの通行証を、ともはねに確かめる。パスワードはここに置かない
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, HttpError, STAMPS, HANDS } from './game.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const COOKIE = 'tomojan_session';
export const TOMOHANE_URL = (process.env.TOMOHANE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const LINK_SECRET = process.env.LINK_SECRET || 'tomohane-dev-link-secret';

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
}
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};

export function createApp({ tomohaneUrl = TOMOHANE_URL, linkSecret = LINK_SECRET, fetchImpl = fetch, game: injected } = {}) {
  const sessions = new Map(); // トークン → gameId
  // 対戦が終わったら、勝ち数だけを ともはね に知らせる（つながらなくても、ゲームは止めない）
  const report = (p) => fetchImpl(`${tomohaneUrl}/api/link/game-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Link-Secret': linkSecret },
    body: JSON.stringify({ gameId: p.gameId, wins: p.wins, plays: p.plays }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  const game = injected ?? createGame({ onResult: report });

  const me = (req) => sessions.get(readCookie(req, COOKIE)) || null;
  const need = (req) => {
    const id = me(req);
    if (!id || !game.player(id)) throw new HttpError(401, 'ともはねでログインしてください');
    return id;
  };

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/config$/, () => ({ tomohaneUrl, stamps: STAMPS, hands: HANDS })],
    ['GET', /^\/api\/state$/, ({ req }) => game.view(me(req))],
    ['POST', /^\/api\/queue$/, ({ req }) => { game.join(need(req)); return game.view(me(req)); }],
    ['POST', /^\/api\/queue\/leave$/, ({ req }) => { game.leave(need(req)); return game.view(me(req)); }],
    ['POST', /^\/api\/match\/([\w-]+)\/pick$/, ({ req, params, body }) => { game.pick(need(req), params[0], body.hand); return game.view(me(req)); }],
    ['POST', /^\/api\/match\/([\w-]+)\/stamp$/, ({ req, params, body }) => { game.stamp(need(req), params[0], body.text); return { ok: true }; }],
    ['GET', /^\/api\/opinions$/, ({ req }) => ({ list: game.opinions(me(req)), summary: game.summary() })],
    ['POST', /^\/api\/opinions$/, ({ req, body }) => [201, game.addOpinion(need(req), body.text) && { ok: true }]],
    ['POST', /^\/api\/opinions\/([\w-]+)\/vote$/, ({ req, params }) => { game.vote(need(req), params[0]); return { ok: true }; }],
  ];

  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  // ともはね から通行証を持ってもどってきた
  async function callback(req, res, url) {
    const ticket = url.searchParams.get('ticket') || '';
    if (!/^[\w-]{16,64}$/.test(ticket)) throw new HttpError(400, '通行証がありません');
    let info;
    try {
      const r = await fetchImpl(`${tomohaneUrl}/api/link/game-ticket/${ticket}`, {
        headers: { 'X-Link-Secret': linkSecret }, signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) throw new Error();
      info = await r.json();
    } catch {
      throw new HttpError(401, '通行証を確かめられませんでした。ともはねからもう一度どうぞ');
    }
    const p = game.upsertPlayer(info);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, p.gameId);
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`,
      Location: '/',
    });
    res.end();
  }

  async function serveStatic(pathname, res) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'URL が正しくありません'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'Forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not Found');
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/auth/callback' && req.method === 'GET') return await callback(req, res, url);
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        sessions.delete(readCookie(req, COOKIE));
        res.writeHead(200, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, 'Content-Type': 'application/json' });
        return res.end('{"ok":true}');
      }
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && origin !== 'null') {
          let host = null;
          try { host = new URL(origin).host; } catch { /* noop */ }
          if (host !== req.headers.host) throw new HttpError(403, 'ほかのページからは操作できません');
        }
        for (const [method, pattern, fn] of routes) {
          const m = url.pathname.match(pattern);
          if (!m || method !== req.method) continue;
          const body = method === 'POST' ? await readJson(req) : {};
          const result = await fn({ req, params: m.slice(1), body });
          const [status, data] = Array.isArray(result) && typeof result[0] === 'number' ? result : [200, result];
          return sendJson(res, status, data);
        }
        throw new HttpError(404, 'API が見つかりません');
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: status === 500 ? 'サーバーエラーが発生しました' : err.message });
    }
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3300;
  if (!process.env.LINK_SECRET) console.warn('⚠️ LINK_SECRET が未設定です（開発用の値を使います）。本番では ともはね と同じ値を設定してください');
  http.createServer(createApp()).listen(port, () => console.log(`ともじゃん起動: http://localhost:${port}/`));
}
