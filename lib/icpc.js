'use strict';
/**
 * lib/icpc.js — ICPC / CCPC 补题追踪
 * 内置一份赛事参考目录（站点/年份为公开信息，题数为各站常规题量参考值，
 * 以官方公布为准，界面支持增删改）。逐题状态来自本地记录：
 * 自动匹配（洛谷已做 / 手动标记），无法获取的提交不会被推断为 AC。
 */
const dbm = require('./db');

/** 内置参考目录（可编辑）。problem_count 为参考值：ICPC 区域赛 13 题、CCPC 区域赛 11~12 题。 */
const SEED = [
  // ---------- ICPC Asia（亚洲区域赛） ----------
  ['ICPC', 2024, '南京'], ['ICPC', 2024, '西安'], ['ICPC', 2024, '上海'], ['ICPC', 2024, '杭州'],
  ['ICPC', 2024, '济南'], ['ICPC', 2024, '沈阳'], ['ICPC', 2024, '合肥'], ['ICPC', 2024, '青岛'],
  ['ICPC', 2024, '成都'], ['ICPC', 2024, '昆明'], ['ICPC', 2024, '长春'], ['ICPC', 2024, '哈尔滨'],
  ['ICPC', 2024, '银川'], ['ICPC', 2024, '桂林'],
  ['ICPC', 2023, '南京'], ['ICPC', 2023, '西安'], ['ICPC', 2023, '上海'], ['ICPC', 2023, '杭州'],
  ['ICPC', 2023, '济南'], ['ICPC', 2023, '沈阳'], ['ICPC', 2023, '合肥'], ['ICPC', 2023, '青岛'],
  ['ICPC', 2023, '成都'], ['ICPC', 2023, '昆明'], ['ICPC', 2023, '南宁'], ['ICPC', 2023, '银川'],
  ['ICPC', 2023, '长春'], ['ICPC', 2023, '哈尔滨'], ['ICPC', 2023, '桂林'],
  ['ICPC', 2022, '南京'], ['ICPC', 2022, '西安'], ['ICPC', 2022, '上海'], ['ICPC', 2022, '杭州'],
  ['ICPC', 2022, '济南'], ['ICPC', 2022, '沈阳'], ['ICPC', 2022, '合肥'], ['ICPC', 2022, '青岛'],
  ['ICPC', 2022, '成都'], ['ICPC', 2022, '昆明'], ['ICPC', 2022, '银川'], ['ICPC', 2022, '桂林'],
  ['ICPC', 2021, '南京'], ['ICPC', 2021, '西安'], ['ICPC', 2021, '上海'], ['ICPC', 2021, '杭州'],
  ['ICPC', 2021, '济南'], ['ICPC', 2021, '沈阳'], ['ICPC', 2021, '合肥'], ['ICPC', 2021, '青岛'],
  ['ICPC', 2021, '成都'], ['ICPC', 2021, '昆明'], ['ICPC', 2021, '银川'], ['ICPC', 2021, '香港'],
  // ---------- CCPC（中国大学生程序设计竞赛） ----------
  ['CCPC', 2024, '哈尔滨'], ['CCPC', 2024, '重庆'], ['CCPC', 2024, '深圳'], ['CCPC', 2024, '郑州'],
  ['CCPC', 2024, '桂林'], ['CCPC', 2024, '济南'],
  ['CCPC', 2023, '哈尔滨'], ['CCPC', 2023, '重庆'], ['CCPC', 2023, '深圳'], ['CCPC', 2023, '郑州'],
  ['CCPC', 2023, '桂林'], ['CCPC', 2023, '秦皇岛'],
  ['CCPC', 2022, '广州'], ['CCPC', 2022, '威海'], ['CCPC', 2022, '桂林'], ['CCPC', 2022, '绵阳'],
  ['CCPC', 2022, '杭州'], ['CCPC', 2022, '深圳'], ['CCPC', 2022, '哈尔滨'], ['CCPC', 2022, '西安'],
  ['CCPC', 2021, '哈尔滨'], ['CCPC', 2021, '桂林'], ['CCPC', 2021, '威海'], ['CCPC', 2021, '广州'],
  // ---------- 综合（邀请赛 / 省赛示例，可按需编辑） ----------
  ['ICPC', 2024, '西安邀请赛'], ['CCPC', 2024, '哈尔滨邀请赛'],
];

const COUNTS = { ICPC: 13, CCPC: 12 };

