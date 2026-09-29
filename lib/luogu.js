'use strict';
/**
 * lib/luogu.js — 洛谷客户端
 * 题目列表页公开可抓（按难度档入库）；个人做题记录需要登录 Cookie（可选，安全降级）。
 * 洛谷不提供逐题难度与提交时间：
 *   - 难度按官方档位折算为练习分（估计值，鼠标悬停可看真实档位）；
 *   - 做题记录无时间信息，只用于“已做”标记与统计题量，不进热力图。
 */
const dbm = require('./db');
const { LUOGU_TIER, LUOGU_TIER_SCHEMA, luoguTierRating, LUOGU_TAG_MAP, luoguTierName } = require('./knowledge');

const BASE = 'https://www.luogu.com.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 每档实测总页数（2026-09 洛谷主题库，列表页每页约 50 题）；4 档未实测，保守按 60 */
const TIER_TOTAL_PAGES = { 1: 24, 2: 40, 3: 48, 4: 60, 5: 59, 6: 13, 7: 72 };

// ---- cookie jar：WAF 下发的 C3VK 等 cookie，进程内累积 ----
const cookieJar = new Map(); // name -> value
function mergeSetCookies(res) {
  if (typeof res.headers.getSetCookie !== 'function') return;
  for (const line of res.headers.getSetCookie()) {
    const kv = line.split(';')[0];
    const eq = kv.indexOf('=');
    if (eq > 0) cookieJar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
}
function buildCookieHeader() {
  const parts = [];
  const user = dbm.getSetting('luogu_cookie', '');
  if (user) parts.push(user.trim());
  for (const [k, v] of cookieJar) parts.push(k + '=' + v);
  return parts.join('; ');
}

let lastRequest = 0;
const queue = [];
let draining = false;
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!draining) drain();
  });
}
async function drain() {
  draining = true;
  while (queue.length) {
    const { fn, resolve, reject } = queue.shift();
    const wait = lastRequest + 1200 - Date.now();   // 实测单线程 1.2s/请求安全
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    try { resolve(await fn()); } catch (e) { reject(e); }
  }
  draining = false;
}

function getCookie() {
  return dbm.getSetting('luogu_cookie', '');
}

async function request(url, { json = true, retries = 1 } = {}) {
  return schedule(async () => {
    const headers = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': BASE + '/problem/list',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
    try {
      let res;
      for (let attempt = 0; ; attempt++) {
        headers.Cookie = buildCookieHeader();
        res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
        mergeSetCookies(res);
        // 手动跟随 302：带上新拿到的 cookie 重发，最多 3 轮
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (loc && attempt < 3) {
            await res.text().catch(() => {});
            url = new URL(loc, url).toString();
            continue;
          }
          await res.text().catch(() => {});
          throw new Error('洛谷反爬挑战未通过（连续 302）。请在「设置」中填写洛谷登录 Cookie（浏览器登录后复制），已登录用户请求会被直接放行。');
        }
        if (res.status === 429 && attempt < retries) {
          await res.text().catch(() => {});
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        break;
      }
      const text = await res.text();
      if (!json) return text;
      try { return JSON.parse(text); } catch {
        const m = text.match(/window\._feInjection\s*=\s*JSON\.parse\(\s*(?:decodeURIComponent\()?"([^"]+)"\)?/);
        if (m) return JSON.parse(decodeURIComponent(m[1]));
        if (res.status === 401 || res.status === 403) {
          throw new Error('洛谷拒绝访问（HTTP ' + res.status + '）：登录 Cookie 可能已过期，请在设置中重新填写。');
        }
        throw new Error('洛谷返回非 JSON（HTTP ' + res.status + '）。');
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error('请求洛谷超时（20 秒）。可能是洛谷限流或网络波动，请稍后重试。');
      }
      if (e.name === 'TypeError' && /fetch failed/i.test(e.message || '')) {
        throw new Error('无法连接洛谷（网络受限或洛谷反爬拦截）。请确认网络可访问 luogu.com.cn，并在设置中填写登录 Cookie。');
      }
      throw e;
    }
  });
}


// ---- HTML 解析（洛谷 WAF 过挑战后返回 SSR HTML 而非 JSON）----
function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function parseProblemsHtml(html) {
  // 每个 <li> 块内有 <h3><a href="/problem/PXXX">标题</a></h3> 和若干 tag 链接
  const out = [];
  const liRe = /<li>[\s\S]*?<h3><a href="\/problem\/(P\d+)">([^<]+)<\/a><\/h3>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const pid = m[1], title = decodeHtml(m[2].trim());
    const body = m[3];
    const tags = [];
    const tagRe = /<a href="\/problem\/list\?tag=\d+">([^<]+)<\/a>/g;
    let t;
    while ((t = tagRe.exec(body)) !== null) tags.push(decodeHtml(t[1].trim()));
    out.push({ pid, title, tags });
  }
  return out;
}

