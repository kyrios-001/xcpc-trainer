'use strict';
/**
 * scripts/sync-problems.js — 手动刷新题库缓存
 * Codeforces 题库（约 3500 题）+ AtCoder 题库（约 1 万题，含 Kenkoooo 难度）。
 * 默认 7 天刷新一次；server.js 在首次启动/同步时也会按需拉取。
 */
const cf = require('../lib/cf');
const ac = require('../lib/ac');

async function main() {
  console.log('同步 Codeforces 题库...');
  const r1 = await cf.syncProblemset('codeforces', 0);
  console.log(`  CF 题库 ${r1.count} 题`);

  console.log('同步 AtCoder 题库（problems.json + problem-models.json，约 5MB）...');
  await ac.ensureProblemCatalog(true);
  const count = require('../lib/db').db.prepare("SELECT COUNT(*) c FROM problems WHERE platform = 'atcoder'").get().c;
  console.log(`  AC 题库 ${count} 题`);
  console.log('完成。');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