function seedCatalog() {
  const n = dbm.db.prepare('SELECT COUNT(*) c FROM icpc_contests').get().c;
  if (n > 0) return { seeded: false };
  const st = dbm.db.prepare(
    'INSERT INTO icpc_contests(series, year, site, contest_name, date, problem_count) VALUES(?, ?, ?, ?, ?, ?)'
  );
  dbm.db.exec('BEGIN');
  try {
    for (const [series, year, site] of SEED) {
      const name = `${series} ${year} ${series === 'ICPC' ? '亚洲区域赛' : '全国赛'} · ${site}`;
      st.run(series, year, site, name, '', COUNTS[series] || 12);
    }
    dbm.db.exec('COMMIT');
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return { seeded: true, count: SEED.length };
}

function listContests({ series, year, site } = {}) {
  let sql = 'SELECT * FROM icpc_contests WHERE 1=1';
  const args = [];
  if (series) { sql += ' AND series = ?'; args.push(series); }
  if (year) { sql += ' AND year = ?'; args.push(year); }
  if (site) { sql += ' AND site LIKE ?'; args.push('%' + site + '%'); }
  sql += ' ORDER BY year DESC, site';
  return dbm.db.prepare(sql).all(...args).map((c) => ({
    ...c,
    problems: JSON.parse(c.problems || '[]'),
  }));
}

function getContest(id) {
  const c = dbm.db.prepare('SELECT * FROM icpc_contests WHERE id = ?').get(id);
  if (!c) return null;
  return { ...c, problems: JSON.parse(c.problems || '[]') };
}

function upsertContest({ id, series, year, site, contest_name, date, problem_count, link }) {
  if (id) {
    dbm.db.prepare(
      'UPDATE icpc_contests SET series = ?, year = ?, site = ?, contest_name = ?, date = ?, problem_count = ?, link = ? WHERE id = ?'
    ).run(series, year, site, contest_name, date || '', problem_count || COUNTS[series] || 12, link || '', id);
    return getContest(id);
  }
  const r = dbm.db.prepare(
    'INSERT INTO icpc_contests(series, year, site, contest_name, date, problem_count, link) VALUES(?, ?, ?, ?, ?, ?, ?)'
  ).run(series, year, site, contest_name, date || '', problem_count || COUNTS[series] || 12, link || '');
  return getContest(r.lastInsertRowid);
}

function deleteContest(id) {
  dbm.db.prepare('DELETE FROM icpc_contests WHERE id = ?').run(id);
  dbm.db.prepare('DELETE FROM icpc_progress WHERE contest_id = ?').run(id);
}

/** 在赛事下添加/更新题目（粘贴链接或直接写 pid） */
function setContestProblem(contestId, idx, problem) {
  const c = getContest(contestId);
  if (!c) return null;
  const problems = c.problems;
  const found = problems.find((p) => p.idx === idx);
  if (found) Object.assign(found, problem);
  else problems.push({ idx, ...problem });
  problems.sort((a, b) => String(a.idx).localeCompare(String(b.idx), 'en', { numeric: true }));
  dbm.db.prepare('UPDATE icpc_contests SET problems = ? WHERE id = ?').run(JSON.stringify(problems), contestId);
  return problems;
}

function setProgress(user, contestId, idx, status, note) {
  if (status === 'keep') {
    // 只更新笔记，保留原状态
    const existing = dbm.db.prepare(
      'SELECT status FROM icpc_progress WHERE user = ? AND contest_id = ? AND idx = ?'
    ).get(user, contestId, idx);
    status = existing ? existing.status : 'todo';
  }
  dbm.db.prepare(
    `INSERT INTO icpc_progress(user, contest_id, idx, status, note) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(user, contest_id, idx) DO UPDATE SET status = excluded.status, note = excluded.note`
  ).run(user, contestId, idx, status, note || '');
}

function progressOf(user, contestId) {
  const rows = dbm.db.prepare(
    'SELECT * FROM icpc_progress WHERE user = ? AND contest_id = ?').all(user, contestId);
  const map = {};
  for (const r of rows) map[r.idx] = r;
  return map;
}

function overallStats(user) {
  const rows = dbm.db.prepare(
    'SELECT icpc_contests.series, icpc_contests.year, icpc_progress.status, COUNT(*) c ' +
    'FROM icpc_progress JOIN icpc_contests ON icpc_progress.contest_id = icpc_contests.id ' +
    'WHERE icpc_progress.user = ? GROUP BY icpc_contests.series, icpc_contests.year, icpc_progress.status'
  ).all(user);
  return rows;
}

/** 识别题目链接 → {platform, pid}；识别不了的返回 null */
function parseProblemLink(text) {
  text = String(text || '').trim();
  const atcoder = text.match(/atcoder\.jp\/contests\/([a-zA-Z0-9_]+)\/tasks\/([a-zA-Z0-9_]+)/);
  if (atcoder) return { platform: 'atcoder', pid: atcoder[2], contestId: atcoder[1] };
  const luogu = text.match(/luogu\.com\.cn\/problem\/([A-Za-z0-9]+)/);
  if (luogu) return { platform: 'luogu', pid: luogu[1] };
  const cf = text.match(/codeforces\.com\/(?:problemset\/problem|contest\/(\d+)\/problem)\/(\d+)([A-Za-z0-9]+)?/);
  if (cf) {
    const cid = cf[1] || text.match(/contest\/(\d+)/)?.[1];
    const index = cf[2] || cf[3];
    if (cid && index) return { platform: 'codeforces', pid: `${cid}${index}` };
  }
  // 裸题号：CF "1234A"、洛谷 "P1000"、AtCoder "abc123_a"
  if (/^\d+[A-Za-z][0-9]?$/.test(text)) return { platform: 'codeforces', pid: text };
  if (/^P\d+$/.test(text)) return { platform: 'luogu', pid: text };
  if (/^[a-z]{3}\d+_[a-z0-9]+$/.test(text)) return { platform: 'atcoder', pid: text };
  return null;
}

function problemInfo(platform, pid) {
  // AtCoder 旧题用编号式 pid（abc001_1），官方链接用字母式（abc001_a）。
  // 直接查不到时，按 contest_id + problem_index 反向解析（兼容两种写法）。
  let row = dbm.db.prepare('SELECT * FROM problems WHERE platform = ? AND pid = ?').get(platform, pid);
  if (!row && platform === 'atcoder') {
    const m = String(pid || '').match(/^([a-z]{3}\d+)_([a-z0-9]+)$/);
    if (m) {
      row = dbm.db.prepare(
        `SELECT * FROM problems WHERE platform = ? AND contest_id = ? AND LOWER(problem_index) = ? LIMIT 1`
      ).get('atcoder', m[1], m[2].toLowerCase());
    }
  }
  return row;
}

module.exports = {
  SEED, seedCatalog, listContests, getContest, upsertContest, deleteContest,
  setContestProblem, setProgress, progressOf, overallStats, parseProblemLink, problemInfo,
};