function parseContestsHtml(html) {
  // <h3><a href="/contest/NNN">名称</a></h3> 后面 <p><small>时间 ~ 时间</small></p>
  const out = [];
  const re = /<h3><a href="\/contest\/(\d+)">([^<]+)<\/a><\/h3>[\s\S]*?<small>([^<]+)<\/small>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ id: m[1], name: decodeHtml(m[2].trim()), range: decodeHtml(m[3].trim()) });
  }
  return out;
}

async function fetchPageText(url) {
  // 带 cookie jar + 手动 302 跟随，返回最终 HTML/JSON 文本
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': BASE + '/problem/list',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  for (let attempt = 0; ; attempt++) {
    headers.Cookie = buildCookieHeader();
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    mergeSetCookies(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc && attempt < 4) {
        await res.text().catch(() => {});
        url = new URL(loc, url).toString();
        continue;
      }
      await res.text().catch(() => {});
      throw new Error('洛谷反爬挑战未通过。请在「设置」中填写洛谷登录 Cookie 后重试。');
    }
    if (res.status === 429 && attempt < 1) {
      await res.text().catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    return await res.text();
  }
}

/**
 * 洛谷比赛日历（未来 14 天）：列表页第一页包含最近的未开始/进行中比赛。
 * 上游 JSON 字段不稳定，采用防御式多字段解析，解析不到的比赛直接跳过。
 * @returns {Array<{platform,id,name,start,duration,type}>}
 */
