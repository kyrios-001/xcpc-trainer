'use strict';
/**
 * lib/contests.js — 比赛日历 / 虚拟参赛 / 赛后复盘
 * 复盘口径：本地拉取比赛时间窗口内的提交计算，无法获取的错误提交不会被推断。
 * 难度加权分 = 各题难度之和（用于横向比较自己的成长，不是 CF 官方 rating）。
 */
const dbm = require('./db');
const cf = require('./cf');
const ac = require('./ac');
const luogu = require('./luogu');
const { makeZip } = require('./zip');
const { currentBaseRating } = require('./plan');
const { toLocalDate } = require('./stats');

function suitLabel(low, high, base) {
  if (base == null) return '未知';
  if (high != null && base > high + 100) return '偏简单';
  if (low != null && base < low - 100) return '偏难';
  return '正合适';
}

/** 未来赛程（CF + AtCoder + 洛谷），含适合度标注 */
async function getCalendar(days = 14, platform = 'all') {
  const now = Date.now() / 1000;
  const until = now + days * 86400;
  const base = currentBaseRating();
  const out = [];

  if (platform === 'all' || platform === 'codeforces') {
    try {
      const contests = await cf.getContests();
      for (const c of contests) {
        if (c.phase !== 'BEFORE') continue;
        if (c.startTimeSeconds < now || c.startTimeSeconds > until) continue;
        let low = null, high = null;
        const name = c.name || '';
        if (/Div\. 1/.test(name)) { low = 1900; high = null; }
        else if (/Div\. 2/.test(name)) { low = 1200; high = 2100; }
        else if (/Div\. 3/.test(name)) { low = 800; high = 1600; }
        else if (/Div\. 4/.test(name)) { low = 800; high = 1400; }
        else if (/Educational/.test(name)) { low = 800; high = 2200; }
        out.push({
          platform: 'codeforces', id: String(c.id), name, start: c.startTimeSeconds,
          duration: c.durationSeconds, url: `https://codeforces.com/contest/${c.id}`,
          band: low != null ? `${low ?? '-'}~${high ?? '+'}` : '', suit: suitLabel(low, high, base),
        });
      }
    } catch (e) { out.push({ platform: 'codeforces', error: e.message }); }
  }

  if (platform === 'all' || platform === 'atcoder') {
    try {
      const contests = await ac.getUpcomingContests();
      for (const c of contests) {
        const start = Math.floor(new Date(c.start).getTime() / 1000);
        if (start < now || start > until) continue;
        const rated = c.rated || '';
        let low = null, high = null;
        const up = rated.match(/[-~]\s*(\d{3,4})\s*$/);       // "- 1999" → high=1999
        const lo = rated.match(/^\s*(\d{3,4})\s*[-~]/);       // "1200 ~ 2799" → low=1200
        if (up) high = +up[1];
        if (lo) low = +lo[1];
        if (rated.includes('全员') || rated.includes('All')) { low = 0; high = null; }
        out.push({
          platform: 'atcoder', id: c.id, name: c.name, start, duration: null,
          url: c.url, band: rated, suit: suitLabel(low, high, base),
        });
      }
    } catch (e) { out.push({ platform: 'atcoder', error: e.message }); }
  }

  if (platform === 'all' || platform === 'luogu') {
    try {
      const contests = await luogu.getUpcomingContests(days);
      for (const c of contests) {
        out.push({
          platform: 'luogu', id: c.id, name: c.name, start: c.start, duration: c.duration,
          url: 'https://www.luogu.com.cn/contest/' + c.id,
          band: c.type || '', suit: suitLabel(null, null, base),
        });
      }
    } catch (e) { out.push({ platform: 'luogu', error: e.message }); }
  }
  out.sort((a, b) => (a.start || 0) - (b.start || 0));
  return out;
}

