'use strict';
/**
 * scripts/desktop-smoke.mjs — 桌面版冒烟测试
 * 以隐藏窗口启动，检查页面是否渲染成功、有无 JS 报错，然后退出。
 * 用法：npm run desktop-smoke
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, '..', 'server.js');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--experimental-sqlite', SERVER_JS,
    ], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: '0',
        DATA_DIR: path.join(app.getPath('temp'), 'xcpc-trainer-smoke'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const m = buf.match(/XC_PORT=(\d+)/);
      if (m) resolve({ port: +m[1], child });
    });
    child.on('exit', (code) => reject(new Error(`服务退出 code=${code}`)));
    setTimeout(() => reject(new Error('等待端口超时')), 15000);
  });
}

let errors = [];

app.whenReady().then(async () => {
  try {
    const { port, child } = await startServer();
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    win.webContents.on('console-message', (_e, level, message) => {
      // level: 0=verbose 1=info 2=warning 3=error —— 只有真实 JS error 才算失败
      if (level >= 3) errors.push(String(message));
    });
    win.webContents.on('did-finish-load', async () => {
      const title = win.webContents.getTitle();
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length');
      const ok = /XCPC/.test(title) && html > 2000;
      console.log(`[desktop-smoke] title=${title} htmlBytes=${html} jsErrors=${errors.length}`);
      child.kill();
      app.exit(ok && errors.length === 0 ? 0 : 1);
    });
    win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (e) {
    console.error('[desktop-smoke]', e);
    app.exit(1);
  }
});