async function getUpcomingContests(days = 14) {
  const html = await fetchPageText(`${BASE}/contest/list?page=1`);
  const list = parseContestsHtml(html);
  const now = Date.now();
  const horizon = now + days * 24 * 3600 * 1000;
  const out = [];
  for (const c of list) {
    // range 形如 "2026-09-25 13:00:00 ~ 2026-09-25 18:00:00"
    const m = c.range.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}):\d{2}/);
    if (!m) continue;
    const start = new Date(m[1] + 'T' + m[2] + ':00+08:00').getTime();
    if (Number.isNaN(start) || start < now - 3600 * 1000 || start > horizon) continue;
    out.push({
      platform: 'luogu', id: String(c.id), name: c.name,
      start: Math.floor(start / 1000), duration: null, type: '比赛',
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 按难度档导入题库：每档等距抽 8 页（约 400 题，页数不超过该档实际总页数）。
 * 入库按难度档替换式增量：先抓 A 档、再抓 B 档，A 档不会被清掉。
 * 档位表结构变更（LUOGU_TIER_SCHEMA）时自动清空旧档位数据，避免难度口径错位残留。
 * @returns {{tiers: Record<number, number>}}
 */
async function importTier(tierKey, pages = 8) {
  const tier = LUOGU_TIER.find((x) => x.key === tierKey);
  if (!tier || tier.low == null) {
    throw new Error(`难度档 ${tierKey}（${tier ? tier.name : '未知'}）没有可折算区间，不入库。`);
  }
  const oldSchema = dbm.getSetting('luogu_tier_schema', 0);
  if (oldSchema !== LUOGU_TIER_SCHEMA) {
    const old = dbm.db.prepare("SELECT COUNT(*) c FROM problems WHERE platform = 'luogu'").get().c;
    if (old > 0) {
      dbm.db.prepare("DELETE FROM problems WHERE platform = 'luogu'").run();
      console.log(`[luogu] 洛谷难度档位表已更新（schema ${oldSchema} → ${LUOGU_TIER_SCHEMA}），清空旧题库 ${old} 题`);
    }
    dbm.setSetting('luogu_tier_schema', LUOGU_TIER_SCHEMA);
  }
  const st = dbm.db.prepare(
    `INSERT INTO problems(platform, pid, name, rating, tags, url, source, solved_count, fetched_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, pid) DO UPDATE SET
       name = excluded.name, rating = excluded.rating, tags = excluded.tags,
       fetched_at = excluded.fetched_at`
  );
  let imported = 0;
  const totalPages = TIER_TOTAL_PAGES[tierKey] || 100;
  const n = Math.min(pages, totalPages);
  const pagesToFetch = [];
  for (let i = 0; i < n; i++) pagesToFetch.push(Math.floor((totalPages / n) * i) + 1);
  for (const page of pagesToFetch) {
    const html = await fetchPageText(`${BASE}/problem/list?page=${page}&difficulty=${tierKey}`);
    const problems = parseProblemsHtml(html);
    if (!problems.length) continue;
    dbm.db.exec('BEGIN');
    try {
      for (const p of problems) {
        if (!p.pid || !p.title) continue;
        const tags = p.tags.slice();
        tags.push(`tier:${tierKey}`);
        st.run('luogu', p.pid, p.title, luoguTierRating(tierKey), JSON.stringify(tags),
          `${BASE}/problem/${p.pid}`, `洛谷 ${tier.name}`, null,
          Math.floor(Date.now() / 1000));
        imported++;
      }
      dbm.db.exec('COMMIT');
    } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  }
  const counts = dbm.getSetting('luogu_tier_counts', {});
  counts[tierKey] = imported;
  dbm.setSetting('luogu_tier_counts', counts);
  dbm.checkpoint();
  return { imported, pages: pagesToFetch.length };
}

/**
 * 同步做题记录（需要 Cookie）。只标记“已做”，无时间信息不进热力图。
 * @returns {{passed: number, needLogin: boolean}}
 */
async function syncPassed(uid) {
  const cookie = getCookie();
  if (!cookie) {
    return { passed: 0, needLogin: true };
  }
  const passed = [];
  for (let page = 1; page <= 20; page++) {
    // 带登录 cookie：WAF 通常直接放行；即使弹挑战，fetchPageText 也会握手
    const text = await fetchPageText(`${BASE}/user/${uid}?page=${page}&_contentOnly=1`);
    let data = null;
    // 优先按 JSON 解析
    try { data = JSON.parse(text); } catch {}
    // 退而求其次：从 HTML 的 lentille-context script 标签提取
    if (!data) {
      const m = text.match(/<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/);
      if (m) { try { data = JSON.parse(m[1]); } catch {} }
    }
    if (!data) {
      throw new Error('无法解析洛谷用户页（可能是 Cookie 失效或页面结构变化）。');
    }
    // lentille-context 的数据在 data.data 下；旧 JSON API 在 data.currentData 下
    const cd = data.currentData || (data.data && data.data.currentData) || data.data || {};
    const list = cd.passedProblems || (cd.user && cd.user.passedProblems) || [];
    if (!Array.isArray(list) || !list.length) break;
    for (const p of list) {
      const pid = p.pid || p.problem || p.id;
      if (pid) passed.push({ pid: String(pid), title: p.title || p.name || '' });
    }
    const total = (cd.user && cd.user.passedProblemCount) || passed.length;
    if (passed.length >= total) break;
  }
  const st = dbm.db.prepare(
    'INSERT OR REPLACE INTO solved_marks(user, platform, pid, ts) VALUES(?, ?, ?, ?)'
  );
  dbm.db.exec('BEGIN');
  try {
    for (const p of passed) st.run(uid, 'luogu', p.pid, Math.floor(Date.now() / 1000));
    dbm.db.exec('COMMIT');
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return { passed: passed.length, needLogin: false };
}

module.exports = { importTier, syncPassed, getUpcomingContests, LUOGU_TIER };
