'use strict';
/**
 * lib/cf.js — Codeforces API 客户端
 * 遵守官方建议的 2 秒请求间隔（串行限速队列）；支持增量同步提交记录。
 */
const dbm = require('./db');

const BASE = 'https://codeforces.com/api/';
const UA = 'xcpc-trainer/0.1 (+local training assistant)';

// ---------- 全局串行限速队列（2s 间隔） ----------
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
    const wait = lastRequest + 2000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    try { resolve(await fn()); } catch (e) { reject(e); }
  }
  draining = false;
}

async function rawFetch(path, { retries = 2, anonymous = false } = {}) {
  return schedule(async () => {
    for (let attempt = 0; ; attempt++) {
      const headers = anonymous ? {} : { 'User-Agent': UA };
      const res = await fetch(BASE + path, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`CF API 返回非 JSON（HTTP ${res.status}）: ${path}`); }
      if (json.status === 'FAILED') {
        // 用户不存在等常见错误直接抛出，由上层展示
        throw new Error(`Codeforces 接口错误: ${json.comment || 'unknown'}`);
      }
      return json.result;
    }
  });
}

// ---------- 用户数据 ----------
async function getUserInfo(handle) {
  const r = await rawFetch(`user.info?handles=${encodeURIComponent(handle)}`);
  return r && r[0] ? r[0] : null;
}

async function syncRatingHistory(handle, platform = 'codeforces') {
  const r = await rawFetch(`user.rating?handle=${encodeURIComponent(handle)}`);
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
      st.run(platform, handle, String(c.contestId), c.contestName || '', c.rank || null,
        c.oldRating, c.newRating, c.ratingUpdateTimeSeconds || null);
    }
    dbm.db.exec('COMMIT');
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return r.length;
}

/**
 * 增量同步提交记录。CF 只支持 from/count 翻页，这里翻到“遇到已入库 id”即停。
 * @returns {{added:number, latestTs:number|null}}
 */
async function syncSubmissions(handle, platform = 'codeforces') {
  const st = dbm.db.prepare(
    `INSERT OR IGNORE INTO submissions(platform, user, sub_id, pid, name, rating, tags, verdict, ts, contest_id, lang)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0, from = 1, latestTs = null;
  for (;;) {
    const batch = await rawFetch(`user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=10000`);
    if (!batch || !batch.length) break;
    let known = 0;
    const checkKnown = dbm.db.prepare('SELECT 1 FROM submissions WHERE platform = ? AND user = ? AND sub_id = ?');
    dbm.db.exec('BEGIN');
    try {
      for (const s of batch) {
        const knownRow = checkKnown.get(platform, handle, String(s.id));
        if (knownRow) { known++; continue; }
        const pid = s.problem && s.problem.contestId != null
          ? `${s.problem.contestId}${s.problem.index || ''}` : (s.problem && s.problem.problemsetName ? s.problem.index : null);
        if (!pid) continue;
        st.run(platform, handle, String(s.id), pid,
          (s.problem && s.problem.name) || '',
          s.problem && s.problem.rating != null ? s.problem.rating : null,
          JSON.stringify((s.problem && s.problem.tags) || []),
          s.verdict || '', s.creationTimeSeconds || null,
          s.problem && s.problem.contestId != null ? String(s.problem.contestId) : '',
          s.programmingLanguage || '');
        added++;
        if (s.creationTimeSeconds) latestTs = Math.max(latestTs || 0, s.creationTimeSeconds);
      }
      dbm.db.exec('COMMIT');
    } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }

    if (batch.length < 10000 || known > 0) break;   // 遇到已同步过的提交即停止
    from += 10000;
  }
  return { added, latestTs };
}

// ---------- 题库 ----------
/** 全量题库（约 3500 题），本地缓存，TTL 默认 7 天 */
async function syncProblemset(platform = 'codeforces', ttlDays = 7) {
  const last = dbm.getSetting('problems_last_sync_cf', 0);
  if (last && Date.now() - last < ttlDays * 86400000) return { cached: true, count: countProblems(platform) };

  const r = await rawFetch('problemset.problems');
  const st = dbm.db.prepare(
    `INSERT INTO problems(platform, pid, name, rating, tags, url, source, solved_count, fetched_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, pid) DO UPDATE SET
       name = excluded.name, rating = excluded.rating, tags = excluded.tags,
       solved_count = excluded.solved_count, fetched_at = excluded.fetched_at`
  );
  dbm.db.exec('BEGIN');
  try {
    for (const p of r.problems || []) {
      if (p.contestId == null || !p.index) continue;
      const pid = `${p.contestId}${p.index}`;
      st.run(platform, pid, p.name || '', p.rating != null ? p.rating : null,
        JSON.stringify(p.tags || []),
        `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}`,
        `CF ${p.contestId}`, r.problemStatistics ? (r.problemStatistics.find((s) => s.contestId === p.contestId && s.index === p.index) || {}).solvedCount : null,
        Math.floor(Date.now() / 1000));
    }
    dbm.db.exec('COMMIT');
    dbm.setSetting('problems_last_sync_cf', Date.now());
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return { cached: false, count: countProblems(platform) };
}

function countProblems(platform) {
  return dbm.db.prepare('SELECT COUNT(*) c FROM problems WHERE platform = ?').get(platform).c;
}

// ---------- 比赛 ----------
let contestCache = { ts: 0, data: null };
async function getContests(force = false) {
  if (!force && contestCache.data && Date.now() - contestCache.ts < 3600000) return contestCache.data;
  const r = await rawFetch('contest.list?gym=false');
  contestCache = { ts: Date.now(), data: r };
  return r;
}

/** 某场正式比赛的题目列表（匿名 standings：只能带 contestId，无任何额外参数） */
async function getContestProblems(contestId) {
  const r = await rawFetch(`contest.standings?contestId=${contestId}`, { anonymous: true });
  return { problems: r.problems || [], contest: r.contest };
}

/** 时间窗口内本场比赛的提交（用户） */
async function getContestSubmissions(handle, contestId, fromTs, toTs) {
  // 直接复用全量增量同步逻辑不可行（只拉窗口），这里按需拉取并过滤
  const all = await fetchAllSubmissions(handle);
  return all.filter((s) =>
    s.contest_id === String(contestId) &&
    (!fromTs || s.ts >= fromTs) && (!toTs || s.ts <= toTs));
}

/** 拉取全部提交并入库（供复盘窗口过滤） */
async function fetchAllSubmissions(handle, platform = 'codeforces') {
  await syncSubmissions(handle, platform);
  return dbm.db.prepare(
    'SELECT * FROM submissions WHERE platform = ? AND user = ? ORDER BY ts ASC'
  ).all(platform, handle);
}

module.exports = {
  rawFetch, getUserInfo, syncRatingHistory, syncSubmissions,
  syncProblemset, countProblems, getContests, getContestProblems, getContestSubmissions, fetchAllSubmissions,
};
