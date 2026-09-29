'use strict';
/* tracker.js — ICPC / CCPC 补题追踪 */

const $ = (id) => document.getElementById(id);
let allSets = [];

async function init() {
  const s = await applyTheme();
  renderNav('ICPC/CCPC 追踪');
  $('themeSel').addEventListener('change', async (e) => {
    await api('/settings', { method: 'POST', body: { theme: e.target.value } });
    document.documentElement.setAttribute('data-theme', e.target.value);
  });
  $('fSeries').addEventListener('change', render);
  $('fYear').addEventListener('change', render);
  $('fSite').addEventListener('input', debounce(render, 300));
  $('fProgress').addEventListener('change', render);
  $('btnAddContest').addEventListener('click', openModal);
  $('mSave').addEventListener('click', saveContest);
  $('mCancel').addEventListener('click', closeModal);
  await load();
}

function debounce(fn, ms) {
  let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

async function load() {
  const r = await api('/sets');
  allSets = r.contests;
  const years = [...new Set(allSets.map((c) => c.year))].sort((a, b) => b - a);
  $('fYear').innerHTML = '<option value="">全部年份</option>' +
    years.map((y) => `<option>${y}</option>`).join('');
  renderOverall(r.overall);
  render();
}

function renderOverall(overall) {
  const box = $('overallBox');
  const by = {};
  for (const r of overall || []) {
    const key = `${r.series} ${r.year}`;
    by[key] = by[key] || { series: r.series, year: r.year, ac: 0, total: 0 };
    by[key].total += r.c;
    if (r.status === 'ac') by[key].ac += r.c;
  }
  const entries = Object.entries(by).sort((a, b) => b[0].localeCompare(a[0]));
  box.innerHTML = entries.map(([k, v]) =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v.ac}<span style="font-size:14px">/${v.total}</span></div><div class="s">已补题数 / 记录数</div></div>`).join('')
    || '<div class="muted small">还没有补题记录。展开赛事后添加题目并标记。</div>';
}

function render() {
  const series = $('fSeries').value, year = $('fYear').value,
    site = $('fSite').value.trim().toLowerCase(), prog = $('fProgress').value;
  const list = allSets.filter((c) =>
    (!series || c.series === series) &&
    (!year || c.year === +year) &&
    (!site || c.site.toLowerCase().includes(site)) &&
    (!prog || (prog === 'done' ? acCount(c) > 0 && acCount(c) === c.problems.length :
      prog === 'partial' ? acCount(c) > 0 && acCount(c) < c.problems.length :
      acCount(c) === 0)));

  const box = $('setsBox');
  box.innerHTML = list.map((c) => {
    const ac = acCount(c);
    const pct = c.problems.length ? Math.round(ac / c.problems.length * 100) : 0;
    return `<div class="card" style="margin-bottom:10px">
      <div class="row" style="justify-content:space-between;cursor:pointer" data-toggle="${c.id}">
        <div>
          <b>${esc(c.contest_name)}</b>
          <span class="badge">${c.year}</span>
          <span class="muted small">${esc(c.site)} · ${c.problems.length ? c.problems.length + ' 题' : (c.problem_count ? c.problem_count + ' 题（参考）' : '题数未填')} · AC ${ac}</span>
        </div>
        <div class="row">
          <div style="width:120px;height:8px;background:var(--panel2);border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:var(--ok)"></div>
          </div>
          <button class="btn sm" data-edit="${c.id}">编辑</button>
          <button class="btn sm danger" data-del="${c.id}">删除</button>
        </div>
      </div>
      <div id="contest-${c.id}" style="display:none" class="mt">
        <div class="row mb">
          <input type="text" id="addP-${c.id}" placeholder="粘贴题目链接或题号（如 P1000 / 1234A / abc123_a）" style="flex:1;min-width:220px">
          <input type="text" id="addIdx-${c.id}" placeholder="题号（A/B/C...）" style="width:80px">
          <button class="btn sm primary" data-addp="${c.id}">添加题目</button>
        </div>
        <table><thead><tr><th>题号</th><th>题目</th><th>状态</th><th>笔记</th></tr></thead><tbody>
          ${c.problems.map((p) => {
            const pr = (c.progress || {})[p.idx] || { status: 'todo', note: '' };
            return `<tr>
              <td class="mono">${esc(p.idx)}</td>
              <td><a href="${esc(p.url || '#')}" target="_blank">${esc(p.name || `${p.platform}:${p.pid}`)}</a>
                <span class="tag">${esc(p.platform)} ${esc(p.pid)}</span></td>
              <td>
                <select data-prog="${c.id}:${esc(p.idx)}" style="width:100px">
                  ${['todo', 'ac', 'tried', 'skipped'].map((st) =>
                    `<option value="${st}" ${pr.status === st ? 'selected' : ''}>${
                      st === 'todo' ? '未做' : st === 'ac' ? '已 AC' : st === 'tried' ? '尝试过' : '跳过'}</option>`).join('')}
                </select>
              </td>
              <td><input type="text" data-note="${c.id}:${esc(p.idx)}" value="${esc(pr.note || '')}" placeholder="补题笔记" style="width:180px"></td>
            </tr>`;
          }).join('') || '<tr><td colspan="4" class="muted small">暂无题目，粘贴链接添加。</td></tr>'}
        </tbody></table>
      </div>
    </div>`;
  }).join('') || '<div class="muted small">没有符合条件的赛事。</div>';

  box.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('click', () => {
    const panel = document.getElementById('contest-' + el.dataset.toggle);
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }));
  box.querySelectorAll('[data-addp]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.addp;
    const text = $(`addP-${id}`).value.trim();
    const idx = $(`addIdx-${id}`).value.trim().toUpperCase();
    if (!text || !idx) { flash('需要题号和题目链接/题号', 'warn'); return; }
    try {
      await api('/sets/problem', { method: 'POST', body: { contestId: +id, idx, problem: { link: text } } });
      flash('已添加题目（链接已自动解析并补全标题）');
      $(`addP-${id}`).value = '';
      $(`addIdx-${id}`).value = '';
      await load();
    } catch (e) { flash(e.message, 'err'); }
  }));
  box.querySelectorAll('[data-prog]').forEach((sel) => sel.addEventListener('change', async () => {
    const [id, idx] = sel.dataset.prog.split(':');
    await api('/sets/progress', { method: 'POST', body: { contestId: +id, idx, status: sel.value } });
    await load();
  }));
  box.querySelectorAll('[data-note]').forEach((inp) => inp.addEventListener('change', async () => {
    const [id, idx] = inp.dataset.note.split(':');
    await api('/sets/progress', { method: 'POST', body: { contestId: +id, idx, status: 'keep', note: inp.value } });
    flash('笔记已保存');
  }));
  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = allSets.find((x) => x.id === +b.dataset.edit);
    openModal(c);
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('确定删除该赛事及补题记录？')) return;
    await api('/sets/contest', { method: 'POST', body: { delete: true, id: +b.dataset.del } });
    await load();
  }));
}

function acCount(c) {
  return Object.values(c.progress || {}).filter((p) => p.status === 'ac').length;
}

// ---------- 模态 ----------
function openModal(c) {
  $('mId').value = c ? c.id : '';
  $('mSeries').value = c ? c.series : 'ICPC';
  $('mYear').value = c ? c.year : new Date().getFullYear();
  $('mSite').value = c ? c.site : '';
  $('mName').value = c ? c.contest_name : '';
  $('mDate').value = c ? (c.date || '') : '';
  $('mCount').value = c ? c.problem_count : 13;
  $('mLink').value = c ? (c.link || '') : '';
  document.getElementById('contestModal').classList.add('open');
}
function closeModal() {
  document.getElementById('contestModal').classList.remove('open');
}
async function saveContest() {
  const id = $('mId').value ? +$('mId').value : null;
  await api('/sets/contest', { method: 'POST', body: {
    id, series: $('mSeries').value, year: +$('mYear').value || new Date().getFullYear(),
    site: $('mSite').value, contest_name: $('mName').value || `${$('mSeries').value} ${$('mYear').value} ${$('mSite').value}`,
    date: $('mDate').value, problem_count: +$('mCount').value || 12, link: $('mLink').value,
  } });
  closeModal();
  await load();
  flash('已保存');
}

init();
