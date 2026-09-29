'use strict';
/**
 * lib/db.js — SQLite 数据层
 * 使用 Node 22.5+ 内置的 node:sqlite（DatabaseSync），零第三方依赖。
 * 所有训练数据保存在本地 data/xcpc.db，复制该文件即可备份/迁移。
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'xcpc.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------- 幂等迁移（旧库升级）：必须在建表/索引前补列 ----------
try { db.exec('ALTER TABLE problems ADD COLUMN contest_id TEXT DEFAULT \'\''); } catch {}
try { db.exec('ALTER TABLE problems ADD COLUMN problem_index TEXT DEFAULT \'\''); } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT NOT NULL,               -- codeforces | atcoder | luogu
  handle     TEXT NOT NULL,               -- 账号标识
  label      TEXT DEFAULT '',             -- 备注名
  created_at INTEGER,
  UNIQUE(platform, handle)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL,
  user        TEXT NOT NULL,
  sub_id      TEXT NOT NULL,              -- 平台侧提交 id
  pid         TEXT NOT NULL,              -- 题号（如 1234A / abc123_a / P1000）
  name        TEXT DEFAULT '',
  rating      INTEGER,                    -- 该题难度（平台自身体系或折算）
  tags        TEXT DEFAULT '[]',          -- JSON 数组
  verdict     TEXT DEFAULT '',            -- AC / WA / ...
  ts          INTEGER,                    -- 提交时间（秒）
  contest_id  TEXT DEFAULT '',
  lang        TEXT DEFAULT '',
  UNIQUE(platform, user, sub_id)
);
CREATE INDEX IF NOT EXISTS idx_sub_user_ts ON submissions(platform, user, ts);
CREATE INDEX IF NOT EXISTS idx_sub_user_pid ON submissions(platform, user, pid);

CREATE TABLE IF NOT EXISTS rating_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL,
  user        TEXT NOT NULL,
  contest_id  TEXT NOT NULL,
  contest_name TEXT DEFAULT '',
  rank        INTEGER,
  old_rating  INTEGER,
  new_rating  INTEGER,
  ts          INTEGER,
  UNIQUE(platform, user, contest_id)
);

CREATE TABLE IF NOT EXISTS problems (
  platform    TEXT NOT NULL,
  pid         TEXT NOT NULL,
  name        TEXT DEFAULT '',
  rating      INTEGER,
  tags        TEXT DEFAULT '[]',
  url         TEXT DEFAULT '',
  source      TEXT DEFAULT '',
  solved_count INTEGER,
  fetched_at  INTEGER,
  contest_id  TEXT DEFAULT '',
  problem_index TEXT DEFAULT '',
  PRIMARY KEY(platform, pid)
);
CREATE INDEX IF NOT EXISTS idx_problems_rating ON problems(rating);
CREATE INDEX IF NOT EXISTS idx_problems_tags ON problems(platform);
CREATE INDEX IF NOT EXISTS idx_problems_ac_old ON problems(platform, contest_id, problem_index);

CREATE TABLE IF NOT EXISTS plan_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user        TEXT NOT NULL,
  stage       INTEGER,
  platform    TEXT NOT NULL,
  pid         TEXT NOT NULL,
  name        TEXT DEFAULT '',
  rating      INTEGER,
  tags        TEXT DEFAULT '[]',
  url         TEXT DEFAULT '',
  scheduled_date TEXT DEFAULT '',          -- YYYY-MM-DD
  status      TEXT DEFAULT 'pending',      -- pending | done | skipped
  note        TEXT DEFAULT '',
  created_at  INTEGER,
  UNIQUE(user, platform, pid)
);

CREATE TABLE IF NOT EXISTS busy_days (
  user   TEXT NOT NULL,
  date   TEXT NOT NULL,                    -- YYYY-MM-DD
  reason TEXT DEFAULT '',
  PRIMARY KEY(user, date)
);

CREATE TABLE IF NOT EXISTS virtual_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user        TEXT NOT NULL,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  contest_id  TEXT NOT NULL,
  contest     TEXT DEFAULT '{}',           -- JSON：题目列表等
  start_ts    INTEGER,
  end_ts      INTEGER,
  status      TEXT DEFAULT 'running',      -- running | finished
  notes       TEXT DEFAULT '',             -- 整场笔记 (Markdown)
  problem_notes TEXT DEFAULT '{}',         -- JSON: { pid: "单题思路" }
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user        TEXT NOT NULL,
  name        TEXT NOT NULL,
  problems    TEXT DEFAULT '[]',           -- JSON: [{platform,pid,name,rating,tags,url}]
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS icpc_contests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  series       TEXT NOT NULL,              -- ICPC / CCPC / 省赛 / 邀请赛
  year         INTEGER,
  site         TEXT NOT NULL,              -- 赛站（南京/西安/...）
  contest_name TEXT NOT NULL,
  date         TEXT DEFAULT '',            -- 比赛日期（可空，可编辑）
  problem_count INTEGER DEFAULT 13,        -- 题目数量（参考值，可编辑）
  link         TEXT DEFAULT '',
  problems     TEXT DEFAULT '[]',          -- JSON: [{idx:"A",platform,pid,name,url}]
  UNIQUE(series, year, site)
);

CREATE TABLE IF NOT EXISTS icpc_progress (
  user       TEXT NOT NULL,
  contest_id INTEGER NOT NULL,
  idx        TEXT NOT NULL,                -- A / B / C ...
  status     TEXT DEFAULT 'todo',          -- todo | ac | tried | skipped
  note       TEXT DEFAULT '',
  PRIMARY KEY(user, contest_id, idx)
);

CREATE TABLE IF NOT EXISTS solved_marks (
  user   TEXT NOT NULL,
  platform TEXT NOT NULL,
  pid    TEXT NOT NULL,
  ts     INTEGER,
  PRIMARY KEY(user, platform, pid)
);

CREATE TABLE IF NOT EXISTS sync_state (
  platform   TEXT NOT NULL,
  user       TEXT NOT NULL,
  cursor     TEXT DEFAULT '',              -- 增量游标
  last_sync  INTEGER,
  status     TEXT DEFAULT '',              -- ok | error | syncing
  error      TEXT DEFAULT '',
  PRIMARY KEY(platform, user)
);

CREATE TABLE IF NOT EXISTS model_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_samples (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id     TEXT NOT NULL,
  handle         TEXT NOT NULL,
  pre_rating     INTEGER,
  problem_rating INTEGER,
  tags           TEXT DEFAULT '[]',
  year           INTEGER,
  pos            INTEGER,
  solved         INTEGER,
  UNIQUE(contest_id, handle, problem_rating, pos)
);
`);

// ---------- 通用辅助 ----------

/** 设置项读写（JSON 值） */
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

