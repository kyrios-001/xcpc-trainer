'use strict';
/**
 * lib/model.js — 「以你当前水平能否做出这道题」的二分类模型（可选）
 * 逻辑回归，零依赖。特征只用比赛当场能拿到的信息（无未来信息）：
 *   赛前 rating、题目难度、难度差、知识方向（one-hot）、方向×超纲程度交互、题目年代、题号位置。
 * 训练时按比赛时间切分：较早比赛训练，最近 15% 留出检验。
 * 只有留出集 AUC ≥ 0.75 且明显优于“只看难度差”基线时才会启用，否则继续用内置规则。
 */
const dbm = require('./db');
const { DIRECTIONS, directionOfTag } = require('./knowledge');

const DIR_INDEX = new Map(DIRECTIONS.map((d, i) => [d.key, i]));

/** 特征向量（含 bias 维度 x0=1） */
function features(preRating, problemRating, tags, year, position) {
  const diff = (problemRating || 0) - (preRating || 0);
  const xs = [1.0, (preRating || 0) / 1000, (problemRating || 0) / 1000, diff / 1000];
  const dirOneHot = new Array(DIRECTIONS.length).fill(0);
  let dirIdx = -1;
  for (const t of tags || []) {
    const d = directionOfTag(t);
    if (d != null && DIR_INDEX.has(d)) { dirIdx = DIR_INDEX.get(d); break; }
  }
  if (dirIdx >= 0) dirOneHot[dirIdx] = 1;
  xs.push(...dirOneHot);
  // 方向 × 超纲程度交互：难度差超过 +100 时该方向的惩罚项
  xs.push(dirIdx >= 0 ? (dirIdx + 1) * Math.max(0, diff - 100) / 1000 : 0);
  xs.push((year - 2015) / 10);
  xs.push(position / 12);
  return xs;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function predict(xs, w) {
  let z = 0;
  for (let i = 0; i < xs.length; i++) z += xs[i] * (w[i] || 0);
  return sigmoid(z);
}

/** 梯度下降训练（L2 正则） */
function trainLogistic(X, y, { epochs = 80, lr = 0.5, l2 = 0.001 } = {}) {
  const n = X.length, d = X[0].length;
  let w = new Array(d).fill(0);
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const p = predict(X[i], w);
      const err = p - y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
  }
  return w;
}

function auc(y, p) {
  const idx = y.map((_, i) => i).sort((a, b) => p[b] - p[a]);
  let rankSum = 0;
  for (let i = 0; i < idx.length; i++) if (y[idx[i]] === 1) rankSum += i + 1;
  const pos = y.filter((v) => v === 1).length, neg = y.length - pos;
  if (!pos || !neg) return 0.5;
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg);
}

function logloss(y, p) {
  let s = 0;
  for (let i = 0; i < y.length; i++) {
    const q = Math.min(0.9999, Math.max(0.0001, p[i]));
    s += -y[i] * Math.log(q) - (1 - y[i]) * Math.log(1 - q);
  }
  return s / y.length;
}

/** 保存/读取模型状态 */
function saveModel({ params, baseParams, auc, baseAuc, logloss, baseLogloss, enabled, samples, trainedAt, note }) {
  dbm.db.prepare(
    `INSERT INTO model_state(key, value) VALUES('model', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify({ params, baseParams, auc, baseAuc, logloss, baseLogloss, enabled, samples, trainedAt, note }));
}
function loadModel() {
  const row = dbm.db.prepare("SELECT value FROM model_state WHERE key = 'model'").get();
  return row ? JSON.parse(row.value) : null;
}

/** 启用模型的预测：给定题目难度/标签/年代/位置 → p(solve|当前基线) */
function scoreProblem(preRating, problemRating, tags, year, position) {
  const m = loadModel();
  if (!m || !m.enabled || !m.params) return null;
  return predict(features(preRating, problemRating, tags, year, position), m.params);
}

module.exports = { features, predict, trainLogistic, auc, logloss, saveModel, loadModel, scoreProblem };
