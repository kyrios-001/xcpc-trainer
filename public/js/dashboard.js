'use strict';
/* dashboard.js — 总览页：统计、活动砖、Rating 曲线、难度足迹、近期 AC、数据源状态 */

const $ = (id) => document.getElementById(id);
let actCache = null;

async function init() {
  const s = await applyTheme();
  renderNav('总览');
  $('themeSel').addEventListener('change', async (e) => {
    await api('/settings', { method: 'POST', body: { theme: e.target.value } });
    document.documentElement.setAttribute('data-theme', e.target.value);
  });

  $('btnSyncAll').addEventListener('click', async () => {
    const platforms = (await api('/settings')).platforms;
    for (const [pf, users] of Object.entries(platforms)) {
      for (const u of users) {
        $('syncHint').textContent = `正在同步 ${pf}/${u.handle} ...`;
        await api('/sync', { method: 'POST', body: { platform: pf, handle: u.handle } });
      }
    }
    $('syncHint').textContent = '同步完成';
    await loadAll();
    setTimeout(() => { $('syncHint').textContent = ''; }, 4000);
  });

  $('actRange').addEventListener('change', loadActivity);
  $('actMode').addEventListener('change', loadActivity);
  $('btnExportPng').addEventListener('click', exportHeatPng);
  $('ratingPlat').addEventListener('change', loadRating);
  $('diffPlat').addEventListener('change', loadDifficulty);

  await loadAll();
  await loadToday();
  pollStatus();
  // 打开页面后后台静默同步（不打断用户）
  setTimeout(() => {
    api('/settings', { silent: true }).then(async (settings) => {
      const platforms = settings.platforms;
      for (const [pf, users] of Object.entries(platforms)) {
        for (const u of users) {
          try { await api('/sync', { method: 'POST', body: { platform: pf, handle: u.handle }, silent: true }); } catch {}
        }
      }
    }).catch(() => {});
  }, 1500);
}

async function loadAll() {
  // 各模块独立加载：单个模块失败不影响其他模块渲染（避免一处报错整页白屏）
  const modules = [
    ['统计', loadStats], ['活动砖', loadActivity], ['Rating 曲线', loadRating],
    ['难度足迹', loadDifficulty], ['近期 AC', loadRecent], ['数据源状态', loadSources],
  ];
  const results = await Promise.allSettled(modules.map(([, fn]) => fn()));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      console.error(`模块 ${modules[i][0]} 加载失败:`, results[i].reason);
    }
  }
}

