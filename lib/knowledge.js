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
  // 基础
  '模拟': 'implementation', '枚举': 'brute force', '排序': 'sortings',
  '贪心': 'greedy', '二分': 'binary search', '三分': 'ternary search',
  '双指针': 'two pointers', '前缀和': 'implementation', '差分': 'implementation',
  '高精度': 'implementation', '进制转换': 'implementation', '位运算': 'bitmasks',
  // DP 家族
  '动态规划': 'dp', 'DP': 'dp', '线性DP': 'dp', '区间DP': 'dp', '环形DP': 'dp',
  '树形DP': 'dp', '数位DP': 'dp', '状压DP': 'dp', '状态压缩': 'bitmasks',
  '轮廓线DP': 'dp', '插头DP': 'dp', '斜率优化': 'dp', '四边形不等式': 'dp',
  '背包': 'dp', '01背包': 'dp', '完全背包': 'dp', '分组背包': 'dp', '多重背包': 'dp',
  '记忆化搜索': 'dp', '递推': 'dp', '矩阵快速幂': 'matrices', '矩阵乘法': 'matrices',
  // 数据结构
  '数据结构': 'data structures', '并查集': 'dsu', '哈希': 'hashing', '字符串哈希': 'hashing',
  '栈': 'data structures', '队列': 'data structures', '堆': 'data structures',
  '链表': 'data structures', '单调栈': 'data structures', '单调队列': 'data structures',
  '线段树': 'data structures', '树状数组': 'data structures', 'ST表': 'data structures',
  '平衡树': 'data structures', '可持久化线段树': 'data structures', '左偏树': 'data structures',
  '字典树': 'strings', 'Trie': 'strings', 'KMP': 'strings', 'AC自动机': 'strings',
  '倍增': 'data structures', '分块': 'data structures', '莫队': 'data structures',
  // 图论
  '图论': 'graphs', '树': 'trees', '生成树': 'graphs', '最小生成树': 'graphs',
  '最短路': 'shortest paths', '网络流': 'flows', '最大流': 'flows', '最小割': 'flows',
  '费用流': 'flows', '二分图': 'graph matchings', '匹配': 'graph matchings',
  '匈牙利算法': 'graph matchings', '拓扑排序': 'graphs',
  '割点': 'graphs', '桥': 'graphs', '强连通分量': 'graphs', '双连通分量': 'graphs',
  'Tarjan': 'graphs', 'LCA': 'trees', '最近公共祖先': 'trees', '树链剖分': 'trees',
  '树上差分': 'trees', '树上倍增': 'trees', '虚树': 'trees', '点分治': 'divide and conquer',
  '欧拉回路': 'graphs', '基环树': 'trees', '仙人掌': 'graphs', '差分约束': 'graphs',
  '2-SAT': '2-sat', '弦图': 'graphs', '边双联通分量': 'graphs',
  // 数学
  '数学': 'math', '数论': 'number theory', '组合数学': 'combinatorics',
  '计算几何': 'geometry', '博弈论': 'games', '概率': 'probabilities', '期望': 'probabilities',
  '快速幂': 'number theory', '素数判断': 'number theory', '质因数分解': 'number theory',
  '最大公约数': 'number theory', '最小公倍数': 'number theory', '欧拉函数': 'number theory',
  '费马小定理': 'number theory', '扩展欧几里得': 'number theory', '线性基': 'matrices',
  '高斯消元': 'matrices', '线性代数': 'matrices', '生成函数': 'math', '多项式': 'math',
  'FFT': 'fft', 'NTT': 'math', '容斥': 'combinatorics', '抽屉原理': 'combinatorics',
  '斐波那契': 'math', '卡特兰数': 'combinatorics', '卢卡斯定理': 'number theory',
  '中国剩余定理': 'chinese remainder theorem', '逆元': 'number theory',
  // 字符串
  '字符串': 'strings', '后缀数组': 'string suffix structures', '后缀自动机': 'string suffix structures',
  '回文自动机': 'string suffix structures', '字符串匹配': 'strings', '最小表示法': 'strings',
  // 搜索与构造
  '搜索': 'dfs and similar', 'BFS': 'dfs and similar', 'DFS': 'dfs and similar',
  '剪枝': 'dfs and similar', '搜索与回溯': 'dfs and similar', '迭代加深': 'dfs and similar',
  '双向搜索': 'dfs and similar', 'A*': 'dfs and similar', 'IDA*': 'dfs and similar',
  '启发式搜索': 'dfs and similar', '随机化': 'random',
  '构造': 'constructive algorithms', '交互': 'interactive', '卡常': 'implementation',
  '整体二分': 'divide and conquer', 'CDQ分治': 'divide and conquer', '分治': 'divide and conquer',
  '归并排序': 'sortings', '模拟退火': 'implementation', '爬山算法': 'implementation',
};

/**
 * 洛谷官方难度档 → CF 折算区间（估计值）。
 * 档位 key 与洛谷列表页 difficulty 参数一致（2024 新版难度体系，已实测验证）：
 *   difficulty=0 暂无评定、1 入门、2 普及−、3 普及、4 普及+/提高、5 提高、6 提高+/省选−、7 省选/NOI−
 * key 0（暂无评定）不入库、不折算。
 */
const LUOGU_TIER = [
  { key: 0, name: '暂无评定', low: null, high: null },
  { key: 1, name: '入门', low: 800, high: 1199 },
  { key: 2, name: '普及−', low: 1200, high: 1399 },
  { key: 3, name: '普及', low: 1400, high: 1549 },
  { key: 4, name: '普及+/提高', low: 1550, high: 1849 },
  { key: 5, name: '提高', low: 1850, high: 2099 },
  { key: 6, name: '提高+/省选−', low: 2100, high: 2349 },
  { key: 7, name: '省选/NOI−', low: 2350, high: 2800 },
];
// 档位表 schema 版本：改变时 importTier 会清空旧档位数据重新抓取
const LUOGU_TIER_SCHEMA = 2;

function luoguTierName(key) {
  const t = LUOGU_TIER.find((x) => x.key === key);
  return t ? t.name : '未评级';
}
function luoguTierRating(key) {
  const t = LUOGU_TIER.find((x) => x.key === key);
  return t && t.low != null ? Math.round((t.low + t.high) / 2) : null;
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
  DIRECTIONS, TAG_DIRECTION, LUOGU_TAG_MAP, LUOGU_TIER, LUOGU_TIER_SCHEMA,
  normalizeTags, directionOfTag, luoguTierName, luoguTierRating, buildCapability,
};
