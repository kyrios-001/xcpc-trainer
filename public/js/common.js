'use strict';
/* common.js — 公共工具：API 封装、主题、导航、格式化 */

/** 统一 API 封装：带超时与错误提示。超时默认 20s（长轮询可传 opts.timeout 覆盖）。 */
async function api(path, opts = {}) {
  const timeout = opts.timeout || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch('/api' + path, {
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || ('请求失败 HTTP ' + res.status));
    }
    if (opts.blob) return res.blob();
    return await res.json();
  } catch (e) {
    const msg = e.name === 'AbortError' ? '请求超时，请稍后重试' : (e.message || '网络错误');
    if (opts.silent !== true) flash(msg, 'err');
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// 全局兜底：页面脚本任何未捕获错误都给出可见提示，而不是白屏
window.addEventListener('error', (e) => {
  if (e && e.message) flash('页面异常: ' + e.message, 'err');
});
window.addEventListener('unhandledrejection', (e) => {
  if (e && e.reason && e.reason.message) flash('请求失败: ' + e.reason.message, 'err');
});

const PLATFORM = {
  codeforces: { name: 'Codeforces', short: 'CF', color: '#4f9cf9' },
  atcoder: { name: 'AtCoder', short: 'AC', color: '#d29922' },
  luogu: { name: '洛谷', short: '洛谷', color: '#3fb950' },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTs(sec) {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDur(sec) {
  if (sec == null || sec < 0) return '-';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s).padStart(2, '0')}s`;
}

function ratingLabel(platform, rating) {
  if (rating == null) return '未评级';
  if (platform === 'atcoder') return `AC ${rating}`;
  if (platform === 'luogu') return rating;   // 已折算练习分
  return rating;
}

/** 应用主题（失败时回退暗色，不阻塞页面加载） */
async function applyTheme() {
  try {
    const s = await api('/settings', { silent: true });
    document.documentElement.setAttribute('data-theme', s.theme || 'dark');
    const sel = document.getElementById('themeSel');
    if (sel) sel.value = s.theme || 'dark';
    return s;
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
    return null;
  }
}

/** 渲染顶栏导航 */
function renderNav(active) {
  const items = [
    ['/', '总览'], ['/plan.html', '训练计划'], ['/library.html', '题库'],
    ['/calendar.html', '比赛 · 虚拟赛'], ['/tracker.html', 'ICPC/CCPC 追踪'], ['/settings.html', '设置'],
  ];
  document.querySelectorAll('.nav').forEach((nav) => {
    nav.innerHTML = items.map(([href, name]) =>
      `<a href="${href}" class="${active === name ? 'active' : ''}">${name}</a>`).join('');
  });
}

/** 通用错误提示 */
function toast(container, text, kind = 'err') {
  if (!container) return;
  container.innerHTML = `<div class="notice ${kind}">${esc(text)}</div>`;
}

/** 短提示（自动消失） */
function flash(text, kind = 'ok') {
  let el = document.getElementById('flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.style.cssText = 'position:fixed;top:64px;right:22px;z-index:99;padding:10px 16px;border-radius:10px;background:var(--panel);border:1px solid var(--border);color:var(--text);box-shadow:var(--shadow);font-size:13px;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.borderColor = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)' : 'var(--danger)';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2600);
  el.style.opacity = '1';
}

/** 把秒级时间戳转成本地 YYYY-MM-DD */
function dateStr(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr() { return dateStr(Date.now() / 1000); }
