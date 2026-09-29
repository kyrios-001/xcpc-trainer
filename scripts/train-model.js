'use strict';
/**
 * scripts/train-model.js — 采集 CF 历史比赛并训练「能否做出」模型
 * 用法：
 *   npm run train                      # 默认 300 场，约十几分钟
 *   npm run train -- --contests 20     # 小规模试跑
 *   npm run train -- --train-only      # 用已采好的样本重新训练
 * 每场比赛 2 个请求（成绩单 + rating 变化），按官方建议 2 秒间隔串行发送。
 * 非 gym 比赛成绩单只接受匿名请求，这里一页拿全场，再等距抽样控制每场 200 人。
 */
const cf = require('../lib/cf');
const model = require('../lib/model');
const { normalizeTags } = require('../lib/knowledge');
const dbm = require('../lib/db');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const CONTESTS = parseInt(flag('contests', '300'), 10);
const TRAIN_ONLY = args.includes('--train-only');

function indexPos(index) {
  return (index || 'A').charCodeAt(0) - 65;
}

async function collectSamples(limit) {
  const contests = await cf.getContests(true);
  const candidates = (contests || [])
    .filter((c) => c.phase === 'FINISHED' && c.type === 'CF' && c.startTimeSeconds > new Date('2018-01-01').getTime() / 1000)
    .sort((a, b) => b.startTimeSeconds - a.startTimeSeconds);

  // 跳过已采集过的比赛
  const done = new Set(dbm.getSetting('model_sampled_contests', []));
  const toFetch = [];
  for (const c of candidates) {
    if (done.has(String(c.id))) continue;
    toFetch.push(c);
    if (toFetch.length >= limit) break;
  }
  console.log(`计划采集 ${toFetch.length} 场比赛...`);

  const st = dbm.db.prepare(
    'INSERT OR IGNORE INTO model_samples(contest_id, handle, pre_rating, problem_rating, tags, year, pos, solved) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let rows = 0;
  for (const c of toFetch) {
    try {
      const [standings, changes] = await Promise.all([
        cf.rawFetch(`contest.standings?contestId=${c.id}`, { anonymous: true }),
        cf.rawFetch(`contest.ratingChanges?contestId=${c.id}`),
      ]);
      if (!standings || !standings.problems || !changes) continue;
      const year = new Date(c.startTimeSeconds * 1000).getFullYear();
      const problems = standings.problems.map((p) => ({
        index: p.index, rating: p.rating ?? null, tags: normalizeTags(p.tags || []),
      }));
      const ratingByHandle = {};
      for (const ch of changes) ratingByHandle[ch.handle] = ch.oldRating;
      // 等距抽样：每场最多 200 名选手
      const rowsArr = standings.rows || [];
      const step = Math.max(1, Math.floor(rowsArr.length / 200));
      for (let i = 0; i < rowsArr.length; i += step) {
        const row = rowsArr[i];
        const pre = ratingByHandle[row.party.members[0].handle];
        if (pre == null) continue;
        const results = row.problemResults || [];
        for (let j = 0; j < problems.length; j++) {
          const p = problems[j];
          if (p.rating == null) continue;
          const solved = results[j] && results[j].points > 0 ? 1 : 0;
          st.run(String(c.id), row.party.members[0].handle, pre, p.rating,
            JSON.stringify(p.tags), year, indexPos(p.index), solved);
          rows++;
        }
      }
      const done2 = new Set(dbm.getSetting('model_sampled_contests', []));
      done2.add(String(c.id));
      dbm.setSetting('model_sampled_contests', [...done2]);
      console.log(`  ${c.id} ${c.name}: +${rowsArr.length / step | 0} 名选手样本`);
    } catch (e) {
      console.log(`  ${c.id} 跳过: ${e.message}`);
    }
  }
  return rows;
}

function loadAllSamples() {
  return dbm.db.prepare('SELECT * FROM model_samples ORDER BY year, contest_id').all();
}

function trainFromSamples() {
  const samples = loadAllSamples();
  if (samples.length < 500) {
    console.log(`样本不足（${samples.length}），至少需要 500 条。请先采集：npm run train -- --contests N`);
    return;
  }
  // 按年份时间切分：最近 15% 留出
  const years = [...new Set(samples.map((s) => s.year))].sort((a, b) => a - b);
  const testYear = years[Math.floor(years.length * 0.85)];
  const trainS = samples.filter((s) => s.year < testYear);
  const testS = samples.filter((s) => s.year >= testYear);
  console.log(`样本 ${samples.length}（训练 ${trainS.length} / 检验 ${testS.length}，按年份 ${testYear} 切分）`);

  const feats = (s) => model.features(s.pre_rating, s.problem_rating, JSON.parse(s.tags || '[]'), s.year, s.pos);
  const Xt = trainS.map(feats), yt = trainS.map((s) => s.solved);
  const Xe = testS.map(feats), ye = testS.map((s) => s.solved);

  // 全模型
  const w = model.trainLogistic(Xt, yt);
  // 基线：只看难度差（pre_rating、problem_rating、diff）
  const baseW = model.trainLogistic(Xt.map((x) => [1, x[1], x[2], x[3]]), yt);

  const p = Xe.map((x) => model.predict(x, w));
  const pb = Xe.map((x) => model.predict([x[0], x[1], x[2], x[3]], baseW));
  const a = model.auc(ye, p), l = model.logloss(ye, p);
  const ab = model.auc(ye, pb), lb = model.logloss(ye, pb);

  const enabled = a >= 0.75 && (a >= ab + 0.005 || l <= lb * 0.99);
  let note = '';
  if (!enabled) {
    note = a < 0.75 ? `留出集 AUC=${a.toFixed(3)} 未达 0.75` : `未明显优于基线（AUC ${a.toFixed(3)} vs ${ab.toFixed(3)}）`;
  }
  model.saveModel({
    params: w, baseParams: baseW, auc: a, baseAuc: ab, logloss: l, baseLogloss: lb,
    enabled, samples: samples.length, trainedAt: Date.now(), note,
  });
  console.log(`全模型: AUC=${a.toFixed(4)} LogLoss=${l.toFixed(4)}`);
  console.log(`基线  : AUC=${ab.toFixed(4)} LogLoss=${lb.toFixed(4)}`);
  console.log(enabled ? '✅ 模型已启用（训练计划将使用模型选择题目）' : `❌ 未启用：${note || '继续用内置规则'}`);
}

async function main() {
  if (!TRAIN_ONLY) {
    const added = await collectSamples(CONTESTS);
    console.log(`共新增 ${added} 条样本`);
  }
  trainFromSamples();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