// ---------- 生涯统计 ----------
async function loadStats() {
  const st = await api('/stats');
  const grid = $('statGrid');
  const m = st.merged;
  const cards = [
    ['Solved（各平台去重后求和）', m.solved, '不跨 OJ 去重'],
    ['AC 提交数', m.acSubmissions, 'CF + AtCoder 可验证提交'],
    ['活跃天数', m.activeDays, '有提交记录的日期数'],
    ['最长连续', m.longestStreak + ' 天', 'CF + AtCoder'],
    ['当前连续', m.currentStreak + ' 天', '截至今天'],
    ['单日峰值', m.peakDay ? `${m.peakDay.count} 次 · ${m.peakDay.date}` : '-', ''],
  ];
  grid.innerHTML = cards.map(([k, v, s]) =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`).join('');

  const notes = [];
  for (const p of st.per) {
    const nm = PLATFORM[p.platform]?.name || p.platform;
    let part = `${nm}：Solved ${p.solved}`;
    if (p.acSubmissions != null) part += ` · AC 提交 ${p.acSubmissions}`;
    if (p.currentRating != null) part += ` · Rating ${p.currentRating}`;
    if (p.lastChange) part += `（最近 ${esc(p.lastChange.contest)}: ${p.lastChange.old}→${p.lastChange.new}）`;
    if (p.platform === 'luogu') part += '（无时间信息，不计活跃天数）';
    if (!p.solved && p.acSubmissions == null && p.currentRating == null) part += '（未同步）';
    notes.push(part);
  }
  $('statNotes').textContent = notes.join('；');
}

// ---------- 活动砖 ----------
async function loadActivity() {
  const range = $('actRange').value, mode = $('actMode').value;
  const data = await api(`/activity?range=${range}&mode=${mode}&platform=all`);
  actCache = { range, mode, data };

  const wrap = $('heatWrap');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (range === 'year') { start.setMonth(0, 1); }
  else start.setDate(start.getDate() - 364);
  const dayMap = new Map(data.map((d) => [d.date, d.count]));
  const weeks = [];
  const firstDow = start.getDay();
  // 首列补空格
  let col = new Array(firstDow).fill(null);
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const ds = dateStr(d.getTime() / 1000);
    col.push(dayMap.get(ds) || 0);
    if (col.length === 7) { weeks.push(col); col = []; }
  }
  if (col.length) { while (col.length < 7) col.push(null); weeks.push(col); }

  const levels = quantiles(weeks.flat().filter((v) => v && v > 0));
  const lvl = (v) => (v == null ? '' : v === 0 ? '' : v <= levels[1] ? ' c1' : v <= levels[2] ? ' c2' : v <= levels[3] ? ' c3' : ' c4');
  wrap.innerHTML = `<div class="heat">${weeks.map((w) =>
    `<div class="col">${w.map((v) => `<div class="cell${lvl(v)}" title="${v ? `${v} 次` : ''}"></div>`).join('')}</div>`).join('')}</div>`;

  const total = data.reduce((s, x) => s + x.count, 0);
  const active = data.filter((x) => x.count > 0).length;
  $('heatSummary').textContent = `区间内活跃 ${active} 天，累计 ${total} 次`;
}

function quantiles(arr) {
  if (!arr.length) return [0, 0, 0, 0];
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.floor(p * (s.length - 1))];
  return [q(.25), q(.5), q(.75), q(1)];
}

function exportHeatPng() {
  if (!actCache) return;
  const { data } = actCache;
  const W = 780, H = 130, cell = 12, gap = 3, pad = 10;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1d2026'; ctx.fillRect(0, 0, W, H);
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 364);
  const dayMap = new Map(data.map((d) => [d.date, d.count]));
  const colors = ['#21262d', '#0e4429', '#006d32', '#26a641', '#39d353'];
  const levels = quantiles([...dayMap.values()].filter((v) => v > 0));
  let x = pad;
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const v = dayMap.get(dateStr(d.getTime() / 1000)) || 0;
    const idx = v === 0 ? 0 : v <= levels[1] ? 1 : v <= levels[2] ? 2 : v <= levels[3] ? 3 : 4;
    ctx.fillStyle = colors[idx];
    ctx.fillRect(x, pad + (d.getDay() % 7) * (cell + gap), cell, cell);
    if (d.getDay() === 6) x += cell + gap;
  }
  ctx.fillStyle = '#9aa2ad'; ctx.font = '10px sans-serif';
  ctx.fillText(`XCPC 训练台 · 活动砖（${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()} ~ ${todayStr()}）`, pad, H - 4);
  cv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `activity-${todayStr()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ---------- Rating 曲线 ----------
async function loadRating() {
  const pf = $('ratingPlat').value;
  const data = await api(`/rating?platform=${pf}`);
  const box = $('ratingChart'), empty = $('ratingEmpty');
  if (!data.length) {
    box.innerHTML = '';
    empty.textContent = '该平台还没有可用的 Rating 记录（同步后显示）。';
    return;
  }
  empty.textContent = '';
  const W = 1000, H = 260, ml = 46, mr = 14, mt = 12, mb = 28;
  const ratings = data.map((d) => d.new_rating);
  const min = Math.min(...ratings) - 50, max = Math.max(...ratings) + 50;
  const X = (i) => ml + (i / Math.max(1, data.length - 1)) * (W - ml - mr);
  const Y = (r) => mt + (1 - (r - min) / (max - min)) * (H - mt - mb);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d.new_rating).toFixed(1)}`).join(' ');
  const area = path + ` L${X(data.length - 1)},${H - mb} L${X(0)},${H - mb} Z`;
  const grid = [0.25, 0.5, 0.75].map((f) => {
    const y = mt + f * (H - mt - mb);
    return `<line class="gridline" x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}"></line><text x="${ml - 6}" y="${y + 4}" text-anchor="end">${Math.round(min + f * (max - min))}</text>`;
  }).join('');
  const labels = [];
  const step = Math.max(1, Math.floor(data.length / 8));
  for (let i = 0; i < data.length; i += step) {
    const d = new Date(data[i].ts * 1000);
    labels.push(`<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}</text>`);
  }
  const dots = data.map((d, i) => `<circle class="dot" cx="${X(i)}" cy="${Y(d.new_rating)}" r="2.5"><title>${esc(d.contest_name)}: ${d.old_rating}→${d.new_rating}</title></circle>`).join('');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line class="axis" x1="${ml}" y1="${mt}" x2="${ml}" y2="${H - mb}"></line>
    <line class="axis" x1="${ml}" y1="${H - mb}" x2="${W - mr}" y2="${H - mb}"></line>
    ${grid}${labels}
    <path class="area" d="${area}"></path>
    <path class="line" d="${path}"></path>${dots}
  </svg>`;
}

// ---------- 难度足迹 ----------
async function loadDifficulty() {
  const pf = $('diffPlat').value;
  const data = await api(`/difficulty?platform=${pf}`);
  const box = $('diffChart');
  if (!data.length) { box.innerHTML = '<div class="muted small">暂无数据（同步后显示）。</div>'; return; }
  const max = Math.max(...data.map((d) => d[1]));
  box.innerHTML = `<div class="bar-chart">${data.map(([k, v]) =>
    `<div class="bar"><span>${v}</span><i style="height:${Math.max(3, (v / max) * 100)}%"></i><span style="font-size:10px">${esc(k)}</span></div>`).join('')}</div>`;
}

// ---------- 近期 AC ----------
async function loadRecent() {
  const data = await api('/recent?platform=all&n=16');
  const list = $('recentList');
  const note = $('recentNote');
  if (!data.length) {
    list.innerHTML = '<div class="muted small">暂无 AC 记录。请在「设置」填写账号并同步。</div>';
    note.textContent = '';
    return;
  }
  list.innerHTML = `<table><thead><tr><th>时间</th><th>平台</th><th>题号</th><th>标题</th><th>难度</th><th>标签</th></tr></thead><tbody>
    ${data.map((r) => `<tr>
      <td class="small muted">${fmtTs(r.ts)}</td>
      <td>${PLATFORM[r.platform]?.short || r.platform}</td>
      <td class="mono"><a href="${esc(r.url)}" target="_blank">${esc(r.pid)}</a></td>
      <td>${esc(r.name)}</td>
      <td class="num">${ratingLabel(r.platform, r.rating)}</td>
      <td class="small muted">${esc(r.tags.slice(0, 3).join('、'))}</td>
    </tr>`).join('')}</tbody></table>`;
  note.textContent = `全平台最近 ${data.length} 条 AC。`;
}

// ---------- 今日任务 ----------
async function loadToday() {
  const box = $('todayList');
  if (!box) return;
  try {
    const items = await api('/plan/today', { silent: true });
    if (!items.length) {
      box.innerHTML = '<div class="muted small">今天没有待办题目。去「训练计划」生成一份计划吧。</div>';
      return;
    }
    box.innerHTML = `<div class="muted small mb">共 ${items.length} 道待完成（含逾期）</div>` +
      items.map((it) => {
        const overdue = it.scheduled_date < todayStr();
        return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span class="src" style="background:${PLATFORM[it.platform]?.color}22;color:${PLATFORM[it.platform]?.color};padding:2px 8px;border-radius:4px;font-size:12px">${PLATFORM[it.platform]?.short || it.platform}</span>
          <a href="${esc(it.url || '#')}" target="_blank" class="mono" style="min-width:80px">${esc(it.pid)}</a>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name || '')}</span>
          <span class="tag">${ratingLabel(it.platform, it.rating)}</span>
          ${overdue ? '<span class="badge warn">逾期 ' + it.scheduled_date.slice(5) + '</span>' : ''}
        </div>`;
      }).join('');
  } catch {
    box.innerHTML = '';
  }
}