/** 适合虚拟参赛的已结束比赛 */
async function recommendVP(limit = 30) {
  const base = currentBaseRating();
  const out = [];
  const now = Date.now() / 1000;
  try {
    const contests = await cf.getContests();
    const candidates = (contests || [])
      .filter((c) => c.phase === 'FINISHED' && c.startTimeSeconds > now - 180 * 86400)
      .sort((a, b) => b.startTimeSeconds - a.startTimeSeconds)
      .slice(0, limit);
    for (const c of candidates) {
      let low = null, high = null;
      const name = c.name || '';
      if (/Div\. 1/.test(name)) { low = 1900; high = null; }
      else if (/Div\. 2/.test(name)) { low = 1200; high = 2100; }
      else if (/Div\. 3/.test(name)) { low = 800; high = 1600; }
      else if (/Div\. 4/.test(name)) { low = 800; high = 1400; }
      else if (/Educational/.test(name)) { low = 800; high = 2200; }
      out.push({
        platform: 'codeforces', id: String(c.id), name, start: c.startTimeSeconds,
        url: `https://codeforces.com/contest/${c.id}`, suit: suitLabel(low, high, base), band: low != null ? `${low ?? '-'}~${high ?? '+'}` : '',
      });
    }
  } catch (e) { out.push({ platform: 'codeforces', error: e.message }); }
  try {
    const past = await ac.getPastContests();
    const candidates = (past || [])
      .filter((c) => c.start_epoch_second > now - 180 * 86400)
      .sort((a, b) => b.start_epoch_second - a.start_epoch_second)
      .slice(0, limit);
    for (const c of candidates) {
      const rated = c.rate_change || '';
      let low = null, high = null;
      const m = rated.match(/(\d{3,4})\s*~\s*(\d{3,4})/);
      if (m) { low = +m[1]; high = +m[2]; }
      else if (/~(\d{3,4})/.test(rated)) { high = +rated.match(/~(\d{3,4})/)[1]; }
      else if (rated.includes('All')) { low = 0; high = null; }
      out.push({
        platform: 'atcoder', id: c.id, name: c.title || c.id, start: c.start_epoch_second,
        url: `https://atcoder.jp/contests/${c.id}`, suit: suitLabel(low, high, base), band: rated,
      });
    }
  } catch (e) { out.push({ platform: 'atcoder', error: e.message }); }
  out.sort((a, b) => (b.start || 0) - (a.start || 0));
  return out;
}

/** 开始虚拟赛：预取题目列表，创建 session */
async function startVP(user, { platform, contest_id, countdown = 0 }) {
  let problems = [];
  let contestMeta = {};
  if (platform === 'codeforces') {
    const r = await cf.getContestProblems(contest_id);
    problems = (r.problems || []).map((p, i) => ({
      index: p.index, pid: `${p.contestId}${p.index}`, name: p.name, rating: p.rating ?? null, url: `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}`,
    }));
    contestMeta = { name: r.contest.name, type: r.contest.type, duration: r.contest.durationSeconds };
  } else if (platform === 'atcoder') {
    problems = await ac.getContestTasks(contest_id);
    contestMeta = { name: problems.length ? `${contest_id}` : contest_id };
  }
  if (!problems.length) throw new Error('未能获取该场比赛的题目列表（比赛不存在或接口受限）');

  const startTs = Math.floor(Date.now() / 1000);
  const r = dbm.db.prepare(
    `INSERT INTO virtual_sessions(user, name, platform, contest_id, contest, start_ts, end_ts, status, notes, problem_notes, created_at)
     VALUES(?, ?, ?, ?, ?, ?, NULL, 'countdown', '', '{}', ?)`
  ).run(user, contestMeta.name || contest_id, platform, String(contest_id),
    JSON.stringify({ ...contestMeta, problems, countdown, contestStart: startTs + countdown }),
    startTs, startTs);
  return getSession(r.lastInsertRowid);
}

function getSession(id) {
  const s = dbm.db.prepare('SELECT * FROM virtual_sessions WHERE id = ?').get(id);
  if (!s) return null;
  return {
    ...s,
    contest: JSON.parse(s.contest || '{}'),
    problem_notes: JSON.parse(s.problem_notes || '{}'),
  };
}

function listSessions(user) {
  return dbm.db.prepare('SELECT * FROM virtual_sessions WHERE user = ? ORDER BY id DESC').all(user)
    .map((s) => ({ ...s, contest: JSON.parse(s.contest || '{}') }));
}

function sessionTiming(s) {
  const c = s.contest || {};
  const contestStart = c.contestStart || s.start_ts + (c.countdown || 0);
  const pausedAccum = c.pausedAccum || 0;
  const now = Math.floor(Date.now() / 1000);
  let elapsed = null, remaining = null, paused = false;
  if (s.status === 'countdown') {
    remaining = Math.max(0, contestStart - now);
    if (remaining === 0 && contestStart <= now) { /* 前端翻转为 running */ }
  } else if (s.status === 'running') {
    let acc = pausedAccum;
    if (c.pauseStart) { acc += now - c.pauseStart; paused = true; }
    elapsed = Math.max(0, now - contestStart - acc);
  } else if (s.status === 'finished') {
    elapsed = Math.max(0, (s.end_ts || now) - contestStart - pausedAccum);
  }
  return { contestStart, elapsed, remaining, paused };
}

