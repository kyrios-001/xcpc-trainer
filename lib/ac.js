'use strict';
/**
 * lib/ac.js — AtCoder 客户端
 * 题目/难度来自 Kenkoooo AtCoder Problems 公开接口；赛程抓官方比赛页表格。
 * 说明：Kenkoooo 难度（IRT 估计）量级比 CF rating 低，统一 +200 折算为练习区间分值。
 */
const dbm = require('./db');

const KENKOOO = 'https://kenkoooo.com/atcoder/';
const ATCODER = 'https://atcoder.jp/';
const UA = 'xcpc-trainer/0.1 (+local training assistant)';

// ---------- 1s 串行限速队列 ----------
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
    const wait = lastRequest + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    try { resolve(await fn()); } catch (e) { reject(e); }
  }
  draining = false;
}

async function jsonFetch(url, { retries = 2 } = {}) {
  return schedule(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`AtCoder/Kenkoooo 请求失败（HTTP ${res.status}）: ${url}`);
      return await res.json();
    }
  });
}

async function htmlFetch(url) {
  return schedule(async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`AtCoder 页面请求失败（HTTP ${res.status}）: ${url}`);
    return await res.text();
  });
}

// ---------- 题目元数据缓存（problems.json + problem-models.json） ----------
async function ensureProblemCatalog(force = false) {
  const last = dbm.getSetting('ac_catalog_ts', 0);
  const schema = dbm.getSetting('ac_catalog_schema', 1);
  if (!force && schema === 2 && last && Date.now() - last < 7 * 86400000) return;

  const [problems, models] = await Promise.all([
    jsonFetch(KENKOOO + 'resources/problems.json'),
    jsonFetch(KENKOOO + 'resources/problem-models.json'),
  ]);
  const st = dbm.db.prepare(
    `INSERT INTO problems(platform, pid, name, rating, tags, url, source, solved_count, fetched_at, contest_id, problem_index)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, pid) DO UPDATE SET
       name = excluded.name, rating = excluded.rating, tags = excluded.tags,
       url = excluded.url, source = excluded.source, fetched_at = excluded.fetched_at,
       contest_id = excluded.contest_id, problem_index = excluded.problem_index`
  );
  dbm.db.exec('BEGIN');
  try {
    for (const p of problems || []) {
      const model = models[p.id];
      // 存 Kenkoooo 原始难度；跨平台使用时 +200 折算（在 plan/knowledge 层处理）
      const rating = model && typeof model.difficulty === 'number' ? Math.round(model.difficulty) : null;
      // 官方题面 URL 用字母式（abc001_a）；旧题 catalog 里是编号式（abc001_1），有 problem_index 时转换
      const taskId = p.problem_index ? `${p.contest_id}_${String(p.problem_index).toLowerCase()}` : p.id;
      st.run('atcoder', p.id, p.title || p.name || p.id, rating, JSON.stringify([]),
        `${ATCODER}contests/${p.contest_id}/tasks/${taskId}`, `AC ${p.contest_id}`, null,
        Math.floor(Date.now() / 1000), p.contest_id || '', p.problem_index || '');
    }
    dbm.db.exec('COMMIT');
    dbm.setSetting('ac_catalog_ts', Date.now());
    dbm.setSetting('ac_catalog_schema', 2);
    dbm.setSetting('ac_catalog_count', (problems || []).length);
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
}

function getProblemInfo(pid) {
  return dbm.db.prepare('SELECT * FROM problems WHERE platform = ? AND pid = ?').get('atcoder', pid);
}

// ---------- 用户数据 ----------
/** 增量同步提交（from_seconds 游标），返回 {added, cursor} */
async function syncSubmissions(user, platform = 'atcoder') {
  await ensureProblemCatalog();
  let cursor = 0;
  const state = dbm.getSyncState(platform, user);
  if (state.cursor) cursor = parseInt(state.cursor, 10) || 0;

  const st = dbm.db.prepare(
    `INSERT OR IGNORE INTO submissions(platform, user, sub_id, pid, name, rating, tags, verdict, ts, contest_id, lang)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0, maxTs = cursor;
  // 一次最多拉 500 条窗口；返回满量则继续（参数为 from_second，单数）
  for (;;) {
    const batch = await jsonFetch(`${KENKOOO}atcoder-api/v3/user/submissions?user=${encodeURIComponent(user)}&from_second=${cursor}`);
    if (!batch || !batch.length) break;
    dbm.db.exec('BEGIN');
    try {
      for (const s of batch) {
        const info = getProblemInfo(s.problem_id);
        st.run(platform, user, String(s.id), s.problem_id,
          (info && info.name) || s.problem_id,
          info && info.rating != null ? info.rating : null,
          '[]', s.result || '', s.epoch_second || null,
          s.contest_id || '', s.language || '');
        if (s.epoch_second > maxTs) maxTs = s.epoch_second;
      }
      dbm.db.exec('COMMIT');
    } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
    added += batch.length;
    if (batch.length < 500) break;   // 单次返回不足一页即结束
    cursor = maxTs;
  }
  return { added, cursor: maxTs };
}

async function syncRatingHistory(user, platform = 'atcoder') {
  // Kenkoooo v3 rating_history 已失效，改用 AtCoder 官方 JSON 端点（公开，无需登录）
  const r = await jsonFetch(`${ATCODER}users/${encodeURIComponent(user)}/history/json`);
  const st = dbm.db.prepare(
    `INSERT INTO rating_history(platform, user, contest_id, contest_name, rank, old_rating, new_rating, ts)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, user, contest_id) DO UPDATE SET
       contest_name = excluded.contest_name, rank = excluded.rank,
       old_rating = excluded.old_rating, new_rating = excluded.new_rating, ts = excluded.ts`
  );
  dbm.db.exec('BEGIN');
  try {
    for (const c of r || []) {
      const cid = String(c.ContestScreenName || '').replace(/\.contest\.atcoder\.jp$/, '');
      if (!cid) continue;
      st.run(platform, user, cid, c.ContestName || '',
        c.Place || null, c.OldRating, c.NewRating,
        c.EndTime ? Math.floor(new Date(c.EndTime).getTime() / 1000) : null);
    }
    dbm.db.exec('COMMIT');
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return r.length;
}

// ---------- 赛程（官方比赛页表格） ----------
/** Kenkoooo 历史比赛目录（contests.json 只有过去的比赛，用作 VP 候选池） */
async function getPastContests() {
  const r = await jsonFetch(KENKOOO + 'resources/contests.json');
  return Array.isArray(r) ? r : [];
}

async function getUpcomingContests() {
  const html = await htmlFetch(ATCODER + 'contests/');
  const out = [];
  const m = html.match(/<div id="contest-table-upcoming"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  const section = (m && m[1]) || html;
  // 每行：time datetime + <a href="/contests/xxx">name</a> + rated range 单元格
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rm;
  while ((rm = rowRe.exec(section)) !== null) {
    const row = rm[1];
    if (!/<a href="\/contests\//.test(row)) continue;
    const timeM = row.match(/fixtime[^>]*>([^<]+)<\/time>/);
    const linkM = row.match(/<a href="\/contests\/([a-zA-Z0-9_]+)">([^<]+)<\/a>/);
    if (!timeM || !linkM) continue;
    const cells = row.split(/<\/td>/).map((c) => c.replace(/<[^>]+>/g, '').trim());
    // 跳过时间列：只从 Duration/Rated 单元格里找计分区间
    const rated = cells.slice(1).find((c) => /^\s*[~\-]?\s*\d{3,4}|全员|全員/.test(c)) || '';
    out.push({
      id: linkM[1], name: linkM[2], start: timeM[1].replace(' ', 'T'),
      rated: rated.replace(/\s+/g, ' '),
      url: ATCODER + 'contests/' + linkM[1],
    });
  }
  return out;
}

// ---------- 比赛题目与提交 ----------
async function getContestTasks(contestId) {
  await ensureProblemCatalog();
  const html = await htmlFetch(`${ATCODER}contests/${contestId}/tasks`);
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const row = rm[1];
    const linkM = row.match(/<a href="\/contests\/[^/]+\/tasks\/([a-zA-Z0-9_]+)">([^<]+)<\/a>/);
    if (!linkM) continue;
    const idx = row.match(/<td[^>]*>\s*([A-Za-z0-9]+)\s*<\/td>/);
    const info = getProblemInfo(linkM[1]);
    out.push({
      id: linkM[1], index: (idx && idx[1]) || '', title: linkM[2],
      rating: info && info.rating != null ? info.rating : null,
      url: `${ATCODER}contests/${contestId}/tasks/${linkM[1]}`,
    });
  }
  return out;
}

async function getContestSubmissions(user, contestId, fromTs, toTs) {
  // 拉全量并过滤窗口（增量已入库）
  await syncSubmissions(user);
  return dbm.db.prepare(
    'SELECT * FROM submissions WHERE platform = ? AND user = ? AND contest_id = ? ORDER BY ts ASC'
  ).all('atcoder', user, contestId).filter((s) =>
    (!fromTs || s.ts >= fromTs) && (!toTs || s.ts <= toTs));
}

module.exports = {
  ensureProblemCatalog, syncSubmissions, syncRatingHistory,
  getUpcomingContests, getContestTasks, getContestSubmissions, getProblemInfo,
};
