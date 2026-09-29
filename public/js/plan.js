'use strict';
/* plan.js — 训练计划页：配置、能力画像、日程排期、忙日标记 */

const $ = (id) => document.getElementById(id);
let planData = null, weekOffset = 0, busyMap = new Map();
const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

async function init() {
  const s = await applyTheme();
  renderNav('训练计划');
  $('themeSel').addEventListener('change', async (e) => {
    await api('/settings', { method: 'POST', body: { theme: e.target.value } });
    document.documentElement.setAttribute('data-theme', e.target.value);
  });

  // 休息日选择
  const restSel = $('restDays');
  restSel.innerHTML = DAY_NAMES.map((n, i) =>
    `<label style="display:flex;gap:5px;align-items:center;color:var(--text)"><input type="checkbox" value="${i}"> ${n}</label>`).join('');
  for (const d of s.planDefaults.restDays) {
    const cb = restSel.querySelector(`input[value="${d}"]`);
    if (cb) cb.checked = true;
  }
  $('pTarget').value = s.planDefaults.target;
  $('pWeekly').value = s.planDefaults.weekly;
  $('pMixAc').checked = s.planDefaults.mixAtcoder;
  $('pMixLg').checked = s.planDefaults.mixLuogu;

  $('btnGen').addEventListener('click', generate);
  $('btnRegen').addEventListener('click', async () => {
    try {
      await api('/plan/reschedule', { method: 'POST', body: {} });
      flash('已按当前日期重新排程');
      await loadBusy();
      await loadPlan();
    } catch (e) { flash(e.message, 'err'); }
  });
  $('btnPrev').addEventListener('click', () => { weekOffset--; renderWeek(); });
  $('btnNext').addEventListener('click', () => { weekOffset++; renderWeek(); });
  $('btnToday').addEventListener('click', () => { weekOffset = 0; renderWeek(); });

  await Promise.all([loadCap(), loadBusy(), loadPlan()]);
}

function config() {
  return {
    target: +$('pTarget').value || 1800,
    weekly: +$('pWeekly').value || 12,
    restDays: [...restSelChecked()],
    mixAtcoder: $('pMixAc').checked,
    mixLuogu: $('pMixLg').checked,
  };
}
function restSelChecked() {
  return [...$('restDays').querySelectorAll('input:checked')].map((x) => +x.value);
}

async function saveConfig() {
  await api('/settings', { method: 'POST', body: {
    plan_target: config().target, plan_weekly: config().weekly,
    plan_rest_days: config().restDays,
    plan_mix_atcoder: config().mixAtcoder, plan_mix_luogu: config().mixLuogu,
  } });
}

async function generate(regenOnly = false) {
  const cfg = config();
  await saveConfig();
  const btn = $('btnGen');
  btn.disabled = true;
  $('planStatus').textContent = '生成中...';
  try {
    const r = await api('/plan/generate', { method: 'POST', body: cfg });
    planData = r;
    weekOffset = 0;
    $('planStatus').textContent = regenOnly ? '已按当前排程重新生成（新题量）' : `已生成 ${r.saved} 题 · 约 ${r.weeks} 周`;
    await Promise.all([loadCap(), loadPlan()]);
  } catch (e) {
    $('planStatus').textContent = '生成失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function loadCap() {
  const cfg = config();
  const c = await api(`/capability?target=${cfg.target}`);
  const box = $('capBox');
  box.innerHTML = c.directions.map((d) => {
    const blind = d.blind;
    const pct = blind ? 0 : Math.min(100, d.rep ? (d.rep - 800) / 30 : 0);
    const fill = blind ? '' : `<div class="fill" style="width:${pct}%"></div>`;
    const meta = blind ? '未接触 · 优先级最高'
      : `${d.rep} 分 · n=${d.n} · 置信 ${Math.round(d.confidence * 100)}% · 弱项 ${d.weakIndex ?? '-'}`;
    return `<div class="skill-bar ${blind ? 'blind' : ''}">
      <div class="name">${d.name}</div>
      <div class="track">${fill}</div>
      <div class="meta">${meta}</div>
    </div>`;
  }).join('');
}

async function loadBusy() {
  busyMap = new Map((await api('/busy')).map((b) => [b.date, b.reason]));
}

async function loadPlan() {
  const r = await api('/plan');
  planData = { meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta, items: r.items };
  renderWeek();
  renderStages();
}

function weekStart(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + offset * 7);
  return d;
}

