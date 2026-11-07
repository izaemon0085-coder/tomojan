import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { createGame, judge, levelOf, WAIT_BOT_MS, WAIT_SAME_LEVEL_MS, DAILY_LIMIT, BEGINNER_PLAYS } from '../game.js';

// ---- ルールと仕分け（ゲームの頭脳だけ） ----
test('じゃんけんの勝ち負け', () => {
  assert.equal(judge('rock', 'scissors'), 1);
  assert.equal(judge('scissors', 'rock'), -1);
  assert.equal(judge('paper', 'paper'), 0);
});

function setup() {
  let t = 0;
  const results = [];
  const g = createGame({ now: () => t, random: () => 0, onResult: (p) => results.push({ ...p }) }); // シバはいつもグー
  const add = (id, ageGroup, plays = 10, wins = 5) => {
    g.upsertPlayer({ gameId: id, name: id, ageGroup });
    Object.assign(g.player(id), { plays, wins });
  };
  return { g, add, results, tick: (ms) => { t += ms; g.tick(); } };
}

test('はじめての3回は、シバが相手（パーを出せば勝てる）', () => {
  const { g, results } = setup();
  g.upsertPlayer({ gameId: 'new', name: 'しんじん', ageGroup: 'adult' });
  g.join('new');
  let v = g.view('new');
  assert.equal(v.match.opponent.bot, true);
  assert.match(v.match.reason, /はじめての3回/);
  g.pick('new', v.match.id, 'paper');
  g.pick('new', v.match.id, 'paper');
  v = g.view('new');
  assert.equal(v.match.result, 'win');
  assert.equal(results.at(-1).wins, 1, '終わったら勝ち数を ともはね に知らせる');
  assert.equal(BEGINNER_PLAYS, 3);
});

test('仕分け：年齢の区分がちがう人とは、どんなに待っても組まない。うでまえが近い人を先に組む', () => {
  const { g, add, tick } = setup();
  add('kid', 'child');
  add('adult1', 'adult', 10, 8); // つよい
  add('adult2', 'adult', 10, 5); // ふつう
  add('adult3', 'adult', 10, 7); // つよい
  g.join('kid');
  g.join('adult2');
  assert.equal(g.view('kid').match, null, '子どもと大人は組まない');
  g.join('adult1');
  assert.equal(g.view('adult1').match, null, 'うでまえがちがうので、すぐには組まない');
  g.join('adult3');
  const m = g.view('adult3').match;
  assert.equal(m.opponent.name, 'adult1');
  assert.match(m.reason, /年齢の区分が同じ（大人）で、うでまえが近い（つよい）/);

  tick(WAIT_SAME_LEVEL_MS);
  assert.equal(g.view('kid').match, null, '15秒待っても、子どもは子どもとだけ');
  tick(WAIT_BOT_MS);
  assert.equal(g.view('kid').match.opponent.bot, true, '30秒たったらシバが相手');
  assert.equal(g.view('adult2').match.opponent.bot, true);
});

test('1日に遊べるのは、大人も子どもも21回まで', () => {
  const { g, add } = setup();
  assert.equal(DAILY_LIMIT, 21);
  const day = new Date(0).toISOString().slice(0, 10);
  for (const [id, age] of [['kid2', 'child'], ['teen2', 'teen'], ['adult3', 'adult']]) {
    add(id, age);
    Object.assign(g.player(id), { todayPlays: DAILY_LIMIT - 1, day });
    assert.doesNotThrow(() => g.join(id), `${age}：20回目までは遊べる`);
    g.leave?.(id);
    Object.assign(g.player(id), { todayPlays: DAILY_LIMIT, day });
    assert.throws(() => g.join(id), /また明日/, `${age}：21回でおしまい`);
  }
});

test('うでまえの区分', () => {
  assert.equal(levelOf({ plays: 3, wins: 3 }), 'まだまだ');
  assert.equal(levelOf({ plays: 10, wins: 7 }), 'つよい');
  assert.equal(levelOf({ plays: 10, wins: 2 }), 'のびしろ');
});

test('みんなの声：意見・いいね・ヤマネコのまとめ。電話番号は書けない', () => {
  const { g, add } = setup();
  add('a', 'adult');
  add('b', 'teen');
  const o = g.addOpinion('a', '推しのクイズで対戦したい');
  g.vote('b', o.id);
  g.addOpinion('b', 'しりとりがいい');
  assert.equal(g.opinions('b')[0].votes, 2);
  assert.deepEqual(g.summary()[0], { label: 'クイズ', count: 2 });
  assert.throws(() => g.addOpinion('a', '090-1234-5678 に連絡して'), /電話番号/);
});

// ---- ともはねでログイン（ともはねの代わりを使う） ----
let server;
let base;
const tickets = new Map([['good-ticket-1234567890', { gameId: 'g_abc', name: 'さいとう', ageGroup: 'adult' }]]);
const reported = [];
const fakeTomohane = async (url, opts = {}) => {
  const u = new URL(url);
  if (opts.headers?.['X-Link-Secret'] !== 'test-secret') return { ok: false, json: async () => ({}) };
  if (u.pathname.startsWith('/api/link/game-ticket/')) {
    const info = tickets.get(u.pathname.split('/').pop());
    tickets.delete(u.pathname.split('/').pop());
    return { ok: Boolean(info), json: async () => info };
  }
  if (u.pathname === '/api/link/game-results') {
    reported.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({}) };
  }
  return { ok: false, json: async () => ({}) };
};

before(async () => {
  server = http.createServer(createApp({ tomohaneUrl: 'http://tomohane.test', linkSecret: 'test-secret', fetchImpl: fakeTomohane }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('ともはねでログイン → シバと対戦 → 勝ち数が ともはね にとどく', async () => {
  assert.equal((await fetch(`${base}/auth/callback?ticket=bad-ticket-000000000`, { redirect: 'manual' })).status, 401);
  const cb = await fetch(`${base}/auth/callback?ticket=good-ticket-1234567890`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const cookie = cb.headers.get('set-cookie').split(';')[0];
  assert.match(cb.headers.get('set-cookie'), /HttpOnly/);
  const call = async (path, body) => (await fetch(base + path, {
    method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })).json();

  let v = await call('/api/state');
  assert.equal(v.me.name, 'さいとう');
  v = await call('/api/queue', {});
  assert.equal(v.match.opponent.bot, true);
  for (let i = 0; i < 9 && v.match.status === 'playing'; i++) v = await call(`/api/match/${v.match.id}/pick`, { hand: 'paper' });
  assert.equal(v.match.status, 'done');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reported.at(-1).gameId, 'g_abc');
  assert.equal(reported.at(-1).plays, 1);

  const stamp = await fetch(`${base}/api/match/${v.match.id}/stamp`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '自由な言葉' }) });
  assert.equal(stamp.status, 400, 'チャットは決まった言葉だけ');
  assert.equal((await fetch(`${base}/api/queue`, { method: 'POST' })).status, 401, 'ログインしていないと遊べない');
});
