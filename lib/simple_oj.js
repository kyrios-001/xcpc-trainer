'use strict';
/**
 * lib/simple_oj.js — 简易 OJ 平台抓取（HDU / POJ / VJudge / 牛客 / QOJ）
 * 这些平台没有公开 API，只抓用户公开主页提取 AC 总数和排名。
 * 不做逐题同步（需要登录或 API 才可靠）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchText(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9', ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// HDU: http://acm.hdu.edu.cn/userstatus.php?user=xxx
async function syncHdu(handle) {
  const html = await fetchText(`http://acm.hdu.edu.cn/userstatus.php?user=${encodeURIComponent(handle)}`);
  if (/No such user|没找到|不存在/.test(html)) throw new Error(`HDU 用户 ${handle} 不存在`);
  // 页面里有 "Problems Submitted" 和 "Problems Solved" 表格
  const solved = (html.match(/Problems Solved[^<]*<\/td>\s*<td[^>]*>\s*(\d+)/i) || [])[1];
  const submitted = (html.match(/Problems Submitted[^<]*<\/td>\s*<td[^>]*>\s*(\d+)/i) || [])[1];
  return { solved: solved ? +solved : 0, submitted: submitted ? +submitted : 0 };
}

// POJ: http://poj.org/userstatus?user=xxx
async function syncPoj(handle) {
  const html = await fetchText(`http://poj.org/userstatus?user=${encodeURIComponent(handle)}`);
  if (/No such user|User .* does not exist/.test(html)) throw new Error(`POJ 用户 ${handle} 不存在`);
  // 页面有 "Total Accepted" 和 "Total Submitted"
  const accepted = (html.match(/Total Accepted[^<]*<\/td>\s*<td[^>]*>\s*(\d+)/i) || [])[1];
  return { solved: accepted ? +accepted : 0 };
}

// VJudge: https://vjudge.net/user/xxx
async function syncVjudge(handle) {
  const html = await fetchText(`https://vjudge.net/user/${encodeURIComponent(handle)}`);
  // VJudge 是 SPA，数据在 window.__INITIAL_STATE__ 里
  const m = html.match(/"accepted":(\d+)/) || html.match(/accepted["':\s]+(\d+)/);
  return { solved: m ? +m[1] : 0 };
}

// 牛客: https://www.nowcoder.com/profile/xxx (数字 UID)
async function syncNowcoder(uid) {
  const html = await fetchText(`https://www.nowcoder.com/profile/${encodeURIComponent(uid)}`);
  // 牛客是 SPA，公开数据有限；先抓页面标题确认用户存在
  if (/未找到|404|不存在/.test(html)) throw new Error(`牛客用户 ${uid} 不存在`);
  return { solved: 0, note: '牛客逐题数据需登录 Cookie，暂只记录账号' };
}

// QOJ: https://qoj.ac/user/profile/xxx
async function syncQoj(handle) {
  const html = await fetchText(`https://qoj.ac/user/profile/${encodeURIComponent(handle)}`, 'https://qoj.ac/');
  if (/404|Not Found|用户不存在/.test(html)) throw new Error(`QOJ 用户 ${handle} 不存在`);
  return { solved: 0, note: 'QOJ 逐题数据需 UOJSESSID Cookie，暂只记录账号' };
}

const handlers = {
  hdu: syncHdu,
  poj: syncPoj,
  vjudge: syncVjudge,
  nowcoder: syncNowcoder,
  qoj: syncQoj,
};

module.exports = { handlers };
