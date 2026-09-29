'use strict';
/* calendar.js — 比赛日历 + 虚拟参赛与复盘 */

const $ = (id) => document.getElementById(id);
let activeSession = null, pollTimer = null;

async function init() {
  const s = await applyTheme();
  renderNav('比赛 · 虚拟赛');
  $('themeSel').addEventListener('change', async (e) => {
    await api('/settings', { method: 'POST', body: { theme: e.target.value } });
    document.documentElement.setAttribute('data-theme', e.target.value);
  });
  $('calPlat').addEventListener('change', loadCalendar);
  await Promise.all([loadCalendar(), loadRecommend(), loadHistory()]);
}

// ---------- 比赛日历 ----------
async function loadCalendar() {
  const pf = $('calPlat').value;
  const r = await api(`/contests?days=14&platform=${pf}`);
  const box = $('calBox');
  if (!r.length) { box.innerHTML = '<div class="muted small">暂无数据。</div>'; return; }
  const rows = r.filter((x) => !x.error);
  if (rows.length !== r.length) {
    box.innerHTML += '<div class="notice warn">部分平台赛程抓取失败，见下方错误。</div>';
  }
  box.innerHTML = `<table><thead><tr><th>平台</th><th>比赛</th><th>开始时间（本地）</th><th>计分区间</th><th>适合度</th><th></th></tr></thead><tbody>
    ${rows.map((c) => `<tr>
      <td>${PLATFORM[c.platform]?.short || c.platform}</td>
      <td><a href="${esc(c.url)}" target="_blank">${esc(c.name)}</a></td>
      <td class="small">${fmtTs(c.start)}</td>
      <td class="small muted">${esc(c.band || '-')}</td>
      <td><span class="badge ${c.suit === '正合适' ? 'ok' : c.suit === '偏难' ? 'warn' : c.suit === '偏简单' ? 'accent' : ''}">${esc(c.suit)}</span></td>
      <td class="small muted">${c.duration ? Math.round(c.duration / 3600) + 'h' : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;
  for (const e of r.filter((x) => x.error)) {
    box.innerHTML += `<div class="notice err">${PLATFORM[e.platform]?.name}：${esc(e.error)}</div>`;
  }
}

// ---------- 推荐场次 ----------
async function loadRecommend() {
  const r = await api('/virtual/recommend?limit=30');
  const box = $('vpRec');
  const list = r.filter((x) => !x.error);
  box.innerHTML = list.map((c) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:6px 0">
    <div>
      <div><a href="${esc(c.url)}" target="_blank">${esc(c.name)}</a> <span class="badge">${esc(c.band || '')}</span></div>
      <div class="small muted">${PLATFORM[c.platform]?.name} · ${fmtTs(c.start)} · ${esc(c.suit)}</div>
    </div>
    <button class="btn sm primary" data-start="${c.platform}:${c.id}">开始 VP</button>
  </div>`).join('') || '<div class="muted small">没有可推荐的已结束场次。</div>';
  for (const e of r.filter((x) => x.error)) box.innerHTML += `<div class="notice err">${esc(e.error)}</div>`;

  box.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', async () => {
    const [platform, contest_id] = b.dataset.start.split(':');
    const countdown = parseInt(prompt('赛前倒计时秒数（可 0，输入后点确定立即开始倒计时）：', '300') || '0', 10);
    if (countdown < 0) return;
    b.disabled = true;
    try {
      const s = await api('/virtual/start', { method: 'POST', body: { platform, contest_id, countdown } });
      activeSession = s;
      renderActive();
      flash('虚拟赛已创建，倒计时开始');
      await loadHistory();
    } catch (e) {
      flash(e.message, 'err');
      b.disabled = false;
    }
  }));
}

// ---------- 当前会话 ----------
function renderActive() {
  const box = $('vpActive');
  if (!activeSession) {
    box.innerHTML = '<div class="muted small">没有进行中的会话。从左侧选择一场开始。</div>';
    return;
  }
  const s = activeSession;
  const t = s.timing || {};
  const st = s.status;

  const problems = (s.contest && s.contest.problems) || [];
  const review = s.review || null;

  let timerHtml;
  if (st === 'countdown') {
    timerHtml = `<div class="timer">${fmtCountdown(t.remaining)} <small>倒计时</small></div>`;
  } else if (st === 'running' || st === 'paused') {
    timerHtml = `<div class="timer">${fmtCountdown(t.elapsed)} <small>${st === 'paused' ? '已暂停' : '进行中'}</small></div>`;
  } else {
    timerHtml = `<div class="timer">${fmtCountdown(t.elapsed)} <small>已结束</small></div>`;
  }

  const statusPill = `<span class="pill ${st}">${st === 'countdown' ? '倒计时' : st === 'running' ? '进行中' : st === 'paused' ? '已暂停' : '已结束'}</span>`;

  const controls = st !== 'finished' ? `
    <div class="row">
      ${st === 'countdown' ? `<button class="btn primary" id="vpNow">立即开始</button>` : ''}
      ${st === 'running' || st === 'countdown' ? `<button class="btn" id="vpPause">${st === 'paused' ? '继续' : '暂停'}</button>` : ''}
      ${st === 'paused' ? `<button class="btn" id="vpResume">继续</button>` : ''}
      <button class="btn danger" id="vpFinish">结束并复盘</button>
      ${st === 'finished' ? `<button class="btn primary" id="vpExport">导出复盘 ZIP</button>` : ''}
    </div>` : `<div class="row"><button class="btn primary" id="vpExport">导出复盘 ZIP</button>
    <span class="muted small">已解出 ${review ? review.solved : '-'} 题 · 加权分 ${review ? review.weighted : '-'}</span></div>`;

  const problemRows = problems.map((p) => {
    const n = (s.problem_notes || {})[p.pid] || {};
    const rev = review && review.problems.find((x) => x.pid === p.pid);
    const st2 = rev ? (rev.ac ? `<span class="badge ok">AC ${fmtDur(rev.first_ac_sec)}</span>` : rev.attempts ? `<span class="badge danger">${rev.attempts} 次未过</span>` : '<span class="badge">未提交</span>') : '';
    return `<div style="border-bottom:1px solid var(--border);padding:8px 0">
      <div class="row" style="justify-content:space-between">
        <div><a href="${esc(p.url || '#')}" target="_blank"><b>${esc(p.index || p.pid)}</b> ${esc(p.title || p.name)}</a>
          <span class="tag">${ratingLabel(s.platform, p.rating)}</span> ${st2}</div>
        <div class="row">
          <input type="file" class="vp-code" data-pid="${esc(p.pid)}" style="max-width:150px;font-size:12px" title="绑定本地代码">
          <button class="btn sm" data-codenote="${esc(p.pid)}">存代码</button>
        </div>
      </div>
      <textarea class="vp-note" data-pid="${esc(p.pid)}" rows="2" placeholder="单题思路 / 卡点笔记（自动保存）">${esc(n.note || '')}</textarea>
      ${n.filename ? `<div class="small muted">已绑定代码：${esc(n.filename)}</div>` : ''}
    </div>`;
  }).join('');

  box.innerHTML = `
    <div style="text-align:center">
      <div class="small muted">${esc(s.name)} · ${PLATFORM[s.platform]?.name}</div>
      ${statusPill} ${timerHtml}
    </div>
    ${controls}
    <div class="mt">
      <textarea id="vpWholeNotes" rows="3" placeholder="整场笔记（Markdown 支持）">${esc(s.notes || '')}</textarea>
      <div class="muted small">整场笔记在导出复盘包时写入 01-CONTEST.md。</div>
    </div>
    <div class="mt">${problemRows || '<div class="muted small">该场比赛题目列表暂不可获取。</div>'}</div>`;

  // 事件绑定
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  bind('vpNow', async () => {
    // 倒计时归零视为运行开始（无需后端切换）
    activeSession = { ...activeSession, status: 'running' };
    renderActive();
  });
  bind('vpPause', async () => {
    const s2 = await api('/virtual/pause', { method: 'POST', body: { session: activeSession.id, pause: true } });
    activeSession = { ...s2, timing: s2.timing };
    renderActive();
  });
  bind('vpResume', async () => {
    const s2 = await api('/virtual/pause', { method: 'POST', body: { session: activeSession.id, pause: false } });
    activeSession = { ...s2, timing: s2.timing };
    renderActive();
  });
  bind('vpFinish', async () => {
    if (!confirm('确定结束本场虚拟赛并生成复盘？')) return;
    try {
      const s2 = await api('/virtual/finish', { method: 'POST', body: { session: activeSession.id } });
      activeSession = { ...s2, review: s2.review };
      renderActive();
      await loadHistory();
      flash('复盘已生成');
    } catch (e) { flash(e.message, 'err'); }
  });
  bind('vpExport', async () => {
    const blob = await api(`/virtual/export?session=${activeSession.id}`, { blob: true });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `review-session-${activeSession.id}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  const whole = $('vpWholeNotes');
  if (whole) whole.addEventListener('change', async () => {
    await api('/virtual/notes', { method: 'POST', body: { session: activeSession.id, notes: whole.value } });
  });

  box.querySelectorAll('.vp-note').forEach((ta) => {
    ta.addEventListener('change', async () => {
      await api('/virtual/problemnote', { method: 'POST', body: { session: activeSession.id, pid: ta.dataset.pid, note: ta.value } });
      flash('笔记已保存');
    });
  });
  box.querySelectorAll('[data-codenote]').forEach((btn) => btn.addEventListener('click', async () => {
    const pid = btn.dataset.codenote;
    const fileInput = box.querySelector(`.vp-code[data-pid="${pid}"]`);
    if (!fileInput || !fileInput.files || !fileInput.files[0]) { flash('先选择要绑定的代码文件', 'warn'); return; }
    const f = fileInput.files[0];
    const code = await f.text();
    await api('/virtual/problemnote', { method: 'POST', body: { session: activeSession.id, pid, code, filename: f.name } });
    flash(`已绑定 ${f.name}`);
    renderActive();
  }));
}

function fmtCountdown(sec) {
  if (sec == null) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

// ---------- 历史会话 ----------
async function loadHistory() {
  const list = await api('/virtual/list');
  const box = $('vpHistory');
  box.innerHTML = list.map((s) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:6px 0">
    <div>
      <div><b>${esc(s.name)}</b> <span class="badge">${PLATFORM[s.platform]?.short} ${s.contest_id}</span></div>
      <div class="small muted">${s.status === 'finished' ? `已结束 · 解出 ${(s.contest && s.contest._review) ? s.contest._review.solved : '-'} 题` : s.status}</div>
    </div>
    <div class="row">
      <button class="btn sm" data-view="${s.id}">查看</button>
      <button class="btn sm" data-export="${s.id}">导出</button>
    </div>
  </div>`).join('') || '<div class="muted small">暂无历史会话。</div>';

  box.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
    const s = await api(`/virtual?session=${b.dataset.view}`);
    activeSession = s;
    renderActive();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  box.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', async () => {
    const blob = await api(`/virtual/export?session=${b.dataset.export}`, { blob: true });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `review-session-${b.dataset.export}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }));
}

// ---------- 倒计时本地跳动 + 定期同步 ----------
let localTimer = null;
function tickTimer() {
  if (!activeSession || activeSession.status === 'finished') return;
  const t = activeSession.timing || {};
  if (activeSession.status === 'countdown' && t.remaining != null) {
    t.remaining = Math.max(0, t.remaining - 1);
    // 只更新数字，不重渲染整个页面
    const el = document.querySelector('.timer');
    if (el) el.innerHTML = fmtCountdown(t.remaining) + ' <small>倒计时</small>';
    if (t.remaining <= 0) {
      activeSession = { ...activeSession, status: 'running' };
      renderActive();
      startPollSync();
    }
  } else if ((activeSession.status === 'running' || activeSession.status === 'paused') && t.elapsed != null) {
    if (activeSession.status === 'running') t.elapsed++;
    const el = document.querySelector('.timer');
    if (el) el.innerHTML = fmtCountdown(t.elapsed) + ' <small>' + (activeSession.status === 'paused' ? '已暂停' : '进行中') + '</small>';
  }
}
function startPollSync() {
  if (localTimer) clearInterval(localTimer);
  localTimer = setInterval(tickTimer, 1000);
}
async function pollActive() {
  if (!activeSession || activeSession.status === 'finished') return;
  const s = await api(`/virtual?session=${activeSession.id}`, { silent: true }).catch(() => null);
  if (s) {
    const prevStatus = activeSession.status;
    activeSession = s;
    if (prevStatus === 'countdown' && s.timing && s.timing.remaining <= 0) {
      activeSession = { ...s, status: 'running' };
    }
    renderActive();
    startPollSync();
  }
}
setInterval(pollActive, 15000);

init();
