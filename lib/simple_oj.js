'use strict';
/**
 * lib/simple_oj.js — 简易 OJ 平台
 * HDU: 能抓公开主页 AC 数
 * POJ/VJudge/牛客/QOJ: 反爬或 SPA，暂只记录账号，不发起不可靠请求
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchText(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function syncHdu(handle) {
  const html = await fetchText(`http://acm.hdu.edu.cn/userstatus.php?user=${encodeURIComponent(handle)}`);
  if (/No such user|没找到|不存在/i.test(html)) throw new Error(`HDU 用户 ${handle} 不存在`);
  const solved = (html.match(/Problems Solved[\s\S]{0,80}?<\/td>\s*<td[^>]*>\s*(\d+)/i) || [])[1];
  return { solved: solved ? +solved : 0 };
}

// POJ: 403 反爬，不硬抓
async function syncPoj() {
  return { solved: 0, note: 'POJ 反爬限制自动抓取，账号已记录' };
}

// VJudge: SPA，HTML 无数据
async function syncVjudge() {
  return { solved: 0, note: 'VJudge 为前端渲染，暂不支持自动抓取，账号已记录' };
}

async function syncNowcoder() {
  return { solved: 0, note: '牛客逐题数据需登录 Cookie，账号已记录' };
}

async function syncQoj() {
  return { solved: 0, note: 'QOJ 逐题数据需 UOJSESSID，账号已记录' };
}

module.exports = { handlers: { hdu: syncHdu, poj: syncPoj, vjudge: syncVjudge, nowcoder: syncNowcoder, qoj: syncQoj } };
