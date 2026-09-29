'use strict';
/**
 * lib/knowledge.js — 知识点建模
 * 把 Codeforces 官方 tag 归为 8 个知识方向；用加权分位数估计方向水平；
 * 给出样本置信度与 0~100 的弱项指数。统计口径参考 OJ Insight / ACM Tracker 思路。
 */

/** 8 个知识方向 */
const DIRECTIONS = [
  { key: 'implementation', name: '基础与模拟' },
  { key: 'data_structures', name: '数据结构' },
  { key: 'graphs', name: '图论与树' },
  { key: 'dp', name: '动态规划' },
  { key: 'math', name: '数学' },
  { key: 'strings', name: '字符串' },
  { key: 'search_construct', name: '搜索与构造' },
  { key: 'greedy', name: '贪心与思维' },
];

/** CF 官方 tag → 方向 */
const TAG_DIRECTION = {
  implementation: 'implementation', 'brute force': 'implementation',
  sortings: 'implementation', interactive: 'implementation',
  'expression parsing': 'implementation', random: 'implementation',
  'data structures': 'data_structures', dsu: 'data_structures', hashing: 'data_structures',
  graphs: 'graphs', trees: 'graphs', 'dfs and similar': 'graphs',
  'shortest paths': 'graphs', flows: 'graphs', 'graph matchings': 'graphs', '2-sat': 'graphs',
  dp: 'dp', bitmasks: 'dp', matrices: 'dp', 'meet-in-the-middle': 'dp',
  math: 'math', 'number theory': 'math', combinatorics: 'math', geometry: 'math',
  probabilities: 'math', games: 'math', 'chinese remainder theorem': 'math', fft: 'math',
  strings: 'strings', 'string suffix structures': 'strings',
  'constructive algorithms': 'search_construct', 'ternary search': 'search_construct',
  'divide and conquer': 'search_construct',
  greedy: 'greedy', 'binary search': 'greedy', 'two pointers': 'greedy',
};

/** 洛谷 tag 名 → CF 风格 tag（用于方向配额与画像） */
const LUOGU_TAG_MAP = {
  '模拟': 'implementation', '枚举': 'brute force', '排序': 'sortings',
  '动态规划': 'dp', 'DP': 'dp', '状态压缩': 'bitmasks', '矩阵快速幂': 'matrices',
  '分治': 'divide and conquer', '贪心': 'greedy', '二分': 'binary search', '双指针': 'two pointers',
  '数据结构': 'data structures', '并查集': 'dsu', '哈希': 'hashing',
  '图论': 'graphs', '树': 'trees', '最短路': 'shortest paths', '网络流': 'flows',
  '匹配': 'graph matchings', '拓扑排序': 'graphs',
  '数学': 'math', '数论': 'number theory', '组合数学': 'combinatorics',
  '计算几何': 'geometry', '博弈论': 'games', '概率': 'probabilities',
  '字符串': 'strings', '后缀数组': 'string suffix structures',
  '搜索': 'dfs and similar', 'BFS': 'dfs and similar', 'DFS': 'dfs and similar',
  '构造': 'constructive algorithms', '交互': 'interactive',
  '线性代数': 'matrices', '生成函数': 'math', '多项式': 'math',
};

/** 洛谷官方难度档 → CF 折算区间（用于参与计划与画像，估计值） */
const LUOGU_TIER = [
  { key: 0, name: '入门', low: 800, high: 1199 },
  { key: 1, name: '普及-', low: 1200, high: 1399 },
  { key: 2, name: '普及/提高-', low: 1400, high: 1549 },
  { key: 3, name: '普及+/提高', low: 1550, high: 1849 },
  { key: 4, name: '提高+/省选-', low: 1850, high: 2099 },
  { key: 5, name: '省选/NOI-', low: 2100, high: 2349 },
  { key: 6, name: 'NOI/NOI+/CTSC', low: 2350, high: 2800 },
];

function luoguTierName(key) {
  const t = LUOGU_TIER.find((x) => x.key === key);
  return t ? t.name : '未评级';
}
function luoguTierRating(key) {
  const t = LUOGU_TIER.find((x) => x.key === key);
  return t ? Math.round((t.low + t.high) / 2) : null;
}

function normalizeTags(rawTags) {
  if (!Array.isArray(rawTags)) rawTags = [];
  const out = new Set();
  for (let t of rawTags) {
    if (!t) continue;
    t = String(t).trim().toLowerCase();
    if (!t) continue;
    const mapped = LUOGU_TAG_MAP[t] || (TAG_DIRECTION[t] ? t : null);
    if (mapped) out.add(mapped);
    else if (!TAG_DIRECTION[t]) out.add('other:' + t); // 未识别标签单独归入 other
  }
  return [...out];
}

function directionOfTag(tag) {
  if (!tag) return null;
  if (tag.startsWith('other:')) return null;
  return TAG_DIRECTION[tag] || null;
}

/** 把平台提交记录计算为方向画像 */
function buildCapability(solvedProblems, targetRating) {
  // solvedProblems: [{rating, tags[]}]（rating 可为 null）
  const buckets = {};
  for (const d of DIRECTIONS) buckets[d.key] = { samples: [] };
  let solvedWithRating = 0, solvedTotal = 0;

  for (const p of solvedProblems) {
    solvedTotal++;
    if (p.rating == null) continue;
    solvedWithRating++;
    const tags = normalizeTags(p.tags || []);
    for (const t of tags) {
      const dir = directionOfTag(t);
      if (dir && buckets[dir]) buckets[dir].samples.push(p.rating);
    }
  }

  const low = targetRating - 250, mid = targetRating - 50, high = targetRating + 150;
  const profile = DIRECTIONS.map((d) => {
    const samples = buckets[d.key].samples;
    const n = samples.length;
    let rep = null, confidence = 0, weakIndex = null;
    if (n > 0) {
      const sorted = [...samples].sort((a, b) => a - b);
      // 75 分位（线性插值）
      const pos = 0.75 * (sorted.length - 1);
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      rep = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
      // 置信度：样本量越足越可信，50 题封顶
      confidence = Math.min(1, n / 50);
      // 弱项指数：练习区间下沿以下 = 100，区间中心 = 0，线性过渡，并按置信度打折
      if (rep <= low) weakIndex = 100;
      else if (rep >= mid) weakIndex = 0;
      else weakIndex = ((mid - rep) / (mid - low)) * 100;
      weakIndex = Math.round(weakIndex * (0.3 + 0.7 * confidence));
    }
    return { key: d.key, name: d.name, rep: rep ? Math.round(rep) : null, n, confidence: +confidence.toFixed(2), weakIndex, blind: n === 0 };
  });

  return { directions: profile, stats: { solvedTotal, solvedWithRating } };
}

module.exports = {
  DIRECTIONS, TAG_DIRECTION, LUOGU_TAG_MAP, LUOGU_TIER,
  normalizeTags, directionOfTag, luoguTierName, luoguTierRating, buildCapability,
};
