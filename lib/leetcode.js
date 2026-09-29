'use strict';
/**
 * lib/leetcode.js — LeetCode GraphQL API
 * 国际站: https://leetcode.com/graphql
 * 中国站: cn:前缀 -> leetcode.cn（字段不同，暂用简单查询）
 */

async function syncUser(handle) {
  const isCN = handle.startsWith('cn:');
  const name = isCN ? handle.slice(3) : handle;
  const base = isCN ? 'https://leetcode.cn' : 'https://leetcode.com';

  const query = {
    query: `query($username: String!) {
      matchedUser(username: $username) {
        username
        profile { ranking }
        submitStats { acSubmissionNum { difficulty count } }
      }
    }`,
    variables: { username: name },
  };

  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': 'application/json',
      'Referer': base,
    },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (j.errors || !j.data?.matchedUser) {
    throw new Error(`LeetCode 用户 ${name} 不存在或无法访问`);
  }
  const u = j.data.matchedUser;
  const all = u.submitStats.acSubmissionNum.find((x) => x.difficulty === 'All');
  return {
    solved: all ? all.count : 0,
    ranking: u.profile?.ranking || 0,
    username: u.username || name,
  };
}

module.exports = { syncUser };
