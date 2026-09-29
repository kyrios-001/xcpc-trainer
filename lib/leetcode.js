'use strict';
/**
 * lib/leetcode.js — LeetCode 客户端（公开 API，无需登录）
 * 国际站: https://leetcode.com/api/user/{username}/
 * 中国站: 用户名以 cn: 开头时走 leetcode.cn
 */
const dbm = require('./db');

async function syncUser(handle) {
  const isCN = handle.startsWith('cn:');
  const name = isCN ? handle.slice(3) : handle;
  const base = isCN ? 'https://leetcode.cn' : 'https://leetcode.com';
  const res = await fetch(`${base}/api/user/${encodeURIComponent(name)}/`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`LeetCode 返回 HTTP ${res.status}（用户 ${name} 可能不存在）`);
  const data = await res.json();
  // 存一个"虚拟提交记录"点，让 stats 能展示
  const solved = data.totalSolved || data.acceptedQuestionCount || 0;
  return { solved, ranking: data.ranking || 0, username: data.username || name };
}

module.exports = { syncUser };