function pauseVP(id, pause) {
  const s = getSession(id);
  if (!s) return null;
  const c = s.contest || {};
  if (pause) {
    if (c.pauseStart) return s;
    c.pauseStart = Math.floor(Date.now() / 1000);
  } else {
    if (!c.pauseStart) return s;
    c.pausedAccum = (c.pausedAccum || 0) + Math.floor(Date.now() / 1000) - c.pauseStart;
    delete c.pauseStart;
  }
  dbm.db.prepare('UPDATE virtual_sessions SET contest = ? WHERE id = ?').run(JSON.stringify(c), id);
  return getSession(id);
}

function setVPNotes(id, notes) {
  dbm.db.prepare('UPDATE virtual_sessions SET notes = ? WHERE id = ?').run(notes || '', id);
  return getSession(id);
}
function setVPProblemNote(id, pid, { note, code, filename }) {
  const s = getSession(id);
  if (!s) return null;
  const notes = s.problem_notes || {};
  notes[pid] = { ...(notes[pid] || {}), ...(note !== undefined ? { note } : {}), ...(code !== undefined ? { code, filename } : {}) };
  dbm.db.prepare('UPDATE virtual_sessions SET problem_notes = ? WHERE id = ?').run(JSON.stringify(notes), id);
  return getSession(id);
}

/** 刷新赛内状态：拉取窗口内提交并计算 */
async function refreshSession(id) {
  const s = getSession(id);
  if (!s) return s;
  const t = sessionTiming(s);
  const user = s.user;
  try {
    if (s.platform === 'codeforces') await cf.syncSubmissions(user);
    else await ac.syncSubmissions(user);
  } catch (e) { /* 同步失败保留旧数据 */ }
  const verdict = s.platform === 'codeforces' ? 'OK' : 'AC';
  const subs = dbm.db.prepare(
    `SELECT * FROM submissions WHERE platform = ? AND user = ? AND contest_id = ? AND ts >= ? ORDER BY ts ASC`
  ).all(s.platform, user, s.contest_id, t.contestStart);
  const review = buildReview(s, subs, verdict, t);
  return { ...s, timing: t, review };
}

function buildReview(s, subs, verdict, t) {
  const problems = (s.contest && s.contest.problems) || [];
  const per = {};
  for (const p of problems) per[p.pid] = {
    index: p.index, name: p.name, rating: p.rating, url: p.url,
    attempts: 0, ac: false, first_ac_sec: null, last_verdict: '', last_ts: null,
  };
  for (const sub of subs) {
    const q = per[sub.pid];
    if (!q) continue;
    q.attempts++;
    q.last_verdict = sub.verdict;
    q.last_ts = sub.ts;
    if (sub.verdict === verdict && !q.ac) {
      q.ac = true;
      q.first_ac_sec = Math.max(0, sub.ts - t.contestStart);
    }
  }
  let solved = 0, weighted = 0, firstACTotal = 0;
  for (const q of Object.values(per)) {
    if (q.ac) {
      solved++;
      weighted += q.rating || 0;
      firstACTotal += q.first_ac_sec;
    }
  }
  const list = Object.values(per).sort((a, b) => String(a.index).localeCompare(String(b.index), 'en', { numeric: true }));
  return { problems: list, solved, total: list.length, weighted, firstACTotal, subsCount: subs.length };
}

/** 结束虚拟赛并生成复盘 */
async function finishVP(id) {
  const s = getSession(id);
  if (!s) return null;
  const now = Math.floor(Date.now() / 1000);
  if (s.status === 'countdown') {
    // 直接结束：未进入正赛
    dbm.db.prepare('UPDATE virtual_sessions SET status = ?, end_ts = ? WHERE id = ?')
      .run('finished', now, id);
    return getSession(id);
  }
  await prepareExport(id);
  dbm.db.prepare('UPDATE virtual_sessions SET status = ?, end_ts = ? WHERE id = ?')
    .run('finished', now, id);
  const s3 = getSession(id);
  return { ...s3, timing: sessionTiming(s3), review: (s3.contest && s3.contest._review) || null };
}

