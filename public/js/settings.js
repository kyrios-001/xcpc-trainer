'use strict';
/* settings.js — 设置页：账号、同步、洛谷题库导入、模型训练、数据目录 */

const $ = (id) => document.getElementById(id);

async function init() {
  const s = await applyTheme();
  renderNav('设置');
  $('themeSel').addEventListener('change', async (e) => {
    await api('/settings', { method: 'POST', body: { theme: e.target.value } });
    document.documentElement.setAttribute('data-theme', e.target.value);
  });

  // 账号
  $('cfHandle').value = (s.platforms.codeforces[0] || {}).handle || '';
  $('acHandle').value = (s.platforms.atcoder[0] || {}).handle || '';
  $('lgUid').value = (s.platforms.luogu[0] || {}).handle || '';
  if (s.luogu_cookie_set) $('lgCookie').value = '（已保存）';

  $('btnSaveCf').addEventListener('click', async () => {
    await api('/settings', { method: 'POST', body: { cf_handle: $('cfHandle').value.trim() } });
    flash('Codeforces 账号已保存');
  });
  $('btnSaveAc').addEventListener('click', async () => {
    await api('/settings', { method: 'POST', body: { ac_handle: $('acHandle').value.trim() } });
    flash('AtCoder 账号已保存');
  });
  $('btnSaveLg').addEventListener('click', async () => {
    await api('/settings', { method: 'POST', body: { lg_uid: $('lgUid').value.trim() } });
    flash('洛谷账号已保存');
  });
  $('btnSaveCookie').addEventListener('click', async () => {
    const v = $('lgCookie').value;
    if (!v || v === '（已保存）') { flash('请输入 Cookie 值', 'warn'); return; }
    await api('/settings', { method: 'POST', body: { luogu_cookie: v } });
    $('lgCookie').value = '（已保存）';
    flash('Cookie 已保存（仅存本地）');
  });

  $('btnClearAll').addEventListener('click', async () => {
    if (!confirm('确定清空所有 OJ 的同步数据？账号设置会保留。')) return;
    await api('/sync/clear', { method: 'POST', body: { all: true } });
    flash('已清空');
    await loadSync();
  });

  await Promise.all([loadSync(), loadTiers(), loadModel()]);
}

