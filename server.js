'use strict';
/**
 * server.js — XCPC 训练台 HTTP 服务与接口
 * 零第三方依赖（Node 22.5+ 内置 node:sqlite）。启动后访问 http://127.0.0.1:5173/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const dbm = require('./lib/db');
const stats = require('./lib/stats');
const cf = require('./lib/cf');
const ac = require('./lib/ac');
const luogu = require('./lib/luogu');
const leetcode = require('./lib/leetcode');
const simpleOj = require('./lib/simple_oj');
const plan = require('./lib/plan');
const contests = require('./lib/contests');
const icpc = require('./lib/icpc');
const model = require('./lib/model');

// ---------- 进程级兜底：单个错误不拖垮整个服务 ----------
// Node 22 默认把未处理的 promise rejection 当作致命错误；本地单用户工具的正确取舍是
// 记录日志并继续服务，而不是让整个进程退出（否则一次漏网错误 = 网站“打不开”）。
process.on('uncaughtException', (e) => {
  console.error('[xcpc-trainer] uncaughtException（已兜底，服务继续运行）:', e && e.stack || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[xcpc-trainer] unhandledRejection（已兜底，服务继续运行）:', e && e.stack || e);
});

// PORT=0 表示随机空闲端口（桌面版使用）；未设置时默认 5173
const PORT = process.env.PORT !== undefined ? parseInt(process.env.PORT, 10) : 5173;
const PUBLIC = path.join(__dirname, 'public');
const USER = 'default';
const START_TS = Date.now();

// 首次启动：seed ICPC 目录（失败不阻塞启动，后续接口会自行降级）
try { icpc.seedCatalog(); } catch (e) { console.error('[xcpc-trainer] ICPC 目录初始化失败（可忽略）:', e.message); }
// 启动后收缩一次 WAL（上次异常退出可能遗留大 WAL）
dbm.checkpoint();

// ---------- 工具 ----------
function json(res, data, code = 200) {
  let body;
  try { body = JSON.stringify(data); } catch (e) { body = JSON.stringify({ error: '序列化失败: ' + e.message }); code = 500; }
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function fail(res, message, code = 400) {
  json(res, { error: String(message) }, code);
}
async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0, over = false;
  // 先全部读完（最多 8MB 防无限流），超限时丢弃内容但正常返回 413，而不是掐断连接
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) {
      over = true;
      if (total > 8 * 1024 * 1024) break;   // 极端情况停止读取
      continue;
    }
    chunks.push(c);
  }
  if (over) throw new BodyTooLargeError(`请求体超过 ${maxBytes} 字节上限`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
class BodyTooLargeError extends Error {}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 后台任务执行器（带超时与失败详情） ----------
const running = new Map();
const taskErrors = new Map();   // key -> 最近一次失败信息（供状态接口展示）
const DEFAULT_TASK_TIMEOUT = 10 * 60 * 1000;   // 同步/导入类任务最长 10 分钟

function launchTask(key, fn, { timeoutMs = DEFAULT_TASK_TIMEOUT } = {}) {
  if (running.has(key)) return { started: false, reason: '已有同名任务在运行' };
  let timer = null;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`任务超时（${Math.round(timeoutMs / 1000)}s），已中止`)), timeoutMs);
    if (timer.unref) timer.unref();
  });
  const task = Promise.race([fn(), timed]).then(
    (v) => ({ ok: true, ...(v && typeof v === 'object' ? v : {}) }),
    (e) => {
      taskErrors.set(key, { at: Math.floor(Date.now() / 1000), error: e.message });
      return { ok: false, error: e.message };
    }
  );
  running.set(key, task);
  task.finally(() => { clearTimeout(timer); running.delete(key); });
  return { started: true };
}
function taskState(key) {
  return running.has(key) ? 'running' : 'idle';
}
function taskErrorsSummary() {
  return Object.fromEntries([...taskErrors].map(([k, v]) => [k, v]));
}

// ---------- 同步 ----------
async function syncPlatform(platform, handle, mode) {
  const state = dbm.getSyncState(platform, handle);
  dbm.setSyncState(platform, handle, { status: 'syncing', error: '' });
  try {
    if (platform === 'codeforces') {
      const info = await cf.getUserInfo(handle);
      if (!info) throw new Error('未找到该 Codeforces 用户');
      const nRating = await cf.syncRatingHistory(handle);
      await cf.syncProblemset('codeforces', 7);
      const r = await cf.syncSubmissions(handle);
      dbm.setSyncState(platform, handle, {
        cursor: String(r.added), last_sync: Math.floor(Date.now() / 1000), status: 'ok', error: '',
      });
      return { rating: info.rating, maxRating: info.maxRating, ratingEntries: nRating, added: r.added };
    }
    if (platform === 'atcoder') {
      await ac.ensureProblemCatalog();
      const nRating = await ac.syncRatingHistory(handle);
      const r = await ac.syncSubmissions(handle);
      dbm.setSyncState(platform, handle, {
        cursor: String(r.cursor), last_sync: Math.floor(Date.now() / 1000), status: 'ok', error: '',
      });
      return { ratingEntries: nRating, added: r.added };
    }
    if (platform === 'luogu') {
      const r = await luogu.syncPassed(handle);
      if (r.needLogin) {
        dbm.setSyncState(platform, handle, {
          last_sync: Math.floor(Date.now() / 1000), status: 'error',
          error: '洛谷做题记录需要登录 Cookie（在设置中填写后重试）；题目列表页仍可正常导入',
        });
        return { passed: r.passed, needLogin: true };
      }
      dbm.setSyncState(platform, handle, {
        last_sync: Math.floor(Date.now() / 1000), status: 'ok', error: '',
      });
      dbm.checkpoint();
      return { passed: r.passed };
    }
    if (platform === 'leetcode') {
      const r = await leetcode.syncUser(handle);
      dbm.setSyncState(platform, handle, {
        cursor: '', last_sync: Math.floor(Date.now() / 1000), status: 'ok', error: '',
      });
      dbm.checkpoint();
      return { solved: r.solved, ranking: r.ranking };
    }
    if (simpleOj.handlers[platform]) {
      const r = await simpleOj.handlers[platform](handle);
      dbm.setSyncState(platform, handle, {
        cursor: '', last_sync: Math.floor(Date.now() / 1000), status: 'ok', error: '',
      });
      dbm.checkpoint();
      return r;
    }
    throw new Error('未知平台');
  } catch (e) {
    dbm.setSyncState(platform, handle, {
      status: 'error', error: e.message,
      last_sync: dbm.getSyncState(platform, handle).last_sync,
    });
    throw e;
  } finally {
    // 同步结束收缩 WAL，避免大写入后 wal 文件无限增长
    dbm.checkpoint();
  }
}

function clearSync(platform, handle, all) {
  if (all) {
    dbm.db.prepare('DELETE FROM submissions').run();
    dbm.db.prepare('DELETE FROM rating_history').run();
    dbm.db.prepare('DELETE FROM sync_state').run();
    dbm.db.prepare("DELETE FROM solved_marks WHERE platform IN ('codeforces','atcoder','luogu','leetcode','hdu','poj','vjudge','nowcoder','qoj')").run();
    return { cleared: 'all' };
  }
  dbm.db.prepare('DELETE FROM submissions WHERE platform = ?').run(platform);
  dbm.db.prepare('DELETE FROM rating_history WHERE platform = ?').run(platform);
  dbm.db.prepare('DELETE FROM sync_state WHERE platform = ?').run(platform);
  return { cleared: platform };
}

// ---------- 训练模型（后台，子进程带超时） ----------
async function runModelTraining(contests) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-sqlite', path.join(__dirname, 'scripts', 'train-model.js'), '--contests', String(contests)],
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const killTimer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} reject(new Error('模型训练超时（20 分钟），已中止')); }
    }, 20 * 60 * 1000);
    if (killTimer.unref) killTimer.unref();
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => {
      if (done) return;
      done = true; clearTimeout(killTimer);
      (code === 0 ? resolve(out) : reject(new Error(out.slice(-1000))));
    });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(killTimer); reject(e); });
  });
}

// ---------- 题库查询 ----------
function queryProblems(q) {
  const where = ['1=1'];
  const args = [];
  if (q.platform && q.platform !== 'all') { where.push('platform = ?'); args.push(q.platform); }
  if (q.rating_min != null) { where.push('rating >= ?'); args.push(+q.rating_min); }
  if (q.rating_max != null) { where.push('rating <= ?'); args.push(+q.rating_max); }
  if (q.tag && q.tag !== '') {
    where.push(`EXISTS (SELECT 1 FROM json_each(problems.tags) t WHERE lower(t.value) LIKE ?)`);
    args.push('%' + q.tag.toLowerCase() + '%');
  }
  if (q.q && q.q.trim()) {
    const kw = '%' + q.q.trim() + '%';
    where.push('(pid LIKE ? OR name LIKE ?)');
    args.push(kw, kw);
  }
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const per = 50;
  const order = q.sort === 'rating_asc' ? 'rating ASC' :
    q.sort === 'rating_desc' ? 'rating DESC' :
    q.sort === 'solved' ? 'solved_count DESC' :
    'rating DESC';
  const whereSql = where.join(' AND ');
  const total = dbm.db.prepare(`SELECT COUNT(*) c FROM problems WHERE ${whereSql}`).get(...args).c;
  const rows = dbm.db.prepare(
    `SELECT * FROM problems WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...args, per, (page - 1) * per);

  // 已做集合
  const done = new Set();
  for (const r of dbm.db.prepare("SELECT platform, pid FROM submissions WHERE verdict IN ('OK','AC')").all()) done.add(`${r.platform}:${r.pid}`);
  for (const r of dbm.db.prepare("SELECT platform, pid FROM solved_marks WHERE user = ?").all(USER)) done.add(`${r.platform}:${r.pid}`);
  const items = rows.map((r) => {
    const tags = JSON.parse(r.tags || '[]');
    return {
      platform: r.platform, pid: r.pid, name: r.name, rating: r.rating,
      tags: tags.filter((t) => !t.startsWith('tier:')),
      rawTags: tags, url: r.url, source: r.source, solved_count: r.solved_count,
      done: done.has(`${r.platform}:${r.pid}`),
    };
  });
  if (q.only_unsolved === '1') {
    const filtered = items.filter((x) => !x.done);
    return { items: filtered, total: filtered.length, page, per };
  }
  return { items, total, page, per };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  let u, p, q;
  try {
    u = new URL(req.url, 'http://x');
    p = u.pathname.replace(/\/{2,}/g, '/');   // 归一化连续斜杠，畸形请求不崩溃
    q = Object.fromEntries(u.searchParams);
  } catch {
    return fail(res, 'Bad Request', 400);
  }
  try {
    // ---- 静态资源 ----
    if (req.method === 'GET' && p.startsWith('/css/')) return serveFile(res, path.join(PUBLIC, 'css', path.basename(p)), 'text/css; charset=utf-8');
    if (req.method === 'GET' && p.startsWith('/js/')) return serveFile(res, path.join(PUBLIC, 'js', path.basename(p)), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && /^\/(index|plan|library|calendar|tracker|settings)\.html$/.test(p)) {
      return serveFile(res, path.join(PUBLIC, path.basename(p)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/' || p === '')) return serveFile(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
    // favicon：无图标时返回 204，避免浏览器自动请求产生 404 噪音
    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      res.end();
      return;
    }

    // ---- API ----
    if (p === '/api/health' && req.method === 'GET') {
      return json(res, {
        ok: true, app: 'xcpc-trainer', version: '0.1.0',
        dataDir: dbm.DATA_DIR, uptime: Math.floor((Date.now() - START_TS) / 1000),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
    }

    if (p === '/api/settings' && req.method === 'GET') {
      const platforms = { codeforces: [], atcoder: [], luogu: [], leetcode: [], hdu: [], poj: [], vjudge: [], nowcoder: [], qoj: [] };
      for (const u2 of dbm.listUsers()) platforms[u2.platform]?.push({ handle: u2.handle, label: u2.label });
      return json(res, {
        platforms,
        theme: dbm.getSetting('theme', 'dark'),
        planDefaults: {
          target: dbm.getSetting('plan_target', 1800),
          weekly: dbm.getSetting('plan_weekly', 12),
          restDays: dbm.getSetting('plan_rest_days', []),
          mixAtcoder: dbm.getSetting('plan_mix_atcoder', false),
          mixLuogu: dbm.getSetting('plan_mix_luogu', false),
        },
        luogu_cookie_set: !!dbm.getSetting('luogu_cookie', ''),
        luogu_tier_counts: dbm.getSetting('luogu_tier_counts', {}),
        model: model.loadModel(),
        tasks: Object.fromEntries([...running.keys()].map((k) => [k, true])),
      });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.theme) dbm.setSetting('theme', b.theme);
      if (b.cf_handle !== undefined) {
        if (b.cf_handle) dbm.addUser('codeforces', String(b.cf_handle).trim());
        else dbm.removeUser('codeforces', (dbm.listUsers().find((x) => x.platform === 'codeforces') || {}).handle || '');
      }
      if (b.ac_handle !== undefined) {
        if (b.ac_handle) dbm.addUser('atcoder', String(b.ac_handle).trim());
        else dbm.removeUser('atcoder', (dbm.listUsers().find((x) => x.platform === 'atcoder') || {}).handle || '');
      }
      if (b.lg_uid !== undefined) {
        if (b.lg_uid) dbm.addUser('luogu', String(b.lg_uid).trim());
        else dbm.removeUser('luogu', (dbm.listUsers().find((x) => x.platform === 'luogu') || {}).handle || '');
      }
      if (b.lc_handle !== undefined) {
        if (b.lc_handle) dbm.addUser('leetcode', String(b.lc_handle).trim());
        else {
          const uc = dbm.listUsers().find((x) => x.platform === 'leetcode');
          if (uc) dbm.removeUser('leetcode', uc.handle);
        }
      }
      const simpleFields = { hdu_handle: 'hdu', poj_handle: 'poj', vj_handle: 'vjudge', nc_uid: 'nowcoder', qoj_handle: 'qoj' };
      for (const [field, pf] of Object.entries(simpleFields)) {
        if (b[field] !== undefined) {
          if (b[field]) dbm.addUser(pf, String(b[field]).trim());
          else {
            const uc = dbm.listUsers().find((x) => x.platform === pf);
            if (uc) dbm.removeUser(pf, uc.handle);
          }
        }
      }
      if (b.luogu_cookie !== undefined) dbm.setSetting('luogu_cookie', String(b.luogu_cookie || ''));
      if (b.plan_target != null) dbm.setSetting('plan_target', +b.plan_target);
      if (b.plan_weekly != null) dbm.setSetting('plan_weekly', +b.plan_weekly);
      if (b.plan_rest_days != null) dbm.setSetting('plan_rest_days', Array.isArray(b.plan_rest_days) ? b.plan_rest_days.map(Number) : []);
      if (b.plan_mix_atcoder != null) dbm.setSetting('plan_mix_atcoder', !!b.plan_mix_atcoder);
      if (b.plan_mix_luogu != null) dbm.setSetting('plan_mix_luogu', !!b.plan_mix_luogu);
      return json(res, { ok: true });
    }

    if (p === '/api/sync' && req.method === 'POST') {
      const b = await readBody(req);
      const platform = b.platform, handle = b.handle;
      if (!platform || !handle) return fail(res, '缺少 platform 或 handle', 400);
      if (!['codeforces', 'atcoder', 'luogu', 'leetcode', 'hdu', 'poj', 'vjudge', 'nowcoder', 'qoj'].includes(platform)) return fail(res, '未知平台: ' + platform, 400);
      const r = launchTask('sync', async () => {
        await syncPlatform(platform, handle, b.mode || 'latest');
      });
      return json(res, r);
    }
    if (p === '/api/sync/status' && req.method === 'GET') {
      return json(res, { running: taskState('sync') === 'running', states: stats.syncStatusSummary(), tasks: Object.fromEntries([...running.keys()].map((k) => [k, true])), errors: taskErrorsSummary() });
    }
    if (p === '/api/sync/clear' && req.method === 'POST') {
      const b = await readBody(req);
      if (running.has('sync')) return fail(res, '同步正在进行中，请等它结束后再清空', 409);
      if (running.has('luogu-import-' + (b.tier ?? ''))) return fail(res, '题库导入正在进行中，请稍后', 409);
      return json(res, clearSync(b.platform, b.handle, b.all));
    }
    if (p === '/api/user' && req.method === 'DELETE') {
      const b = await readBody(req);
      if (!b.platform || !b.handle) return fail(res, '缺少 platform 或 handle', 400);
      dbm.removeUser(b.platform, b.handle);
      dbm.db.prepare('DELETE FROM submissions WHERE platform=? AND user=?').run(b.platform, b.handle);
      dbm.db.prepare('DELETE FROM rating_history WHERE platform=? AND user=?').run(b.platform, b.handle);
      dbm.db.prepare('DELETE FROM solved_marks WHERE platform=? AND user=?').run(b.platform, b.handle);
      dbm.db.prepare('DELETE FROM sync_state WHERE platform=? AND user=?').run(b.platform, b.handle);
      dbm.checkpoint();
      return json(res, { deleted: b.handle });
    }

    if (p === '/api/stats' && req.method === 'GET') {
      return json(res, stats.getCareerStats());
    }
    if (p === '/api/activity' && req.method === 'GET') {
      return json(res, stats.getActivity(q.range || '365', q.mode || 'first-ac', q.platform || 'all'));
    }
    if (p === '/api/rating' && req.method === 'GET') {
      return json(res, stats.getRatingSeries(q.platform || 'codeforces'));
    }
    if (p === '/api/recent' && req.method === 'GET') {
      return json(res, stats.getRecentAC(q.platform || 'codeforces', parseInt(q.n, 10) || 20));
    }
    if (p === '/api/difficulty' && req.method === 'GET') {
      return json(res, stats.getDifficultyHistogram(q.platform || 'codeforces'));
    }

    if (p === '/api/capability' && req.method === 'GET') {
      const target = +q.target || dbm.getSetting('plan_target', 1800);
      const solved = plan.solvedProblemsOf(USER);
      return json(res, plan.buildCapability(solved, target));
    }

    if (p === '/api/plan/generate' && req.method === 'POST') {
      const b = await readBody(req);
      const target = +b.target || dbm.getSetting('plan_target', 1800);
      const weekly = +b.weekly || dbm.getSetting('plan_weekly', 12);
      const restDays = Array.isArray(b.restDays) ? b.restDays : dbm.getSetting('plan_rest_days', []);
      const mixAtcoder = b.mixAtcoder !== undefined ? !!b.mixAtcoder : dbm.getSetting('plan_mix_atcoder', false);
      const mixLuogu = b.mixLuogu !== undefined ? !!b.mixLuogu : dbm.getSetting('plan_mix_luogu', false);
      // 模型启用时注入到候选排序
      const g = plan.generatePlan({ target, weekly, restDays, mixAtcoder, mixLuogu, user: USER });
      const n = plan.savePlan(USER, g);
      return json(res, { ...g, saved: n });
    }
    if (p === '/api/plan' && req.method === 'GET') {
      return json(res, plan.loadPlan(USER));
    }
    if (p === '/api/plan/item' && req.method === 'POST') {
      const b = await readBody(req);
      plan.setPlanItemStatus(USER, b.platform, b.pid, b.status, b.note);
      return json(res, { ok: true });
    }
    if (p === '/api/plan/today' && req.method === 'GET') {
      const rows = dbm.db.prepare(
        "SELECT * FROM plan_items WHERE user = ? AND scheduled_date <= ? AND status != 'done' ORDER BY scheduled_date, id LIMIT 50"
      ).all(USER, todayStr());
      return json(res, rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') })));
    }
    if (p === '/api/plan/reschedule' && req.method === 'POST') {
      const existing = dbm.db.prepare("SELECT * FROM plan_items WHERE user = ? ORDER BY id").all(USER);
      if (!existing.length) return fail(res, '还没有计划', 400);
      const metaRaw = dbm.getSetting(`plan_meta_${USER}`, null);
      if (!metaRaw) return fail(res, '计划元数据缺失', 400);
      const meta = JSON.parse(metaRaw);
      const items = existing.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
      const rescheduled = plan.rescheduleItems(items, meta.weekly || 12, meta.restDays || [], USER);
      dbm.db.exec('BEGIN');
      try {
        const upd = dbm.db.prepare("UPDATE plan_items SET scheduled_date = ? WHERE user = ? AND platform = ? AND pid = ?");
        for (const it of rescheduled) upd.run(it.scheduled_date, USER, it.platform, it.pid);
        dbm.db.exec('COMMIT');
      } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
      return json(res, { rescheduled: rescheduled.length });
    }
    if (p === '/api/busy' && req.method === 'GET') return json(res, plan.listBusyDays(USER));
    if (p === '/api/busy' && req.method === 'POST') {
      const b = await readBody(req);
      plan.setBusyDay(USER, b.date, b.reason);
      return json(res, { ok: true });
    }
    if (p === '/api/busy' && req.method === 'DELETE') {
      const b = await readBody(req);
      plan.removeBusyDay(USER, b.date);
      return json(res, { ok: true });
    }

    if (p === '/api/contests' && req.method === 'GET') {
      return json(res, await contests.getCalendar(parseInt(q.days, 10) || 14, q.platform || 'all'));
    }
    if (p === '/api/virtual/recommend' && req.method === 'GET') {
      return json(res, await contests.recommendVP(parseInt(q.limit, 10) || 30));
    }
    if (p === '/api/virtual/start' && req.method === 'POST') {
      const b = await readBody(req);
      const s = await contests.startVP(USER, { platform: b.platform, contest_id: b.contest_id, countdown: +b.countdown || 0 });
      return json(res, { ...s, timing: contests.sessionTiming(s) });
    }
    if (p === '/api/virtual/list' && req.method === 'GET') {
      return json(res, contests.listSessions(USER));
    }
    if (p === '/api/virtual' && req.method === 'GET' && q.session) {
      const s = await contests.refreshSession(+q.session);
      if (!s) return fail(res, '会话不存在', 404);
      return json(res, { ...s, timing: contests.sessionTiming(s) });
    }
    if (p === '/api/virtual/pause' && req.method === 'POST') {
      const b = await readBody(req);
      const s = contests.pauseVP(+b.session, !!b.pause);
      return json(res, { ...s, timing: contests.sessionTiming(s) });
    }
    if (p === '/api/virtual/notes' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, contests.setVPNotes(+b.session, b.notes));
    }
    if (p === '/api/virtual/problemnote' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, contests.setVPProblemNote(+b.session, b.pid, {
        note: b.note, code: b.code, filename: b.filename,
      }));
    }
    if (p === '/api/virtual/finish' && req.method === 'POST') {
      const b = await readBody(req);
      const s = await contests.finishVP(+b.session);
      if (!s) return fail(res, '会话不存在', 404);
      return json(res, s);
    }
    if (p === '/api/virtual/export' && req.method === 'GET' && q.session) {
      const out = await contests.exportVP(+q.session);
      if (!out) return fail(res, '会话不存在', 404);
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${encodeURIComponent(out.filename)}"`,
      });
      res.end(out.zip);
      return;
    }

    if (p === '/api/sets' && req.method === 'GET') {
      const list = icpc.listContests(q).map((c) => ({
        ...c, progress: icpc.progressOf(USER, c.id),
      }));
      return json(res, { contests: list, overall: icpc.overallStats(USER) });
    }
    if (p === '/api/sets/contest' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.delete) { icpc.deleteContest(+b.id); return json(res, { ok: true }); }
      return json(res, icpc.upsertContest(b));
    }
    if (p === '/api/sets/problem' && req.method === 'POST') {
      const b = await readBody(req);
      let problem = b.problem || {};
      if (problem.link) {
        const parsed = icpc.parseProblemLink(problem.link);
        if (parsed) {
          const info = icpc.problemInfo(parsed.platform, parsed.pid);
          problem = {
            platform: parsed.platform, pid: parsed.pid,
            name: (info && info.name) || '',
            rating: info && info.rating != null ? info.rating : null,
            url: (info && info.url) || stats.problemUrl(parsed.platform, parsed.pid),
            link: problem.link,
          };
        }
      }
      return json(res, icpc.setContestProblem(+b.contestId, b.idx, problem));
    }
    if (p === '/api/sets/progress' && req.method === 'POST') {
      const b = await readBody(req);
      icpc.setProgress(USER, +b.contestId, b.idx, b.status, b.note);
      return json(res, { ok: true });
    }

    if (p === '/api/problems' && req.method === 'GET') {
      return json(res, queryProblems(q));
    }
    if (p === '/api/problems/mark' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.status === 'done') {
        dbm.db.prepare('INSERT OR REPLACE INTO solved_marks(user, platform, pid, ts) VALUES(?, ?, ?, ?)')
          .run(USER, b.platform, b.pid, Math.floor(Date.now() / 1000));
      } else {
        dbm.db.prepare('DELETE FROM solved_marks WHERE user = ? AND platform = ? AND pid = ?').run(USER, b.platform, b.pid);
      }
      return json(res, { ok: true });
    }
    if (p === '/api/problems/random' && req.method === 'GET') {
      const r = dbm.db.prepare(
        `SELECT * FROM problems WHERE platform = ? AND rating >= ? AND rating <= ? ORDER BY RANDOM() LIMIT 1`
      ).get(q.platform || 'codeforces', +q.rating_min || 0, +q.rating_max || 4000);
      return json(res, r || null);
    }

    if (p === '/api/lists' && req.method === 'GET') {
      const doneSet = new Set();
      for (const r of dbm.db.prepare("SELECT platform, pid FROM submissions WHERE verdict IN ('OK','AC')").all()) doneSet.add(r.platform + ':' + r.pid);
      for (const r of dbm.db.prepare("SELECT platform, pid FROM solved_marks WHERE user = ?").all(USER)) doneSet.add(r.platform + ':' + r.pid);
      const rows = dbm.db.prepare('SELECT * FROM lists WHERE user = ? ORDER BY id DESC').all(USER);
      const result = rows.map(function(r) {
        const probs = JSON.parse(r.problems || '[]').map(function(p) {
          return Object.assign({}, p, { done: doneSet.has(p.platform + ':' + p.pid) });
        });
        return Object.assign({}, r, { problems: probs });
      });
      return json(res, result);
    }
    if (p === '/api/lists' && req.method === 'POST') {
      const b = await readBody(req);
      const r = dbm.db.prepare('INSERT INTO lists(user, name, problems, created_at) VALUES(?, ?, ?, ?)')
        .run(USER, b.name || '未命名题单', JSON.stringify(b.problems || []), Math.floor(Date.now() / 1000));
      return json(res, { id: r.lastInsertRowid });
    }
    if (p === '/api/lists/import' && req.method === 'POST') {
      const b = await readBody(req);
      const problems = [];
      for (const line of String(b.text || '').split(/\s+/)) {
        const parsed = icpc.parseProblemLink(line);
        if (!parsed) continue;
        const info = icpc.problemInfo(parsed.platform, parsed.pid);
        problems.push({
          platform: parsed.platform, pid: parsed.pid,
          name: (info && info.name) || '', rating: info && info.rating != null ? info.rating : null,
          tags: info ? JSON.parse(info.tags || '[]').filter((t) => !t.startsWith('tier:')) : [],
          url: (info && info.url) || stats.problemUrl(parsed.platform, parsed.pid),
        });
      }
      if (!problems.length) return fail(res, '未能识别任何题目链接');
      const r = dbm.db.prepare('INSERT INTO lists(user, name, problems, created_at) VALUES(?, ?, ?, ?)')
        .run(USER, b.name || '导入题单', JSON.stringify(problems), Math.floor(Date.now() / 1000));
      return json(res, { id: r.lastInsertRowid, count: problems.length, problems });
    }
    if (p.startsWith('/api/lists/') && p.endsWith('/delete') && req.method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      dbm.db.prepare('DELETE FROM lists WHERE id = ? AND user = ?').run(id, USER);
      return json(res, { ok: true });
    }

    if (p === '/api/luogu/import' && req.method === 'POST') {
      const b = await readBody(req);
      const r = launchTask('luogu-import-' + b.tier, async () => {
        await luogu.importTier(+b.tier);
      });
      return json(res, r);
    }
    if (p === '/api/luogu/tiers' && req.method === 'GET') {
      return json(res, luogu.LUOGU_TIER);
    }

    if (p === '/api/model' && req.method === 'GET') {
      return json(res, model.loadModel());
    }
    if (p === '/api/model/train' && req.method === 'POST') {
      const b = await readBody(req);
      const r = launchTask('train', async () => {
        await runModelTraining(Math.min(300, parseInt(b.contests, 10) || 60));
      });
      return json(res, r);
    }

    return fail(res, `未知接口: ${p}`, 404);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return fail(res, e.message, 413);
    console.error(`[API ${req.method} ${p}]`, e && e.stack || e);
    fail(res, e.message, 500);
  }
});

function serveFile(res, file, type) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'cache-control': type.includes('text/html') ? 'no-cache' : 'public, max-age=300',
  });
  const stream = fs.createReadStream(file);
  // 读取中途出错（文件被删/被锁）时兜底返回，而不是让 stream error 事件未处理导致进程崩溃
  stream.on('error', () => {
    try { res.destroy(); } catch { /* 连接可能已关闭 */ }
  });
  stream.pipe(res);
}

server.on('error', (e) => {
  console.error('[xcpc-trainer] 服务启动失败:', e.message);
  process.exit(1);
});
server.listen(PORT, () => {
  const actual = server.address().port;
  if (PORT === 0) {
    // 桌面版通过子进程拉起：输出一行 XC_PORT=<port> 供主进程解析
    console.log(`XC_PORT=${actual}`);
  } else {
    console.log(`XCPC 训练台已启动： http://127.0.0.1:${actual}`);
  }
  console.log(`数据目录： ${dbm.DATA_DIR}（复制 data/xcpc.db 即可备份）`);
});