function renderWeek() {
  const start = weekStart(weekOffset);
  const label = `第 ${weekOffset + 1} 周 · ${dateStr(start.getTime() / 1000)} ~ ${dateStr((start.getTime() + 6 * 86400000) / 1000)}`;
  $('weekLabel').textContent = label;
  const items = planData.items || [];
  const done = new Set(items.filter((x) => x.status === 'done').map((x) => `${x.platform}:${x.pid}`));
  const skip = new Set(items.filter((x) => x.status === 'skipped').map((x) => `${x.platform}:${x.pid}`));

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const ds = dateStr(d.getTime() / 1000);
    const dayItems = items.filter((x) => x.scheduled_date === ds);
    const busy = busyMap.get(ds);
    days.push({ ds, dow: d.getDay(), dayItems, busy, isToday: ds === todayStr() });
  }

  $('weekGrid').innerHTML = days.map((day) => {
    const busyHtml = day.busy
      ? `<div class="small muted">🔒 忙：${esc(day.busy)}</div>`
      : `<button class="btn sm" data-busy="${day.ds}" style="padding:2px 6px">忙</button>`;
    const itemHtml = day.dayItems.length
      ? day.dayItems.map((it) => {
        const key = `${it.platform}:${it.pid}`;
        const cls = done.has(key) ? 'done' : skip.has(key) ? 'skipped' : '';
        const url = it.url || '#';
        return `<div class="plan-item ${cls}">
          <span class="src">${PLATFORM[it.platform]?.short || it.platform}</span>
          <a href="${esc(url)}" target="_blank" class="mono">${esc(it.pid)}</a>
          <span class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px">${esc(it.name)}</span>
          <span class="rat">${ratingLabel(it.platform, it.rating)}</span>
          <button class="btn sm" data-done="${key}" title="标记完成">✓</button>
          <button class="btn sm" data-skip="${key}" title="跳过">跳过</button>
        </div>`;
      }).join('')
      : '<div class="small muted">无任务</div>';
    return `<div class="plan-day">
      <div class="date">${DAY_NAMES[day.dow]} ${day.ds.slice(5)}${day.isToday ? ' · 今天' : ''}</div>
      <div class="items">${itemHtml}</div>
      <div class="mt">${busyHtml}</div>
    </div>`;
  }).join('');

  $('weekGrid').querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    const [platform, pid] = b.dataset.done.split(':');
    await api('/plan/item', { method: 'POST', body: { platform, pid, status: 'done' } });
    await loadPlan();
    flash('已标记完成');
  }));
  $('weekGrid').querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', async () => {
    const [platform, pid] = b.dataset.skip.split(':');
    await api('/plan/item', { method: 'POST', body: { platform, pid, status: 'skipped' } });
    await loadPlan();
    flash('已跳过');
  }));
  $('weekGrid').querySelectorAll('[data-busy]').forEach((b) => b.addEventListener('click', async () => {
    const ds = b.dataset.busy;
    if (busyMap.has(ds)) {
      await api('/busy', { method: 'DELETE', body: { date: ds } });
    } else {
      const reason = prompt(`标记 ${ds} 为没空，填写原因（可空）：`, '');
      if (reason === null) return;
      await api('/busy', { method: 'POST', body: { date: ds, reason } });
    }
    await loadBusy();
    await loadPlan();
  }));
}

function renderStages() {
  const meta = planData.meta, items = planData.items;
  const box = $('stageBox');
  if (!meta || !items.length) {
    box.innerHTML = '<div class="muted small">还没有计划。填好配置后点「生成训练计划」。</div>';
    return;
  }
  const stages = (meta.stages || []);
  const total = items.length;
  const doneCount = items.filter((x) => x.status === 'done').length;
  const byStage = {};
  for (const it of items) byStage[it.stage] = (byStage[it.stage] || 0) + 1;
  box.innerHTML = `<table><thead><tr><th>阶段</th><th>练习区间</th><th>题量</th><th>完成</th></tr></thead><tbody>
    ${stages.map((st) => {
      const n = byStage[st.stage] || 0;
      const done = items.filter((x) => x.stage === st.stage && x.status === 'done').length;
      return `<tr><td>阶段 ${st.stage}</td><td class="num">目标 ${st.target}（区间 ${st.low}~${st.high}）</td><td class="num">${n}</td><td class="num">${done} / ${n}</td></tr>`;
    }).join('')}
    <tr><td colspan="2">合计</td><td class="num">${total}</td><td class="num">${doneCount} / ${total}</td></tr>
  </tbody></table>
  <div class="muted small mt">基线 ${meta.base} → 目标 ${meta.target}，按每提升 100 分约 60 题估算约 ${meta.weeks} 周。混排：${(meta.mix || []).map((m) => `${PLATFORM[m.platform]?.name || m.platform} ${m.ratio * 100}%`).join(' + ')}。</div>`;
}

init();
