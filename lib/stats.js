'use strict';
/**
 * lib/stats.js — 统计口径
 * 生涯统计始终基于本地已知全部历史；当前范围只统计选中年或最近 365 天。
 * Solved：各平台内至少 AC 一次的不同题数之和，不跨 OJ 去重（提交记录按平台聚合，多账号求和）。
 * AC Submissions：数据源能取得的 Accepted submission 数量（洛谷无逐题记录，不计）。
 * Active Days / Streak / Peak：基于带时间戳的平台（CF / AtCoder）；洛谷无时间信息，不计。
 */
const dbm = require('./db');

function toLocalDate(sec) {
  const d = new Date(sec * 1000);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 各平台已 AC 的不同题 */
function solvedPids(platform) {
  const set = new Set();
  if (platform === 'luogu') {
    for (const r of dbm.db.prepare("SELECT pid FROM solved_marks WHERE platform = ? AND user = 'default'").all(platform)) set.add(r.pid);
  } else {
    const verdict = platform === 'codeforces' ? 'OK' : 'AC';
    for (const r of dbm.db.prepare(
      'SELECT DISTINCT pid FROM submissions WHERE platform = ? AND verdict = ?').all(platform, verdict)) set.add(r.pid);
  }
  return set;
}

function acceptedSubmissions(platform) {
  const verdict = platform === 'codeforces' ? 'OK' : 'AC';
  return dbm.db.prepare(
    'SELECT COUNT(*) c FROM submissions WHERE platform = ? AND verdict = ?'
  ).get(platform, verdict).c;
}

function getPlatformStats(platform) {
  const set = solvedPids(platform);
  const subRows = dbm.db.prepare(
    'SELECT ts, verdict FROM submissions WHERE platform = ? ORDER BY ts ASC'
  ).all(platform);

  const activeDates = new Set();
  const perDay = {};
  for (const s of subRows) {
    if (!s.ts) continue;
    const d = toLocalDate(s.ts);
    activeDates.add(d);
    perDay[d] = (perDay[d] || 0) + 1;
  }
  const sortedDates = [...activeDates].sort();
  let longest = 0, current = 0;
  const dsec = (dateStr) => Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
  for (let i = 0; i < sortedDates.length; i++) {
    if (i > 0 && dsec(sortedDates[i]) - dsec(sortedDates[i - 1]) === 86400) current++;
    else current = 1;
    longest = Math.max(longest, current);
  }
  // 当前连续：截至今天的连续活跃天数
  const today = toLocalDate(Math.floor(Date.now() / 1000));
  if (activeDates.has(today)) {
    current = 1;
    for (let k = 1; k < 366; k++) {
      const ds = toLocalDate(Math.floor(Date.now() / 1000) - k * 86400);
      if (activeDates.has(ds)) current++;
      else break;
    }
  } else current = 0;

  const peak = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0] || null;

  const ratingRows = dbm.db.prepare(
    'SELECT * FROM rating_history WHERE platform = ? ORDER BY ts ASC'
  ).all(platform);
  const currentRating = ratingRows.length ? ratingRows[ratingRows.length - 1].new_rating : null;
  const maxRating = ratingRows.length ? Math.max(...ratingRows.map((r) => r.new_rating)) : null;
  const lastChange = ratingRows.length ? {
    contest: ratingRows[ratingRows.length - 1].contest_name,
    old: ratingRows[ratingRows.length - 1].old_rating,
    new: ratingRows[ratingRows.length - 1].new_rating,
    ts: ratingRows[ratingRows.length - 1].ts,
  } : null;

  return {
    platform,
    solved: set.size,
    acSubmissions: platform === 'luogu' ? null : acceptedSubmissions(platform),
    activeDays: platform === 'luogu' ? null : activeDates.size,
    longestStreak: platform === 'luogu' ? null : longest,
    currentStreak: platform === 'luogu' ? null : current,
    peakDay: platform === 'luogu' ? null : (peak ? { date: peak[0], count: peak[1] } : null),
    currentRating, maxRating, lastChange,
  };
}

function getCareerStats() {
  const platforms = ['codeforces', 'atcoder', 'luogu'];
  const per = platforms.map((p) => getPlatformStats(p));
  const merged = {
    solved: per.reduce((s, x) => s + x.solved, 0),
    acSubmissions: per.reduce((s, x) => s + (x.acSubmissions || 0), 0),
    activeDays: per.reduce((s, x) => s + (x.activeDays || 0), 0),
    longestStreak: Math.max(...per.map((x) => x.longestStreak || 0)),
    currentStreak: Math.max(...per.map((x) => x.currentStreak || 0)),
    peakDay: null,
  };
  const peaks = per.filter((x) => x.peakDay).map((x) => x.peakDay);
  if (peaks.length) merged.peakDay = peaks.sort((a, b) => b.count - a.count)[0];
  return { per, merged };
}

