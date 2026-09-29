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
    try {
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
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error('请求洛谷超时（20 秒）。可能是洛谷限流或网络波动，请稍后重试。');
      }
      if (e.name === 'TypeError' && /fetch failed/i.test(e.message || '')) {
        throw new Error('无法连接洛谷（网络受限或洛谷反爬拦截）。抓取题库无需登录；同步做题记录需在设置中填写 Cookie。');
      }
      throw e;
    }
  });
}

/**
 * 洛谷比赛日历（未来 14 天）：列表页第一页包含最近的未开始/进行中比赛。
 * 上游 JSON 字段不稳定，采用防御式多字段解析，解析不到的比赛直接跳过。
 * @returns {Array<{platform,id,name,start,duration,type}>}
 */
async function getUpcomingContests(days = 14) {
  const data = await request(`${BASE}/contest/list?page=1&_contentOnly=1`);
  const list = (data && data.currentData && (data.currentData.contests || data.currentData.contestList)) || [];
  const now = Date.now();
  const horizon = now + days * 24 * 3600 * 1000;
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = c.id || c.contestId || c.cid;
    const name = c.name || c.title || c.contestName;
    if (id == null || !name) continue;
    let start = c.startTime ?? c.start_time ?? c.start ?? c.begin ?? c.beginTime;
    let end = c.endTime ?? c.end_time ?? c.end;
    if (typeof start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(start)) {
      start = new Date(start.replace(' ', 'T') + (start.includes('+') ? '' : '+08:00')).getTime();
      if (Number.isNaN(start)) start = null;
    } else if (typeof start === 'number' && start < 1e12) {
      start *= 1000; // 秒 → 毫秒
    }
    if (typeof end === 'string' && /^\d{4}-\d{2}-\d{2}/.test(end)) {
      end = new Date(end.replace(' ', 'T') + (end.includes('+') ? '' : '+08:00')).getTime();
      if (Number.isNaN(end)) end = null;
    } else if (typeof end === 'number' && end != null && end < 1e12) {
      end *= 1000;
    }
    if (start == null || start < now - 3600 * 1000 || start > horizon) continue;
    out.push({
      platform: 'luogu', id: String(id), name,
      start: Math.floor(start / 1000), duration: null,
      type: String(c.type || c.contestType || c.rated != null ? (c.rated ? '计分' : '不计分') : ''),
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
  // 档位 key 0（暂无评定）不入库
  const tier = LUOGU_TIER.find((x) => x.key === tierKey);
  if (!tier || tier.low == null) {
    throw new Error(`难度档 ${tierKey}（${tier ? tier.name : '未知'}）没有可折算区间，不入库。`);
  }
  // 档位表 schema 变更 → 清空旧洛谷题库重抓（做题标记 solved_marks 不受影响）
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
  let inserted = 0, imported = 0;
  const totalPages = TIER_TOTAL_PAGES[tierKey] || 100;
  const n = Math.min(pages, totalPages);
  // 等距抽页，避免默认排序下前几页全是老题；超过实际总页数的页码会返回空页（continue 跳过）
  const pagesToFetch = [];
  for (let i = 0; i < n; i++) {
    pagesToFetch.push(Math.floor((totalPages / n) * i) + 1);
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

module.exports = { importTier, syncPassed, getUpcomingContests, LUOGU_TIER };
