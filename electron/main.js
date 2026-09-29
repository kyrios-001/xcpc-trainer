'use strict';
/**
 * electron/main.js — XCPC 训练台桌面版主进程
 * 方案：以 ELECTRON_RUN_AS_NODE 模式拉起内置 HTTP 服务（随机端口），再用原生窗口打开。
 * 与网页版共用同一套后端与界面代码；数据目录指向 %APPDATA%/xcpc-trainer/data。
 */
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, shell } = require('electron');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const USER_DATA = app.getPath('userData'); // Windows: %APPDATA%/xcpc-trainer
const DATA_DIR = path.join(USER_DATA, 'data');

let serverProc = null;
let mainWindow = null;
let currentPort = 0;

/** 用 ELECTRON_RUN_AS_NODE 把 electron.exe 当纯 Node 跑 server.js */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-sqlite',
      SERVER_JS,
    ], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: '0',
        DATA_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    serverProc = child;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const m = buf.match(/XC_PORT=(\d+)/);
      if (m) resolve(+m[1]);
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => {
      if (code !== 0 && !mainWindow) reject(new Error(`内置服务退出 code=${code}`));
    });
    setTimeout(() => reject(new Error('等待内置服务端口超时')), 15000).unref?.();
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'XCPC 训练台',
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(url);
  // 题目/比赛链接交给系统浏览器打开，不在应用内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    const u = new URL(target);
    if (u.origin !== new URL(url).origin) {
      e.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; console.log('[xcpc-trainer] window closed'); });
  mainWindow.webContents.on('render-process-gone', (_e, details) => console.log('[xcpc-trainer] renderer gone', details.reason));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => console.log('[xcpc-trainer] did-fail-load', code, desc));
}

function cleanup() {
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
  }
}

// 单实例：重复打开时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
console.log('[xcpc-trainer] single-instance-lock =', gotLock, 'userData =', USER_DATA);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    console.log('[xcpc-trainer] app ready, starting server...');
    try {
      const port = await startServer();
      console.log('[xcpc-trainer] server up on', port);
      currentPort = port;
      createWindow(`http://127.0.0.1:${port}/`);
      console.log('[xcpc-trainer] window created');
    } catch (e) {
      console.error('[xcpc-trainer]', e);
      app.quit();
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverProc && currentPort) {
        createWindow(`http://127.0.0.1:${currentPort}/`);
      }
    });
  });

  process.on('uncaughtException', (e) => console.error('[xcpc-trainer] uncaught', e));
  process.on('unhandledRejection', (e) => console.error('[xcpc-trainer] unhandledRejection', e));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', cleanup);
  app.on('will-quit', cleanup);
  process.on('exit', cleanup);
}

module.exports = { startServer, createWindow };