/** 活动砖数据：{date, count}，按口径计算 */
function getActivity(range, mode, platform) {
  const platforms = platform && platform !== 'all' ? [platform] : ['codeforces', 'atcoder'];
  const now = Math.floor(Date.now() / 1000);
  let fromTs = 0;
  if (range === '365') fromTs = now - 365 * 86400;
  else if (range === 'year') {
    const d = new Date(); d.setMonth(0, 1); d.setHours(0, 0, 0, 0);
    fromTs = Math.floor(d.getTime() / 1000);
  }
  const dayMap = {};
  for (const pf of platforms) {
    const verdict = pf === 'codeforces' ? 'OK' : 'AC';
    if (mode === 'first-ac' || mode === 'unique-ac') {
      const rows = dbm.db.prepare(
        'SELECT pid, MIN(ts) minTs FROM submissions WHERE platform = ? AND verdict = ? AND ts >= ? GROUP BY pid'
      ).all(pf, verdict, fromTs);
      for (const r of rows) {
        const d = toLocalDate(r.minTs);
        dayMap[d] = (dayMap[d] || 0) + 1;
      }
    } else {
      const sql = 'SELECT ts FROM submissions WHERE platform = ? AND ts >= ?' +
        (mode === 'ac-sub' ? ' AND verdict = ?' : '');
      const args = mode === 'ac-sub' ? [pf, fromTs, verdict] : [pf, fromTs];
      const rows = dbm.db.prepare(sql).all(...args);
      for (const r of rows) {
        const d = toLocalDate(r.ts);
        dayMap[d] = (dayMap[d] || 0) + 1;
      }
    }
  }
  const out = [];
  for (const [date, count] of Object.entries(dayMap)) out.push({ date, count });
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function getRatingSeries(platform) {
  return dbm.db.prepare(
    'SELECT contest_id, contest_name, rank, old_rating, new_rating, ts FROM rating_history WHERE platform = ? ORDER BY ts ASC'
  ).all(platform);
}

function getRecentAC(platform, n = 20) {
  const verdict = platform === 'codeforces' ? 'OK' : 'AC';
  const rows = dbm.db.prepare(
    `SELECT s.*, p.name AS pname, p.tags AS ptags, p.url AS purl FROM submissions s
     LEFT JOIN problems p ON p.platform = s.platform AND p.pid = s.pid
     WHERE s.platform = ? AND s.verdict = ? AND s.ts IS NOT NULL
     ORDER BY s.ts DESC LIMIT ?`
  ).all(platform, verdict, n);
  return rows.map((r) => ({
    pid: r.pid, name: r.pname || r.name, rating: r.rating, ts: r.ts,
    contest_id: r.contest_id, lang: r.lang, url: r.purl || problemUrl(platform, r.pid),
    tags: JSON.parse(r.ptags || r.tags || '[]'),
  }));
}

function problemUrl(platform, pid) {
  if (platform === 'codeforces') {
    const m = pid.match(/^(\d+)([A-Za-z0-9]+)$/);
    return m ? `https://codeforces.com/problemset/problem/${m[1]}/${m[2]}` : '#';
  }
  if (platform === 'atcoder') {
    // 旧题 pid 为编号式（abc001_1），官方 URL 用字母式（abc001_a）；有库内数据时按字母式生成
    const row = dbm && dbm.db ? dbm.db.prepare('SELECT problem_index FROM problems WHERE platform = ? AND pid = ?').get('atcoder', pid) : null;
    const idx = row && row.problem_index ? row.problem_index.toLowerCase() : null;
    const task = idx ? `${contestOf(pid)}_${idx}` : pid;
    return `https://atcoder.jp/contests/${contestOf(pid)}/tasks/${task}`;
  }
  if (platform === 'luogu') return `https://www.luogu.com.cn/problem/${pid}`;
  return '#';
}

function contestOf(atcoderPid) {
  const m = atcoderPid.match(/^([a-z]+)(\d+)_/);
  return m ? `${m[1]}${m[2]}` : atcoderPid;
}

/** 难度直方图：保留平台自身难度体系，未识别难度归入「未评级」 */
function getDifficultyHistogram(platform) {
  const verdict = platform === 'codeforces' ? 'OK' : 'AC';
  const rows = dbm.db.prepare(
    `SELECT DISTINCT s.pid, s.rating FROM submissions s
     WHERE s.platform = ? AND s.verdict = ?`
  ).all(platform, verdict);
  const counts = {};
  for (const r of rows) {
    if (r.rating == null) { counts['未评级'] = (counts['未评级'] || 0) + 1; continue; }
    if (platform === 'codeforces') {
      const bucket = Math.floor(r.rating / 200) * 200;
      const key = `${bucket}-${bucket + 199}`;
      counts[key] = (counts[key] || 0) + 1;
    } else if (platform === 'atcoder') {
      const bucket = Math.floor(r.rating / 400) * 400;
      const key = `Diff ${bucket}-${bucket + 399}`;
      counts[key] = (counts[key] || 0) + 1;
    } else if (platform === 'luogu') {
      counts['已做（洛谷题量）'] = (counts['已做（洛谷题量）'] || 0) + 1;
    }
  }
  const isNum = (k) => !Number.isNaN(parseInt(k, 10));
  return Object.entries(counts).sort((a, b) => (isNum(a[0]) ? parseInt(a[0], 10) : 1e9) - (isNum(b[0]) ? parseInt(b[0], 10) : 1e9));
}

function syncStatusSummary() {
  const rows = dbm.db.prepare('SELECT * FROM sync_state ORDER BY platform, user').all();
  return rows.map((r) => ({
    platform: r.platform, user: r.user, cursor: r.cursor, last_sync: r.last_sync,
    status: r.status, error: r.error,
  }));
}

module.exports = {
  getCareerStats, getActivity, getRatingSeries, getRecentAC,
  getDifficultyHistogram, syncStatusSummary, toLocalDate, problemUrl,
};
