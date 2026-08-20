@echo off
REM 轻语一键启动 - pnpm electron:dev
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0.."
echo =======================================
echo   QingYu - Dev Launcher (BAT)
echo   %cd%
echo =======================================
echo.
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
  echo [!] pnpm not found, trying corepack...
  call corepack enable 2>nul
  call corepack prepare pnpm@latest --activate 2>nul
)
for /f "tokens=*" %%v in ('pnpm --version 2^>nul') do echo [OK] pnpm %%v
for /f "tokens=*" %%v in ('node --version 2^>nul') do echo [OK] Node %%v
echo.
if not exist "node_modules" (
  echo [!] node_modules missing, pnpm install...
  call pnpm install --frozen-lockfile
  if %errorlevel% neq 0 pause & exit /b %errorlevel%
)
echo [OK] Dependencies ready
echo.
echo ^> Check port 5173
netstat -ano | findstr ":5173 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo [!] Port 5173 in use, freeing...
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
  timeout /t 1 >nul
)
echo.
echo ^> Start pnpm electron:dev
echo   Vite at http://localhost:5173, Electron opens automatically
echo   Press Ctrl+C to stop
echo.
call pnpm electron:dev
pause
endlocal
