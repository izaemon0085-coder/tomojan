// じゃんけんの画面。対戦中は1秒ごとに、ふだんは5秒ごとに、サーバーのようすを見に行く
const $ = (sel) => document.querySelector(sel);
let config = null;
let state = null;
let timer = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ともはねのアドレス。このパソコン（localhost）のアドレスのとき、スマホからも届くように、いま開いているアドレスに合わせる
function tomohaneUrl(path) {
  const u = new URL(path, config.tomohaneUrl);
  if (['localhost', '127.0.0.1'].includes(u.hostname) && !['localhost', '127.0.0.1'].includes(location.hostname)) u.hostname = location.hostname;
  return u.href;
}

const RESULT = { win: '勝ち！', lose: '負け…', draw: 'あいこ' };
const MATCH_SAY = {
  win: '🐕 シバ：勝ったっす！ すごいっす！ 勝ち数が ともはね にとどいたっす！',
  lose: '🐕 シバ：おしかったっす…！ 次はきっと勝てるっす！',
  draw: '🐕 シバ：引き分けっす！ いい勝負だったっす！',
};

function render() {
  const s = state;
  $('#signin').hidden = Boolean(s.me);
  $('#app').hidden = !s.me;
  if (!s.me) return;
  $('#me-name').textContent = s.me.name;
  $('#me-age').textContent = s.me.ageGroup;
  $('#me-level').textContent = `うでまえ：${s.me.level}`;
  $('#me-stats').textContent = `${s.me.plays}回 あそんで ${s.me.wins}勝 ${s.me.losses}敗 ${s.me.draws}分け${s.me.todayLeft != null ? `（きょうはあと ${s.me.todayLeft} 回）` : ''}`;

  const m = s.match;
  const playing = m?.status === 'playing';
  $('#lobby').hidden = s.waiting != null || playing;
  $('#waiting').hidden = s.waiting == null;
  $('#wait-sec').textContent = s.waiting ?? 0;
  $('#match').hidden = !m;
  if (!m) return;
  $('#reason').textContent = m.reason;
  $('#opp-name').textContent = m.opponent.bot ? '🐕 シバ' : m.opponent.name;
  $('#my-score').textContent = m.myScore;
  $('#opp-score').textContent = m.oppScore;
  const last = m.rounds.at(-1);
  const status = $('#status');
  status.className = 'status';
  if (m.result) {
    status.textContent = m.result === 'win' ? '🎉 あなたの勝ち！' : m.result === 'lose' ? 'あなたの負け…' : '引き分け';
    status.classList.add(m.result === 'draw' ? 'draw' : m.result);
  } else if (m.waitingForMe) {
    status.textContent = last ? `${last.me} と ${last.opp}：${RESULT[last.result]}　次の手を出してね` : 'じゃん けん…！ 手を出してね';
  } else {
    status.textContent = `${m.opponent.bot ? 'シバ' : m.opponent.name} さんが考えています…`;
  }
  for (const b of document.querySelectorAll('.hand')) b.disabled = !m.waitingForMe;
  $('#rounds').innerHTML = m.rounds.map((r) => `<li class="${r.result}">わたし ${r.me} ／ あいて ${r.opp} → ${RESULT[r.result]}</li>`).join('');
  $('#stamp-log').innerHTML = m.stamps.slice(-4).map((st) => `<li>${esc(st.from)}：${esc(st.text)}</li>`).join('');
  $('#again').hidden = !m.result;
  if (m.result) $('#lobby-say').textContent = MATCH_SAY[m.result].replace('🐕 シバ：', '');
}

async function refresh() {
  try {
    state = await api('/state');
    render();
  } catch (err) {
    $('#error').textContent = err.message;
  }
  clearTimeout(timer);
  const busy = state?.waiting != null || state?.match?.status === 'playing';
  timer = setTimeout(refresh, busy ? 1000 : 5000);
}

async function act(fn) {
  $('#error').textContent = '';
  try {
    state = await fn();
    render();
  } catch (err) {
    $('#error').textContent = err.message;
  }
  refresh();
}

$('#find').addEventListener('click', () => act(() => api('/queue', { method: 'POST' })));
$('#again').addEventListener('click', () => act(() => api('/queue', { method: 'POST' })));
$('#cancel').addEventListener('click', () => act(() => api('/queue/leave', { method: 'POST' })));
$('#hands').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hand]');
  if (b && state?.match) act(() => api(`/match/${state.match.id}/pick`, { method: 'POST', body: { hand: b.dataset.hand } }));
});
$('#stamps').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-stamp]');
  if (!b || !state?.match) return;
  try {
    await api(`/match/${state.match.id}/stamp`, { method: 'POST', body: { text: b.dataset.stamp } });
  } catch { /* noop */ }
  refresh();
});

// ---- みんなの声 ----
async function loadOpinions() {
  try {
    const { list, summary } = await api('/opinions');
    $('#opinions').innerHTML = list.length
      ? list.map((o) => `<li><p>${esc(o.text)} <span class="muted small">${esc(o.name)}</span></p>
          <button type="button" class="vote" data-vote="${o.id}" aria-pressed="${o.voted}" aria-label="いいね ${o.votes}">♡ ${o.votes}</button></li>`).join('')
      : '<li class="muted small">まだ意見はありません。最初の意見をどうぞ！</li>';
    $('#summary-say').hidden = !summary.length;
    if (summary.length) {
      $('#summary').textContent = `いまの声をまとめると、${summary.slice(0, 3).map((k) => `「${k.label}」（${k.count}）`).join('、')}が多い。会議室で次のゲームを相談しよう。`;
    }
  } catch { /* noop */ }
}
$('#opinion-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#opinion-error').textContent = '';
  try {
    await api('/opinions', { method: 'POST', body: { text: $('#opinion').value } });
    $('#opinion').value = '';
    loadOpinions();
  } catch (err) {
    $('#opinion-error').textContent = err.message;
  }
});
$('#opinions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-vote]');
  if (!b) return;
  try { await api(`/opinions/${b.dataset.vote}/vote`, { method: 'POST' }); } catch { /* noop */ }
  loadOpinions();
});

config = await api('/config');
$('#stamps').innerHTML = config.stamps.map((s) => `<button type="button" data-stamp="${esc(s)}">${esc(s)}</button>`).join('');
$('#signin-link').href = tomohaneUrl('/api/link/game-start');
$('#back-tomohane').href = tomohaneUrl('/');
await refresh();
loadOpinions();
