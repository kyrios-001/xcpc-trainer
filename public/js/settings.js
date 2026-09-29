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
  const lcUser = s.platforms.leetcode && s.platforms.leetcode[0];
  if (lcUser) $('lcHandle').value = lcUser.handle;
  for (const [pf, id] of [['hdu','hduHandle'],['poj','pojHandle'],['vjudge','vjHandle'],['nowcoder','ncUid'],['qoj','qojHandle']]) {
    const u = s.platforms[pf] && s.platforms[pf][0];
    if (u) $(id).value = u.handle;
  }

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
  $('btnSaveLc').addEventListener('click', async () => {
    const v = $('lcHandle').value.trim();
    await api('/settings', { method: 'POST', body: { lc_handle: v } });
    flash(v ? 'LeetCode 账号已保存' : 'LeetCode 账号已删除');
    await loadSync();
  });
  // 通用平台保存：data-save="platform:inputId"
  document.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
    const [pf, inputId] = b.dataset.save.split(':');
    const v = $(inputId).value.trim();
    const fieldMap = { hdu: 'hdu_handle', poj: 'poj_handle', vjudge: 'vj_handle', nowcoder: 'nc_uid', qoj: 'qoj_handle' };
    await api('/settings', { method: 'POST', body: { [fieldMap[pf]]: v } });
    flash(v ? PLATFORM[pf].name + ' 账号已保存' : PLATFORM[pf].name + ' 账号已删除');
    await loadSync();
  }));

  await Promise.all([loadSync(), loadTiers()]);
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
    <div style="display:flex;align-items:flex-start;gap:16px;border-bottom:1px solid var(--border);padding:10px 0">
      <div style="flex:1;min-width:0">
        <div><b>${PLATFORM[pf]?.name}</b> <span class="mono">${esc(u.handle)}</span></div>
        <div class="small muted" style="margin-top:4px;line-height:1.5;word-break:break-word;white-space:normal">${st && st.status === 'ok' ? `上次同步 ${fmtTs(st.last_sync)}` : st && st.status === 'error' ? `<span style="color:#c0392b">错误：${esc(st.error)}</span>` : '未同步'}</div>
      </div>
      <div class="row" style="flex-shrink:0;gap:6px">
        <button class="btn sm" data-sync="${pf}:${u.handle}:latest">同步最新</button>
        <button class="btn sm danger" data-del="${pf}:${u.handle}" title="删除此账号及其所有同步数据">删除账号</button>
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
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const [pf, handle] = b.dataset.del.split(':');
    if (!confirm(`删除账号 ${PLATFORM[pf]?.name} / ${handle}？\n这会同时删除它的所有同步数据（提交记录、Rating、做题标记），不可恢复。`)) return;
    await api('/user', { method: 'DELETE', body: { platform: pf, handle } });
    flash('账号已删除');
    loadSync();
  }));
}

async function pollUntilIdle() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await api('/sync/status', { silent: true }).catch(() => null);
    if (!st) continue;
    if (!st.running) { loadSync(); flash('同步完成'); return; }
  }
  loadSync();
}

// ---------- 洛谷题库导入 ----------
async function loadTiers() {
  const tiers = await api('/luogu/tiers');
  const counts = (await api('/settings')).luogu_tier_counts;
  const box = $('luoguTiers');
  box.innerHTML = tiers.filter((t) => t.low != null).map((t) => {
    const n = counts[t.key] || 0;
    return `<div class="row" style="border-bottom:1px solid var(--border);padding:6px 0">
      <span style="width:170px" title="洛谷官方档位：${t.name}">${t.name}</span>
      <span class="small muted" style="width:130px" title="折算为 CF 练习分区间，便于与 CF/AtCoder 题统一排计划">折算 ${t.low}~${t.high}</span>
      <span class="small muted" style="width:90px">已入库 ${n} 题</span>
      <button class="btn sm" data-tier="${t.key}">抓取题库</button>
      <span class="small muted">约 8 页 / 1.2s 每请求</span>
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
        const st = await api('/sync/status', { silent: true }).catch(() => null);
        if (!st) continue;
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

async function init2() {
  // 数据目录
  const h = await api('/health', { silent: true }).catch(() => ({}));
  const el = document.getElementById('dataDir');
  if (el) el.textContent = h.dataDir || '';
}

init();
init2();
