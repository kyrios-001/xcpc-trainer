'use strict';
/* library.js — 题库浏览 / 我的题单 */

const $ = (id) => document.getElementById(id);
let page = 1, totalPages = 1;

async function init() {
  const s = await applyTheme();
  renderNav('题库');
  $('themeSel').addEventListener('change', async (e) => {
    await api('/settings', { method: 'POST', body: { theme: e.target.value } });
    document.documentElement.setAttribute('data-theme', e.target.value);
  });

  $('tabBrowse').addEventListener('click', () => switchTab('browse'));
  $('tabLists').addEventListener('click', () => switchTab('lists'));
  $('btnFilter').addEventListener('click', () => { page = 1; loadProblems(); });
  $('btnPrev').addEventListener('click', () => { if (page > 1) { page--; loadProblems(); } });
  $('btnNext').addEventListener('click', () => { if (page < totalPages) { page++; loadProblems(); } });
  $('btnRandom').addEventListener('click', randomProblem);
  $('btnCreateList').addEventListener('click', createList);
  $('btnImport').addEventListener('click', importList);
  $('fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; loadProblems(); } });
  $('fTag').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; loadProblems(); } });

  await loadProblems();
  await loadLists();
}

function switchTab(tab) {
  $('tab-browse').style.display = tab === 'browse' ? '' : 'none';
  $('tab-lists').style.display = tab === 'lists' ? '' : 'none';
  $('tabBrowse').className = tab === 'browse' ? 'btn primary sm' : 'btn sm';
  $('tabLists').className = tab === 'lists' ? 'btn primary sm' : 'btn sm';
}

function filters() {
  const params = new URLSearchParams({ page });
  if ($('fPlatform').value !== 'all') params.set('platform', $('fPlatform').value);
  if ($('fMin').value) params.set('rating_min', $('fMin').value);
  if ($('fMax').value) params.set('rating_max', $('fMax').value);
  if ($('fTag').value.trim()) params.set('tag', $('fTag').value.trim());
  if ($('fQ').value.trim()) params.set('q', $('fQ').value.trim());
  params.set('sort', $('fSort').value);
  if ($('fUnsolved').checked) params.set('only_unsolved', '1');
  return params.toString();
}

async function loadProblems() {
  const r = await api('/problems?' + filters());
  totalPages = Math.max(1, Math.ceil(r.total / r.per));
  $('pageInfo').textContent = `第 ${r.page}/${totalPages} 页 · 共 ${r.total} 题`;
  $('btnPrev').disabled = r.page <= 1;
  $('btnNext').disabled = r.page >= totalPages;

  const box = $('probTable');
  if (!r.items.length) {
    box.innerHTML = '<div class="muted small">没有符合条件的题目。可先在「设置」抓取洛谷题库，或调整筛选条件。</div>';
    return;
  }
  box.innerHTML = `<table><thead><tr>
    <th>平台</th><th>题号</th><th>标题</th><th>难度</th><th>标签</th><th>通过人数</th><th></th>
  </tr></thead><tbody>
    ${r.items.map((p) => `<tr class="${p.done ? 'muted' : ''}" style="${p.done ? 'opacity:.6' : ''}">
      <td>${PLATFORM[p.platform]?.short || p.platform}</td>
      <td class="mono"><a href="${esc(p.url)}" target="_blank">${esc(p.pid)}</a></td>
      <td>${esc(p.name)}</td>
      <td class="num">${ratingLabel(p.platform, p.rating)}</td>
      <td>${p.tags.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      <td class="num">${p.solved_count ?? '-'}</td>
      <td>${p.done
        ? `<button class="btn sm" data-undo="${p.platform}:${p.pid}">取消已做</button>`
        : `<button class="btn sm primary" data-mark="${p.platform}:${p.pid}">标为已做</button>`}</td>
    </tr>`).join('')}
  </tbody></table>`;

  box.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', async () => {
    const [platform, pid] = b.dataset.mark.split(':');
    await api('/problems/mark', { method: 'POST', body: { platform, pid, status: 'done' } });
    loadProblems();
  }));
  box.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    const [platform, pid] = b.dataset.undo.split(':');
    await api('/problems/mark', { method: 'POST', body: { platform, pid, status: 'undo' } });
    loadProblems();
  }));
}

async function randomProblem() {
  const q = new URLSearchParams();
  if ($('fPlatform').value !== 'all') q.set('platform', $('fPlatform').value);
  if ($('fMin').value) q.set('rating_min', $('fMin').value);
  if ($('fMax').value) q.set('rating_max', $('fMax').value);
  const r = await api('/problems/random?' + q.toString());
  if (!r) { flash('没有符合条件的题目', 'warn'); return; }
  flash(`随机一题：${r.pid} ${r.name}（${ratingLabel(r.platform, r.rating)}）`);
  window.open(r.url, '_blank');
}

// ---------- 我的题单 ----------
async function createList() {
  const name = $('listName').value.trim() || '未命名题单';
  await api('/lists', { method: 'POST', body: { name, problems: [] } });
  $('listName').value = '';
  loadLists();
}

async function importList() {
  const text = $('importText').value;
  if (!text.trim()) { flash('请先粘贴题目链接或题号', 'warn'); return; }
  try {
    const r = await api('/lists/import', { method: 'POST', body: { name: '导入题单', text } });
    flash(`识别到 ${r.count} 道题，已保存为题单`);
    $('importText').value = '';
    loadLists();
  } catch (e) {
    flash(e.message, 'err');
  }
}

async function loadLists() {
  const lists = await api('/lists');
  const box = $('listsBox');
  if (!lists.length) {
    box.innerHTML = '<div class="card muted small">还没有题单。可以粘贴比赛题面文本（含题号/链接）一键导入，或手动新建。</div>';
    return;
  }
  box.innerHTML = lists.map((l) => {
    const done = l.problems.filter((p) => p.done).length;
    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${esc(l.name)} <span class="muted small">${l.problems.length} 题 · 已做 ${l.done}</span></h2>
        <button class="btn sm danger" data-del="${l.id}">删除</button>
      </div>
      <div class="mt">${l.problems.map((p) =>
        `<span class="tag ${p.done ? '' : 'hot'}"><a href="${esc(p.url || '#')}" target="_blank">${PLATFORM[p.platform]?.short || p.platform}:${esc(p.pid)}</a>${p.name ? ' · ' + esc(p.name) : ''}</span>`).join('') || '<span class="muted small">空题单</span>'}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除该题单？')) return;
    await api(`/lists/${b.dataset.del}/delete`, { method: 'POST', body: {} });
    loadLists();
  }));
}

init();