// ---------- 数据源状态 ----------
async function loadSources() {
  const s = await api('/settings');
  const st = (await api('/sync/status')).states;
  const rows = [];
  for (const [pf, users] of Object.entries(s.platforms)) {
    for (const u of users) {
      const x = st.find((v) => v.platform === pf && v.user === u.handle);
      rows.push({ pf, handle: u.handle, x });
    }
  }
  const box = $('sourceStatus');
  if (!rows.length) {
    box.innerHTML = '<div class="muted small">尚未配置任何账号，请到「设置」添加并同步。</div>';
    return;
  }
  box.innerHTML = `<table><thead><tr><th>平台</th><th>账号</th><th>状态</th><th>上次同步</th><th>说明</th></tr></thead><tbody>
    ${rows.map((r) => {
      const st2 = r.x;
      const dot = !st2 || !st2.status ? 'dot' : st2.status === 'ok' ? 'dot ok' : st2.status === 'syncing' ? 'dot run' : 'dot err';
      const last = st2 && st2.last_sync ? fmtTs(st2.last_sync) : '从未';
      const err = (st2 && st2.error) || '';
      return `<tr><td>${PLATFORM[r.pf]?.name || r.pf}</td><td class="mono">${esc(r.handle)}</td>
        <td><span class="${dot}"></span>${st2 && st2.status === 'syncing' ? '同步中' : (st2 && st2.status === 'ok' ? '正常' : (st2 && st2.status === 'error' ? '错误' : '未同步'))}</td>
        <td class="small muted">${last}</td><td class="small muted">${esc(err)}</td></tr>`;
    }).join('')}</tbody></table>`;
}

async function pollStatus() {
  setInterval(async () => {
    const st = await api('/sync/status', { silent: true }).catch(() => null);
    if (st && st.running) loadSources();
  }, 3000);
}

init();