/** 用户列表 */
function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY platform, id').all();
}
function addUser(platform, handle, label = '') {
  db.prepare(
    'INSERT INTO users(platform, handle, label, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(platform, handle) DO UPDATE SET label = excluded.label'
  ).run(platform, handle, label, Math.floor(Date.now() / 1000));
  return db.prepare('SELECT * FROM users WHERE platform = ? AND handle = ?').get(platform, handle);
}
function removeUser(platform, handle) {
  // 删除账号时清理该账号本地记录
  db.prepare('DELETE FROM users WHERE platform = ? AND handle = ?').run(platform, handle);
  db.prepare('DELETE FROM submissions WHERE platform = ? AND user = ?').run(platform, handle);
  db.prepare('DELETE FROM rating_history WHERE platform = ? AND user = ?').run(platform, handle);
  db.prepare('DELETE FROM sync_state WHERE platform = ? AND user = ?').run(platform, handle);
}

function getSyncState(platform, user) {
  const row = db.prepare('SELECT * FROM sync_state WHERE platform = ? AND user = ?').get(platform, user);
  return row || { platform, user, cursor: '', last_sync: null, status: '', error: '' };
}
function setSyncState(platform, user, patch) {
  const cur = getSyncState(platform, user);
  const next = { ...cur, ...patch };
  db.prepare(
    `INSERT INTO sync_state(platform, user, cursor, last_sync, status, error)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, user) DO UPDATE SET
       cursor = excluded.cursor, last_sync = excluded.last_sync,
       status = excluded.status, error = excluded.error`
  ).run(next.platform, next.user, next.cursor, next.last_sync, next.status, next.error);
}

module.exports = { db, DB_PATH, DATA_DIR, getSetting, setSetting, listUsers, addUser, removeUser, getSyncState, setSyncState };
