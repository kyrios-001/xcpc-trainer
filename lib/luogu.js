'use strict';
/**
 * lib/luogu.js — 洛谷客户端
 * 题目列表页公开可抓（按难度档入库）；个人做题记录需要登录 Cookie（可选，安全降级）。
 * 洛谷不提供逐题难度与提交时间：
 *   - 难度按官方档位折算为练习分（估计值，鼠标悬停可看真实档位）；
 *   - 做题记录无时间信息，只用于“已做”标记与统计题量，不进热力图。
 */
const dbm = require('./db');
const { LUOGU_TIER, luoguTierRating, LUOGU_TAG_MAP, luoguTierName } = require('./knowledge');

const BASE = 'https://www.luogu.com.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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
    const cookie = getCookie();
    const headers = { 'User-Agent': UA };
    if (cookie) headers.Cookie = cookie;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      if (!json) return text;
      try { return JSON.parse(text); } catch {
        // 部分页面把 JSON 包在 window._feInjection 里
        const m = text.match(/window\._feInjection\s*=\s*JSON\.parse\(\s*(?:decodeURIComponent\()?"([^"]+)"\)?/);
        if (m) return JSON.parse(decodeURIComponent(m[1]));
        throw new Error(`洛谷返回非 JSON（HTTP ${res.status}）`);
      }
    }
  });
}

/**
 * 按难度档导入题库：每档等距抽 8 页（约 400 题）。
 * 入库按难度档替换式增量：先抓 A 档、再抓 B 档，A 档不会被清掉。
 * @returns {{tiers: Record<number, number>}}
 */
async function importTier(tierKey, pages = 8) {
  const st = dbm.db.prepare(
    `INSERT INTO problems(platform, pid, name, rating, tags, url, source, solved_count, fetched_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, pid) DO UPDATE SET
       name = excluded.name, rating = excluded.rating, tags = excluded.tags,
       fetched_at = excluded.fetched_at`
  );
  let inserted = 0, imported = 0;
  const totalPages = 100;
  // 等距抽页，避免默认排序下前几页全是老题
  const pagesToFetch = [];
  for (let i = 0; i < pages; i++) {
    pagesToFetch.push(Math.floor((totalPages / pages) * i) + 1);
  }
  for (const page of pagesToFetch) {
    const data = await request(`${BASE}/problem/list?page=${page}&difficulty=${tierKey}&_contentOnly=1`);
    const problems = data && data.currentData && data.currentData.problems;
    if (!problems || !problems.length) continue;
    dbm.db.exec('BEGIN');
    try {
      for (const p of problems) {
        if (!p.pid || !p.title) continue;
        const tags = [];
        if (Array.isArray(p.tags)) {
          for (const t of p.tags) {
            if (t && typeof t === 'object' && t.name) tags.push(t.name);
            else if (typeof t === 'string') tags.push(t);
            else if (typeof t === 'number') tags.push(String(t)); // tag id，无字典则跳过映射
          }
        }
        tags.push(`tier:${tierKey}`);
        st.run('luogu', p.pid, p.title, luoguTierRating(tierKey), JSON.stringify(tags),
          `${BASE}/problem/${p.pid}`, `洛谷 难度${luoguTierName(tierKey)}`, null,
          Math.floor(Date.now() / 1000));
        imported++;
      }
      dbm.db.exec('COMMIT');
    } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
    inserted += problems.length;
  }
  // 记录各档已抓数量
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
  const passed = [];
  let page = 1;
  for (;;) {
    const data = await request(`${BASE}/user/${uid}?page=${page}&_contentOnly=1`);
    if (data && data.code === 200 && data.currentData) {
      const list = (data.currentData.passedProblems) || [];
      for (const p of list) {
        if (p.pid) passed.push({ pid: p.pid, title: p.title || '' });
      }
      const total = (data.currentData.user && data.currentData.user.passedProblemCount) || 0;
      if (!list.length || passed.length >= total || page >= 100) break;
      page++;
    } else if (data && data.code === 400) {
      // 需要登录
      return { passed: 0, needLogin: true, raw: passed.length };
    } else {
      break;
    }
  }
  const st = dbm.db.prepare(
    'INSERT OR REPLACE INTO solved_marks(user, platform, pid, ts) VALUES(?, ?, ?, ?)'
  );
  dbm.db.exec('BEGIN');
  try {
    for (const p of passed) st.run(uid, 'luogu', p.pid, Math.floor(Date.now() / 1000));
    dbm.db.exec('COMMIT');
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return { passed: passed.length, needLogin: !cookie };
}

module.exports = { importTier, syncPassed, LUOGU_TIER };
