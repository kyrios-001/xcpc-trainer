@echo off
rem XCPC 训练台启动脚本（Windows）
rem 使用 Node 自带的 SQLite，零 npm 依赖。需要 Node 22.5 或更高版本。
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node 22.5+：https://nodejs.org/
  pause
  exit /b 1
)
echo 启动 XCPC 训练台... 浏览器将自动打开 http://127.0.0.1:5173/
echo 按 Ctrl+C 停止服务。
node --disable-warning=ExperimentalWarning --experimental-sqlite server.js
if errorlevel 1 pause
