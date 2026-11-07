// ともじゃんの頭脳：じゃんけん対戦・キャラの仕分け（組み合わせ）・みんなの声（次のゲームの意見）
// データはメモリの中だけ（β版）。勝ち数は、対戦が終わるたびに ともはね に知らせる
import { randomInt, randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newId = (p) => `${p}_${randomUUID().slice(0, 8)}`;
export const HANDS = { rock: 'グー', scissors: 'チョキ', paper: 'パー' };
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
export const STAMPS = ['よろしく！', 'ナイス！', 'ありがとう', 'またね！']; // チャットは決まった言葉だけ
export const BEGINNER_PLAYS = 3; // はじめての3回はシバが相手
export const WAIT_SAME_LEVEL_MS = 15000; // これより待ったら、うでまえがちがっても組む（年齢の区分は必ず同じ）
export const WAIT_BOT_MS = 30000; // これより待ったら、シバが相手
export const DAILY_LIMIT = 21; // 1日の対戦回数。大人も子どもも同じ（球技の21点にちなむ。2026-11-06 決定）
const WIN_TO = 2; // 3本勝負（2本先取）
const MAX_ROUNDS = 9;
const AGE = { child: '子ども', teen: '中高生', adult: '大人' };

export const BOT = { gameId: 'bot-shiba', name: 'シバ', ageGroup: null, bot: true };

// うでまえ：はじめは「まだまだ」。10回遊んだら勝率で分ける
export function levelOf(p) {
  if (p.plays < 10) return 'まだまだ';
  const rate = p.wins / p.plays;
  return rate >= 0.6 ? 'つよい' : rate <= 0.35 ? 'のびしろ' : 'ふつう';
}

export function judge(a, b) {
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}

export function createGame({ now = () => Date.now(), random = (n) => randomInt(n), onResult = () => {} } = {}) {
  const players = new Map(); // gameId → 遊ぶ人
  const queue = []; // { gameId, since }
  const matches = new Map();
  const opinions = [];

  const today = () => new Date(now()).toISOString().slice(0, 10);
  const requirePlayer = (id) => {
    const p = players.get(id);
    if (!p) throw new HttpError(401, 'ともはねでログインしてください');
    return p;
  };
  const currentMatch = (id) => [...matches.values()].find((m) => m.status === 'playing' && (m.a === id || m.b === id)) || null;

  function startMatch(aId, bId, reason) {
    const m = {
      id: newId('m'), a: aId, b: bId, picks: {}, score: { [aId]: 0, [bId]: 0 }, rounds: [],
      stamps: [], status: 'playing', winner: null, reason, createdAt: now(),
    };
    matches.set(m.id, m);
    for (const id of [aId, bId]) {
      const i = queue.findIndex((q) => q.gameId === id);
      if (i !== -1) queue.splice(i, 1);
    }
    if (bId === BOT.gameId) m.picks[BOT.gameId] = Object.keys(HANDS)[random(3)];
    return m;
  }

  // 🐱🦉🐕 キャラの仕分け：年齢の区分は必ず同じ。うでまえが近い人を先に。待ちすぎたらシバが相手
  function matchmake() {
    const t = now();
    for (const q of [...queue]) {
      if (!queue.includes(q)) continue; // もう組まれた
      const me = players.get(q.gameId);
      const waited = t - q.since;
      const others = queue.filter((o) => o !== q && players.get(o.gameId).ageGroup === me.ageGroup);
      const sameLevel = others.find((o) => levelOf(players.get(o.gameId)) === levelOf(me));
      const pick = sameLevel || (waited >= WAIT_SAME_LEVEL_MS ? others[0] : null);
      if (pick) {
        const other = players.get(pick.gameId);
        const lv = levelOf(me) === levelOf(other) ? `うでまえが近い（${levelOf(me)}）` : 'うでまえは少しちがうけど、待ち時間が長かった';
        startMatch(pick.gameId, q.gameId, `🐱 ヤマネコ：年齢の区分が同じ（${AGE[me.ageGroup]}）で、${lv}人と組んだ。`);
      } else if (waited >= WAIT_BOT_MS) {
        startMatch(q.gameId, BOT.gameId, '🐕 シバ：同じ区分の人が見つからなかったっす。オレが相手するっす！');
      }
    }
  }

  function finish(m) {
    m.status = 'done';
    const [a, b] = [m.a, m.b];
    m.winner = m.score[a] > m.score[b] ? a : m.score[b] > m.score[a] ? b : null;
    for (const id of [a, b]) {
      const p = players.get(id);
      if (!p) continue; // シバ
      p.plays += 1;
      if (m.winner === id) p.wins += 1;
      else if (m.winner) p.losses += 1;
      else p.draws += 1;
      if (p.day !== today()) { p.day = today(); p.todayPlays = 0; }
      p.todayPlays += 1;
      onResult(p);
    }
  }

  return {
    // ともはねでログインした人を登録（なければ作る）。ともはねから来た名前と年齢の区分で毎回上書き
    upsertPlayer({ gameId, name, ageGroup }) {
      if (!gameId || !name || !AGE[ageGroup]) throw new HttpError(400, 'ともはねからの情報が足りません');
      const p = players.get(gameId) ?? { gameId, plays: 0, wins: 0, losses: 0, draws: 0, day: today(), todayPlays: 0 };
      Object.assign(p, { name, ageGroup });
      players.set(gameId, p);
      return p;
    },
    player: (id) => players.get(id) || null,

    join(gameId) {
      const p = requirePlayer(gameId);
      if (currentMatch(gameId)) return;
      if (p.day !== today()) { p.day = today(); p.todayPlays = 0; }
      if (p.todayPlays >= DAILY_LIMIT) {
        throw new HttpError(429, `きょうはもう${DAILY_LIMIT}回遊んだっす！ また明日あそぶっす（シバ）`);
      }
      if (p.plays < BEGINNER_PLAYS) {
        startMatch(gameId, BOT.gameId, `🐕 シバ：はじめての${BEGINNER_PLAYS}回は、オレが相手するっす！ ルールに慣れてほしいっす。`);
        return;
      }
      if (!queue.some((q) => q.gameId === gameId)) queue.push({ gameId, since: now() });
      matchmake();
    },
    leave(gameId) {
      const i = queue.findIndex((q) => q.gameId === gameId);
      if (i !== -1) queue.splice(i, 1);
    },
    tick: matchmake,

    pick(gameId, matchId, hand) {
      const m = matches.get(matchId);
      if (!m || (m.a !== gameId && m.b !== gameId)) throw new HttpError(404, '対戦が見つかりません');
      if (m.status !== 'playing') throw new HttpError(409, 'この対戦は終わっています');
      if (!HANDS[hand]) throw new HttpError(400, 'グー・チョキ・パーから選んでね');
      if (m.picks[gameId]) throw new HttpError(409, 'もう出しています');
      m.picks[gameId] = hand;
      const [a, b] = [m.a, m.b];
      if (m.picks[a] && m.picks[b]) {
        const r = judge(m.picks[a], m.picks[b]);
        const winner = r === 1 ? a : r === -1 ? b : null;
        if (winner) m.score[winner] += 1;
        m.rounds.push({ [a]: m.picks[a], [b]: m.picks[b], winner });
        m.picks = {};
        if (m.score[a] >= WIN_TO || m.score[b] >= WIN_TO || m.rounds.length >= MAX_ROUNDS) finish(m);
        else if (b === BOT.gameId) m.picks[BOT.gameId] = Object.keys(HANDS)[random(3)];
      }
      return m;
    },
    stamp(gameId, matchId, text) {
      const m = matches.get(matchId);
      if (!m || (m.a !== gameId && m.b !== gameId)) throw new HttpError(404, '対戦が見つかりません');
      if (!STAMPS.includes(text)) throw new HttpError(400, '決まった言葉だけ送れます');
      m.stamps.push({ from: gameId, text, at: now() });
      if (m.stamps.length > 20) m.stamps.shift();
    },

    // 画面に出す形（相手がまだ出していない手は見せない）
    view(gameId) {
      matchmake();
      const me = players.get(gameId) || null;
      if (!me) return { me: null };
      const nameOf = (id) => (id === BOT.gameId ? BOT.name : players.get(id)?.name ?? '?');
      const m = currentMatch(gameId) || [...matches.values()].filter((x) => x.a === gameId || x.b === gameId).at(-1) || null;
      let match = null;
      if (m) {
        const opp = m.a === gameId ? m.b : m.a;
        match = {
          id: m.id, status: m.status, reason: m.reason,
          opponent: { name: nameOf(opp), bot: opp === BOT.gameId },
          myScore: m.score[gameId], oppScore: m.score[opp],
          waitingForMe: m.status === 'playing' && !m.picks[gameId],
          rounds: m.rounds.map((r) => ({ me: HANDS[r[gameId]], opp: HANDS[r[opp]], result: r.winner === gameId ? 'win' : r.winner ? 'lose' : 'draw' })),
          result: m.status === 'done' ? (m.winner === gameId ? 'win' : m.winner ? 'lose' : 'draw') : null,
          stamps: m.stamps.map((s) => ({ from: s.from === gameId ? 'わたし' : nameOf(s.from), text: s.text })),
        };
      }
      const q = queue.find((x) => x.gameId === gameId);
      return {
        me: { name: me.name, ageGroup: AGE[me.ageGroup], level: levelOf(me), plays: me.plays, wins: me.wins, losses: me.losses, draws: me.draws,
          todayLeft: DAILY_LIMIT - (me.day === today() ? me.todayPlays : 0) },
        waiting: q ? Math.floor((now() - q.since) / 1000) : null,
        match: match && (match.status === 'playing' || !q) ? match : null,
      };
    },

    // ---- みんなの声：次にほしいゲームの意見 ----
    addOpinion(gameId, text) {
      const p = requirePlayer(gameId);
      const clean = String(text ?? '').trim();
      if (!clean || [...clean].length > 200) throw new HttpError(400, '意見は1〜200文字で書いてね');
      if (/0\d{1,4}[-ー－−\s]?\d{1,4}[-ー－−\s]?\d{3,4}|\S+@\S+\.\S+|〒/.test(clean)) {
        throw new HttpError(400, '電話番号やメールアドレスは書けません（フクロウ）');
      }
      if (opinions.filter((o) => o.gameId === gameId && o.createdAt > now() - 86400000).length >= 5) {
        throw new HttpError(429, '意見は1日5つまでです');
      }
      const o = { id: newId('o'), gameId, name: p.name, text: clean, votes: new Set([gameId]), createdAt: now() };
      opinions.push(o);
      return o;
    },
    vote(gameId, opinionId) {
      requirePlayer(gameId);
      const o = opinions.find((x) => x.id === opinionId);
      if (!o) throw new HttpError(404, '意見が見つかりません');
      if (o.votes.has(gameId)) o.votes.delete(gameId);
      else o.votes.add(gameId);
    },
    opinions(gameId) {
      return opinions
        .map((o) => ({ id: o.id, name: o.name, text: o.text, votes: o.votes.size, voted: o.votes.has(gameId), createdAt: o.createdAt }))
        .sort((a, b) => b.votes - a.votes || b.createdAt - a.createdAt);
    },
    // 🐱 ヤマネコのまとめ：意見に多い言葉（ゲームの種類）を数える
    summary() {
      const KINDS = [['クイズ', /クイズ|問題/], ['しりとり・言葉', /しりとり|言葉|ことば/], ['音楽・リズム', /音楽|リズム|歌/], ['パズル', /パズル/], ['すごろく・ボード', /すごろく|オセロ|将棋|ボード/], ['謎解き', /謎|なぞ/]];
      return KINDS.map(([label, re]) => ({ label, count: opinions.filter((o) => re.test(o.text)).reduce((n, o) => n + o.votes.size, 0) }))
        .filter((k) => k.count > 0).sort((a, b) => b.count - a.count);
    },
  };
}
