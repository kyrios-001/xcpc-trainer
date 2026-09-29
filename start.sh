#!/usr/bin/env bash
# XCPC 训练台启动脚本（Linux / macOS）
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node 22.5+：https://nodejs.org/"
  exit 1
fi
echo "启动 XCPC 训练台... 浏览器将自动打开 http://127.0.0.1:5173/"
echo "按 Ctrl+C 停止服务。"
exec node --disable-warning=ExperimentalWarning --experimental-sqlite server.js
