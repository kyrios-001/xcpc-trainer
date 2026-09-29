'use strict';
/**
 * lib/plan.js — 训练计划
 * 分阶段爬坡：从当前 rating 到目标，每隔约 200 分切一个阶段，
 * 每阶段练习区间 = 阶段目标分 -250 ~ +150。
 * 选题三条规则：优先弱项方向；优先通过人数多的题；难度取区间中上段。
 * 单个标签占比默认上限 40%；全计划去重；可混入 AtCoder / 洛谷（各源每天最多一题）。
 * 题量估算：经验系数「每提升 100 分约 60 题」，再按周题量换算成周数。
 */
const dbm = require('./db');
const { buildCapability, DIRECTIONS } = require('./knowledge');

const RATING_STEP = 200;
const INTERVAL_LOW_OFFSET = 250;
const INTERVAL_HIGH_OFFSET = 150;
const TAG_CAP = 0.4;
const PROBLEMS_PER_100 = 60;

/** 平台难度 → 练习区间统一分（AtCoder Kenkoooo 难度 +200 折算） */
function toPracticeRating(platform, rating) {
  if (rating == null) return null;
  return platform === 'atcoder' ? rating + 200 : rating;
}

/** 当前练习基线：CF rating 优先，其次 AtCoder，都没有则默认（按平台取最近一条，聚合多账号） */
function currentBaseRating() {
  const cf = dbm.db.prepare(
    'SELECT new_rating FROM rating_history WHERE platform = ? ORDER BY ts DESC LIMIT 1'
  ).get('codeforces');
  if (cf && cf.new_rating) return cf.new_rating;
  const ac = dbm.db.prepare(
    'SELECT new_rating FROM rating_history WHERE platform = ? ORDER BY ts DESC LIMIT 1'
  ).get('atcoder');
  if (ac && ac.new_rating) return ac.new_rating;
  return 1200;
}