// ---------- 同步控制 ----------
async function loadSync() {
  const s = await api('/settings');
  const states = (await api('/sync/status')).states;
  const box = $('syncBox');
  const rows = [];
  for (const [pf, users] of Object.entries(s.platforms)) {
    for (const u of users) rows.push({ pf, u, st: states.find((x) => x.platform === pf && x.user === u.handle) });
  }
  if (!rows.length) {
    box.innerHTML = '<div class="muted small">先在上方填写账号并保存。</div>';
    return;
  }
  box.innerHTML = rows.map(({ pf, u, st }) => `
    <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:10px 0">
      <div>
        <b>${PLATFORM[pf]?.name}</b> <span class="mono">${esc(u.handle)}</span>
        <span class="small muted">${st && st.status === 'ok' ? `上次同步 ${fmtTs(st.last_sync)}` : st && st.status === 'error' ? `错误：${esc(st.error)}` : '未同步'}</span>
      </div>
      <div class="row">
        <button class="btn sm" data-sync="${pf}:${u.handle}:latest">同步最新</button>
        <button class="btn sm" data-sync="${pf}:${u.handle}:full">重新同步全部</button>
        <button class="btn sm danger" data-clear="${pf}:${u.handle}">清空单站</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-sync]').forEach((b) => b.addEventListener('click', async () => {
    const [pf, handle, mode] = b.dataset.sync.split(':');
    b.disabled = true;
    try {
      await api('/sync', { method: 'POST', body: { platform: pf, handle, mode } });
      flash(`${PLATFORM[pf]?.name} 同步已启动，完成后自动更新状态`);
      pollUntilIdle();
    } catch (e) { flash(e.message, 'err'); b.disabled = false; }
  }));
  box.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
    const [pf, handle] = b.dataset.clear.split(':');
    if (!confirm(`清空 ${PLATFORM[pf]?.name}（${handle}）的同步数据？账号设置保留。`)) return;
    await api('/sync/clear', { method: 'POST', body: { platform: pf } });
    flash('已清空该站数据');
    loadSync();
  }));
}

async function pollUntilIdle() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await api('/sync/status');
    if (!st.running) { loadSync(); flash('同步完成'); return; }
  }
  loadSync();
}

// ---------- 洛谷题库导入 ----------
async function loadTiers() {
  const tiers = await api('/luogu/tiers');
  const counts = (await api('/settings')).luogu_tier_counts;
  const box = $('luoguTiers');
  box.innerHTML = tiers.map((t) => {
    const n = counts[t.key] || 0;
    return `<div class="row" style="border-bottom:1px solid var(--border);padding:6px 0">
      <span style="width:150px">${t.name}（${t.low}~${t.high}）</span>
      <span class="small muted" style="width:90px">已入库 ${n} 题</span>
      <button class="btn sm" data-tier="${t.key}" ${t.key === 0 ? 'disabled title="入门档对训练没意义，不抓"' : ''}>抓取题库</button>
      <span class="small muted">${t.key === 0 ? '入门档默认不抓' : '约 8 页 / 1.2s 每请求'}</span>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-tier]').forEach((b) => b.addEventListener('click', async () => {
    const tier = b.dataset.tier;
    b.disabled = true;
    $('luoguStatus').textContent = '正在抓取，约 10 秒...';
    try {
      await api('/luogu/import', { method: 'POST', body: { tier: +tier } });
      $('luoguStatus').textContent = '抓取中...';
      const key = 'luogu-import-' + tier;
      for (let i = 0; i < 90; i++) {
        await new Promise((r2) => setTimeout(r2, 2000));
        const st = await api('/sync/status');
        if (!st.tasks || !st.tasks[key]) {
          $('luoguStatus').textContent = '抓取完成';
          loadTiers();
          b.disabled = false;
          return;
        }
      }
      $('luoguStatus').textContent = '等待超时，请稍后刷新查看（抓取仍在后台进行）。';
      b.disabled = false;
    } catch (e) {
      $('luoguStatus').textContent = '抓取失败：' + e.message;
      b.disabled = false;
    }
  }));
}

// ---------- 模型 ----------
async function loadModel() {
  const m = await api('/model');
  const box = $('modelBox');
  if (!m) {
    box.innerHTML = '<div class="muted small">尚未训练。训练后模型若通过检验（留出集 AUC ≥ 0.75 且优于基线）会自动用于选题，否则继续用内置规则。</div>';
    return;
  }
  const trainedAt = m.trainedAt ? new Date(m.trainedAt).toLocaleString() : '-';
  box.innerHTML = `<div class="row">
    <span class="badge ${m.enabled ? 'ok' : ''}">${m.enabled ? '已启用' : '未启用'}</span>
    <span class="small muted">样本 ${m.samples} · AUC ${m.auc ? m.auc.toFixed(3) : '-'}（基线 ${m.baseAuc ? m.baseAuc.toFixed(3) : '-'}）· LogLoss ${m.logloss ? m.logloss.toFixed(4) : '-'} · 训练于 ${esc(trainedAt)}</span>
  </div>
  ${m.note ? `<div class="small muted mt">说明：${esc(m.note)}</div>` : ''}`;
}

async function initTrain() {
  const btn = $('btnTrain');
  btn.disabled = true;
  try {
    const n = +$('trainContests').value || 60;
    const r = await api('/model/train', { method: 'POST', body: { contests: n } });
    if (!r.started) { flash(r.reason || '已有训练在运行', 'warn'); btn.disabled = false; return; }
    flash('训练已启动，需要较长时间，请稍候...');
    for (let i = 0; i < 240; i++) {
      await new Promise((r2) => setTimeout(r2, 3000));
      const s = await api('/settings');
      if (!s.tasks || !s.tasks.train) { await loadModel(); flash('训练完成'); btn.disabled = false; return; }
    }
    btn.disabled = false;
  } catch (e) {
    flash('训练失败：' + e.message, 'err');
    btn.disabled = false;
  }
}

async function init2() {
  $('btnTrain').addEventListener('click', initTrain);
  // 数据目录
  const r = await fetch('/api/health');
  const h = await r.json();
  const el = document.getElementById('dataDir');
  if (el) el.textContent = h.dataDir || '';
}

init();
init2();
