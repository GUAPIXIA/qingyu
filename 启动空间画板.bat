@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0spatial-board"

echo ========================================
echo   空间画板一键启动
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 后重试。
  goto :failed
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 npm，请检查 Node.js 安装。
  goto :failed
)

if not exist "node_modules\.bin\vite.cmd" (
  echo 首次启动，正在安装画板依赖...
  call npm ci
  if errorlevel 1 goto :failed
)

echo 正在启动画板，浏览器会自动打开 http://localhost:5188/
echo 关闭此窗口或按 Ctrl+C 可停止画板。
echo.
call npm run dev -- --open
if errorlevel 1 goto :failed
goto :end

:failed
echo.
echo 启动失败，请查看上方提示。
pause

:end
endlocal