/** 导出复盘 ZIP（00-START-HERE / 01-CONTEST / 02-PROBLEMS / 03-SUBMISSIONS + 绑定代码） */
async function exportVP(id) {
  const s = await prepareExport(id);
  if (!s) return null;
  const t = sessionTiming(s);
  const contest = s.contest || {};
  const review = contest._review || buildReview(s, [], 'OK', t);
  const subs = contest._subs || [];
  const notes = s.problem_notes || {};
  const files = [];

  const name = (s.name || `${s.platform}-${s.contest_id}`).replace(/[\\/:*?"<>|]/g, '_');
  const stamp = new Date().toISOString().slice(0, 10);

  files.push({
    name: '00-START-HERE.md',
    data: `# ${name} — 赛后复盘包

本包由 XCPC 训练台导出，包含一场虚拟参赛的完整可验证数据。你可以把本目录中的
01-CONTEST.md、02-PROBLEMS.md、03-SUBMISSIONS.md 直接交给大模型做赛后分析。

## 建议给大模型的指令（可自行修改）
请阅读 01-CONTEST.md 的比赛信息与成绩、02-PROBLEMS.md 的题目与个人笔记、
03-SUBMISSIONS.md 的提交时间线，输出：
1. 本场比赛表现总结（哪些题稳定、哪些题卡住、时间分配是否合理）；
2. 按题目逐题给出卡点原因与改进方向；
3. 结合 02-PROBLEMS.md 中的个人笔记，指出 3 个最值得优先补强的知识点方向；
4. 针对薄弱方向推荐 5 道难度合适的练习题（附题号与链接）。

## 数据来源与边界
- 成绩基于本地拉取的比赛时间窗口内提交记录计算；代码/题面无法读取的项已明确标注缺失。
- 难度加权分 = 各题难度之和，用于横向比较成长，不是 CF 官方 rating。
- 本包不含任何 Cookie、Session、本机用户名或本地路径。
`,
  });

  const fmtDur = (sec) => {
    if (sec == null) return '-';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  };

  files.push({
    name: '01-CONTEST.md',
    data: `# ${name}

| 项目 | 值 |
|---|---|
| 平台 / 比赛 ID | ${s.platform} / ${s.contest_id} |
| 开始时间 | ${new Date(t.contestStart * 1000).toLocaleString()} |
| 用时 | ${fmtDur(t.elapsed)}（含暂停 ${fmtDur(t.pausedAccum || 0)}） |
| 解出题数 | ${review.solved} / ${review.total} |
| 难度加权分 | ${review.weighted} |
| 首次 AC 总用时 | ${fmtDur(review.firstACTotal)} |

## 整场笔记
${s.notes || '（无）'}
`,
  });

  files.push({
    name: '02-PROBLEMS.md',
    data: `# 题目与个人笔记

| 题号 | 标题 | 难度 | 结果 | 尝试 | 首次 AC 用时 | 个人笔记 |
|---|---|---|---|---|---|---|
${review.problems.map((p) => {
  const n = notes[p.pid] || {};
  return `| ${p.index || '-'} | ${(p.name || '').replace(/\|/g, '\\|')} | ${p.rating ?? '未评级'} | ${p.ac ? 'AC' : (p.attempts ? '未过' : '未提交')} | ${p.attempts} | ${fmtDur(p.first_ac_sec)} | ${(n.note || '').replace(/\n/g, '<br>').replace(/\|/g, '\\|')} |`;
}).join('\n')}
`,
  });

  files.push({
    name: '03-SUBMISSIONS.md',
    data: `# 提交时间线（比赛时间窗口内）

| 时间 | 题号 | 结果 | 语言 |
|---|---|---|---|
${(subs || []).map((sub) => `| ${toLocalDate(sub.ts)} ${new Date(sub.ts * 1000).toTimeString().slice(0, 8)} | ${sub.pid} | ${sub.verdict} | ${sub.lang} |`).join('\n') || '（无可获取的提交记录）'}
`,
  });

  // 绑定代码
  for (const [pid, v] of Object.entries(notes)) {
    if (v && v.code) {
      const ext = v.filename ? v.filename.split('.').pop() : 'txt';
      files.push({ name: `codes/${pid}.${ext}`, data: v.code });
    }
  }

  return { zip: makeZip(files), filename: `review-${name}-${stamp}.zip` };
}

/** 提交窗口内同步并缓存复盘所需数据（供 export 使用） */
async function prepareExport(id) {
  const s = getSession(id);
  if (!s) return null;
  const t = sessionTiming(s);
  const verdict = s.platform === 'codeforces' ? 'OK' : 'AC';
  const subs = dbm.db.prepare(
    `SELECT * FROM submissions WHERE platform = ? AND user = ? AND contest_id = ? AND ts >= ? ORDER BY ts ASC`
  ).all(s.platform, s.user, s.contest_id, t.contestStart);
  const review = buildReview(s, subs, verdict, t);
  dbm.db.prepare('UPDATE virtual_sessions SET contest = ? WHERE id = ?').run(
    JSON.stringify({ ...s.contest, _review: review, _subs: subs.map((x) => ({ ts: x.ts, pid: x.pid, verdict: x.verdict, lang: x.lang })) }), id);
  return getSession(id);
}

module.exports = {
  getCalendar, recommendVP, startVP, getSession, listSessions, sessionTiming,
  pauseVP, setVPNotes, setVPProblemNote, refreshSession, finishVP, exportVP, prepareExport,
};
