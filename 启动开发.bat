@echo off
REM 轻语一键启动（双击此文件即可）
REM 位于 酒馆/根目录，方便从资源管理器直接双击
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo 正在启动轻语开发环境...
REM 优先用 PowerShell 脚本（功能更全），失败则回落到 BAT
powershell -ExecutionPolicy Bypass -File "scripts\dev.ps1" 2>nul
if %errorlevel% neq 0 (
  echo PowerShell 启动失败，回落到 BAT...
  call "scripts\dev.bat"
)
