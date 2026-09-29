// scripts/smoke.mjs — 服务冒烟测试：启动服务、请求关键 API、检查前端可访问
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT || 5173;
const child = spawn(process.execPath,
  ['--disable-warning=ExperimentalWarning', '--experimental-sqlite', 'server.js'],
  { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

let failed = false;
async function check(name, fn) {
  try {
    const v = await fn();
    console.log(`[ok] ${name}${v !== undefined ? ' -> ' + v : ''}`);
  } catch (e) {
    failed = true;
    console.log(`[FAIL] ${name}: ${e.message}`);
  }
}

try {
  // 等待服务就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch { /* not yet */ }
    await sleep(250);
  }
  if (!ready) throw new Error('服务未在 10 秒内就绪');

  await check('GET /api/health', async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).status);
  await check('GET / (首页 HTML)', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    if (!html.includes('XCPC')) throw new Error('页面缺少 XCPC 标记');
    return 'HTML 可访问';
  });
  await check('GET /api/settings', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/settings`);
    return (await r.json()).platforms ? 'ok' : 'no platforms';
  });
  await check('GET /api/stats (空数据)', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/stats`);
    const j = await r.json();
    return `per=${j.per.length}, solved=${j.merged.solved}`;
  });
  await check('GET /api/contests (无网络兜底)', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/contests`);
    const j = await r.json();
    return `items=${j.length}`;
  });
  await check('GET /api/sets (ICPC 目录 seed)', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/sets`);
    const j = await r.json();
    return `contests=${(j.contests || []).length}`;
  });
  await check('POST /api/plan/generate (无账号)', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/plan/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 1800, weekly: 10, mixAtcoder: false, mixLuogu: false }),
    });
    const j = await r.json();
    return `items=${j.items ? j.items.length : 'none'}, stages=${j.stages ? j.stages.length : 'none'}`;
  });
  await check('GET /static css', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/css/style.css`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return 'css 可访问';
  });
} finally {
  child.kill();
  await sleep(300);
  if (failed) {
    console.log('\n--- 服务日志尾部 ---');
    console.log(log.slice(-2000));
    process.exit(1);
  } else {
    console.log('\n冒烟测试全部通过。');
    process.exit(0);
  }
}