/** 收集该用户“已做”的题（含难度与标签）。提交记录按平台聚合（多账号求和），本地标记按用户。 */
function solvedProblemsOf(user = 'default') {
  const rows = dbm.db.prepare(
    `SELECT DISTINCT s.platform, s.pid, s.rating, s.tags FROM submissions s
     WHERE s.verdict = 'OK'`
  ).all();
  const marks = dbm.db.prepare(
    `SELECT m.platform, m.pid, p.rating, p.tags FROM solved_marks m
     LEFT JOIN problems p ON p.platform = m.platform AND p.pid = m.pid
     WHERE m.user = ?`
  ).all(user);
  const luogu = dbm.db.prepare(
    `SELECT p.platform, p.pid, p.rating, p.tags FROM problems p
     WHERE p.platform = 'luogu' AND p.pid IN (SELECT pid FROM solved_marks WHERE user = ? AND platform = 'luogu')`
  ).all(user);

  const seen = new Set();
  const out = [];
  for (const r of [...rows, ...marks, ...luogu]) {
    const key = `${r.platform}:${r.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform: r.platform, pid: r.pid, rating: toPracticeRating(r.platform, r.rating), tags: JSON.parse(r.tags || '[]') });
  }
  return out;
}

/** 平台候选池：本地方题库 + 难度已折算 */
function candidatePool(platforms) {
  const ph = platforms.map(() => '?').join(',');
  const rows = dbm.db.prepare(
    `SELECT * FROM problems WHERE platform IN (${ph})`
  ).all(...platforms);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.platform}:${r.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = JSON.parse(r.tags || '[]');
    // 跳过 interactive / output-only（不适合日常训练）
    if (tags.includes('interactive') || /interactive|output only/i.test(r.name)) continue;
    out.push({
      platform: r.platform, pid: r.pid, name: r.name, rating: toPracticeRating(r.platform, r.rating),
      tags: tags.filter((t) => !t.startsWith('tier:')), rawTags: tags, solved_count: r.solved_count, url: r.url,
    });
  }
  return out;
}

function doneProblemKeys(user) {
  const keys = new Set();
  for (const r of dbm.db.prepare(
    "SELECT DISTINCT platform, pid FROM submissions WHERE verdict = 'OK'").all()) {
    keys.add(`${r.platform}:${r.pid}`);
  }
  for (const r of dbm.db.prepare('SELECT platform, pid FROM solved_marks WHERE user = ?').all(user)) {
    keys.add(`${r.platform}:${r.pid}`);
  }
  for (const r of dbm.db.prepare("SELECT platform, pid FROM plan_items WHERE user = ? AND status = 'done'").all(user)) {
    keys.add(`${r.platform}:${r.pid}`);
  }
  return keys;
}

/**
 * 生成训练计划
 * @param {object} opts { target, weekly, restDays:number[], mixAtcoder, mixLuogu, user }
 */
function generatePlan(opts) {
  const user = opts.user || 'default';
  const target = clampInt(opts.target, 1000, 4000);
  const weekly = clampInt(opts.weekly, 1, 84);
  const restDays = Array.isArray(opts.restDays) ? opts.restDays.map(Number) : [];

  const base = currentBaseRating();
  if (target <= base) {
    throw new Error(`目标分 ${target} 不高于当前基线 ${base}。请设定高于当前水平的目标（建议 +200 以上）。`);
  }
  const solved = solvedProblemsOf(user);
  const capability = buildCapability(solved, target);
  const doneKeys = doneProblemKeys(user);

  // 平台启用集合
  const platforms = ['codeforces'];
  if (opts.mixAtcoder) platforms.push('atcoder');
  if (opts.mixLuogu) platforms.push('luogu');
  const pool = candidatePool(platforms);
  const byKey = new Map(pool.map((p) => [`${p.platform}:${p.pid}`, p]));

  // 阶段划分
  const stages = [];
  for (let t = Math.ceil((base + 1) / RATING_STEP) * RATING_STEP; t <= target; t += RATING_STEP) {
    stages.push({ target: t, low: t - INTERVAL_LOW_OFFSET, high: t + INTERVAL_HIGH_OFFSET });
  }
  if (!stages.length) stages.push({ target: target, low: target - INTERVAL_LOW_OFFSET, high: target + INTERVAL_HIGH_OFFSET });
  // 确保覆盖到最终目标阶段（目标分本身作为一个阶段）
  if (stages[stages.length - 1].target < target) {
    stages.push({ target, low: target - INTERVAL_LOW_OFFSET, high: target + INTERVAL_HIGH_OFFSET });
  }

  // 题量：每提升 100 分约 60 题，按阶段比例分摊
  const totalGap = Math.max(100, target - base);
  const totalProblems = Math.round((totalGap / 100) * PROBLEMS_PER_100);
  const perStage = {};
  let allocated = 0;
  for (let i = 0; i < stages.length; i++) {
    const share = i === stages.length - 1 ? totalProblems - allocated : Math.round(totalProblems / stages.length);
    perStage[i] = share;
    allocated += share;
  }

  // 混排比例：AC + 洛谷各 1/4，其余 CF
  const ratios = [];
  if (opts.mixAtcoder && opts.mixLuogu) ratios.push(['atcoder', 0.25], ['luogu', 0.25], ['codeforces', 0.5]);
  else if (opts.mixAtcoder) ratios.push(['atcoder', 0.25], ['codeforces', 0.75]);
  else if (opts.mixLuogu) ratios.push(['luogu', 0.25], ['codeforces', 0.75]);
  else ratios.push(['codeforces', 1]);

  const stageItems = [];   // 每阶段 items
  const usedKeys = new Set(doneKeys);
  const weakRank = new Map();
  capability.directions
    .filter((d) => d.weakIndex != null || d.blind)
    .sort((a, b) => (b.blind ? 1 : b.weakIndex) - (a.blind ? 1 : a.weakIndex))
    .forEach((d, i) => weakRank.set(d.key, i));

  for (let s = 0; s < stages.length; s++) {
    const st = stages[s];
    const items = [];
    for (const [platform, ratio] of ratios) {
      const quota = Math.round(perStage[s] * ratio);
      const candidates = pool.filter((p) =>
        p.platform === platform && p.rating != null &&
        p.rating >= st.low && p.rating <= st.high && !usedKeys.has(`${p.platform}:${p.pid}`));
      if (!candidates.length) continue;

      // 排序：优先弱项方向（盲区 > 高弱项指数），其次难度中上段，再通过人数
      const scored = candidates.map((p) => {
        const dirs = [...new Set(p.tags.map((t) => knowledgeDirection(t)).filter(Boolean))];
        let rank = Infinity;
        for (const d of dirs) if (weakRank.has(d)) rank = Math.min(rank, weakRank.get(d));
        const mid = st.target - 50;
        const dist = Math.abs(p.rating - mid);           // 越小越接近区间中心
        const overMid = p.rating >= st.target - 100 ? 0 : 1;
        return { p, dirs, rank, score: (rank === Infinity ? 1e9 : rank) * 1e6 + dist * 100 + (overMid ? 50 : 0) - (p.solved_count || 0) };
      });
      scored.sort((a, b) => a.score - b.score);

      // 标签占比上限（有标签的题才计入方向配额；无标签题只占难度配额）
      const tagCounts = {};
      for (const { p, dirs } of scored) {
        if (items.length >= quota) break;
        const key = `${p.platform}:${p.pid}`;
        const tagOk = dirs.every((d) => (tagCounts[d] || 0) < Math.max(1, Math.ceil(quota * TAG_CAP)));
        if (!tagOk) continue;
        for (const d of dirs) tagCounts[d] = (tagCounts[d] || 0) + 1;
        items.push({ ...p, stage: s + 1, stageTarget: st.target });
        usedKeys.add(key);
      }
    }
    stageItems.push({ stage: s + 1, target: st.target, low: st.low, high: st.high, items });
  }

  // 排程：把全部题目落到日历（休息日 / 忙日顺延，首周按剩余天数折算）
  const scheduled = scheduleItems(stageItems.flatMap((x) => x.items.map((it) => ({ ...it, stage: x.stage }))),
    weekly, restDays, user);

  // 周数估算
  const weeks = Math.ceil(totalProblems / Math.max(1, weekly - restDays.length));

  const flat = scheduled.map((it, i) => ({ ...it, order: i + 1 }));
  return {
    base, target, weekly, restDays, capability,
    stages: stageItems.map((x) => ({ stage: x.stage, target: x.target, low: x.low, high: x.high, count: x.items.length })),
    totalProblems, weeks, mix: ratios.map(([p, r]) => ({ platform: p, ratio: r })),
    items: flat, generatedAt: Date.now(),
  };
}

function knowledgeDirection(tag) {
  const d = DIRECTIONS.find((x) => x.key === tag);
  return d ? d.key : null;
}

function clampInt(v, lo, hi) {
  v = parseInt(v, 10);
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 把题目按周排程：每周最多 weekly 题；休息日与忙日不排题；
 * 开始周按剩余天数折算；AtCoder / 洛谷每源每天最多一题，CF 每天最多 ceil(weekly/3)。
 */
function scheduleItems(items, weekly, restDays, user) {
  const busy = new Set(dbm.db.prepare('SELECT date FROM busy_days WHERE user = ?').all(user).map((r) => r.date));
  const rest = new Set(restDays);
  const acCap = new Map(), lgCap = new Map();

  const fmt = (d) => d.toISOString().slice(0, 10);
  const isRest = (d) => rest.has(d.getDay()) || busy.has(fmt(d));

  const queue = [...items];
  const out = [];

  let day = new Date();
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() + 1);

  // 每天配额：weekly 题分到 7 天，不设休息日时每天平均
  const activeDays = Math.max(1, 7 - restDays.length);
  const dailyQuota = Math.max(1, Math.round(weekly / activeDays));
  const cfCap = Math.max(1, dailyQuota);   // CF 不额外限制，按天配额走

  while (queue.length) {
    if (!isRest(day)) {
      const ds = fmt(day);
      let placedToday = 0;
      for (let i = 0; i < queue.length && placedToday < dailyQuota; i++) {
        const it = queue[i];
        const acToday = acCap.get(ds) || 0, lgToday = lgCap.get(ds) || 0;
        const cfToday = out.filter((x) => x.scheduled_date === ds && x.platform === 'codeforces').length;
        if (it.platform === 'atcoder' && acToday >= 1) continue;
        if (it.platform === 'luogu' && lgToday >= 1) continue;
        if (it.platform === 'codeforces' && cfToday >= cfCap) continue;
        it.scheduled_date = ds;
        out.push(it);
        queue.splice(i, 1);
        i--;
        placedToday++;
        if (it.platform === 'atcoder') acCap.set(ds, acToday + 1);
        if (it.platform === 'luogu') lgCap.set(ds, lgToday + 1);
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());   // 周日为一周起点
  return x;
}

/** 保存计划到库（替换该用户的旧计划） */
function savePlan(user, plan) {
  dbm.db.prepare('DELETE FROM plan_items WHERE user = ?').run(user);
  const st = dbm.db.prepare(
    `INSERT INTO plan_items(user, stage, platform, pid, name, rating, tags, url, scheduled_date, status, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  dbm.db.exec('BEGIN');
  try {
    for (const it of plan.items) {
      st.run(user, it.stage, it.platform, it.pid, it.name, it.rating,
        JSON.stringify(it.tags), it.url, it.scheduled_date, Math.floor(Date.now() / 1000));
    }
    dbm.setSetting(`plan_meta_${user}`, JSON.stringify({
      target: plan.target, weekly: plan.weekly, restDays: plan.restDays, mix: plan.mix,
      base: plan.base, weeks: plan.weeks, generatedAt: plan.generatedAt, stages: plan.stages,
    }));
    dbm.db.exec('COMMIT');
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return plan.items.length;
}

function loadPlan(user) {
  const meta = dbm.getSetting(`plan_meta_${user}`, null);
  const rows = dbm.db.prepare('SELECT * FROM plan_items WHERE user = ? ORDER BY scheduled_date, id').all(user);
  if (!rows.length) return { meta: null, items: [] };
  return { meta, items: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') })) };
}

function setPlanItemStatus(user, platform, pid, status, note) {
  dbm.db.prepare(
    `UPDATE plan_items SET status = ?, note = ? WHERE user = ? AND platform = ? AND pid = ?`
  ).run(status, note || '', user, platform, pid);
  if (status === 'done') {
    dbm.db.prepare('INSERT OR IGNORE INTO solved_marks(user, platform, pid, ts) VALUES(?, ?, ?, ?)')
      .run(user, platform, pid, Math.floor(Date.now() / 1000));
  }
}

function setBusyDay(user, date, reason) {
  dbm.db.prepare(
    'INSERT INTO busy_days(user, date, reason) VALUES(?, ?, ?) ON CONFLICT(user, date) DO UPDATE SET reason = excluded.reason'
  ).run(user, date, reason || '');
}
function removeBusyDay(user, date) {
  dbm.db.prepare('DELETE FROM busy_days WHERE user = ? AND date = ?').run(user, date);
}
function listBusyDays(user) {
  return dbm.db.prepare('SELECT * FROM busy_days WHERE user = ? ORDER BY date').all(user);
}

/** 仅重新排程：不换题，只按当前 busy/restDays 重新分配日期 */
function rescheduleItems(items, weekly, restDays, user) {
  const busy = new Set(dbm.db.prepare('SELECT date FROM busy_days WHERE user = ?').all(user).map((r) => r.date));
  const rest = new Set(restDays);
  const activeDays = Math.max(1, 7 - restDays.length);
  const dailyQuota = Math.max(1, Math.round(weekly / activeDays));
  const fmt = (d) => d.toISOString().slice(0, 10);
  const isRest = (d) => rest.has(d.getDay()) || busy.has(fmt(d));
  const queue = [...items].sort((a, b) => (a.stage || 0) - (b.stage || 0) || (a.id || 0) - (b.id || 0));
  const out = [];
  let day = new Date();
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() + 1);
  const acCap = new Map(), lgCap = new Map();
  while (queue.length) {
    if (!isRest(day)) {
      const ds = fmt(day);
      let placedToday = 0;
      for (let i = 0; i < queue.length && placedToday < dailyQuota; i++) {
        const it = queue[i];
        const acToday = acCap.get(ds) || 0, lgToday = lgCap.get(ds) || 0;
        if (it.platform === 'atcoder' && acToday >= 1) continue;
        if (it.platform === 'luogu' && lgToday >= 1) continue;
        it.scheduled_date = ds;
        out.push(it);
        queue.splice(i, 1); i--; placedToday++;
        if (it.platform === 'atcoder') acCap.set(ds, acToday + 1);
        if (it.platform === 'luogu') lgCap.set(ds, lgToday + 1);
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

module.exports = {
  generatePlan, savePlan, loadPlan, setPlanItemStatus, setBusyDay, removeBusyDay, listBusyDays,
  currentBaseRating, solvedProblemsOf, toPracticeRating, RATING_STEP,
  buildCapability, rescheduleItems,
};
