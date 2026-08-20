#Requires -Version 5.1
param(
  [switch]$SkipInstall,
  [int]$Port = 5173
)
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

function Write-Step($msg) { Write-Host "`n> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  X $msg" -ForegroundColor Red }

Write-Host "=======================================" -ForegroundColor DarkGray
Write-Host "  QingYu - Dev Launcher" -ForegroundColor White
Write-Host "  $Root" -ForegroundColor DarkGray
Write-Host "=======================================" -ForegroundColor DarkGray

Write-Step "Check environment"
try { $nodeVer = node --version 2>$null } catch { $nodeVer = $null }
if (-not $nodeVer) { Write-Err "Node.js not found, please install Node 22+"; Read-Host "Press Enter to exit"; exit 1 }
Write-Ok "Node $nodeVer"

try { $pnpmVer = pnpm --version 2>$null } catch { $pnpmVer = $null }
if (-not $pnpmVer) {
  Write-Warn "pnpm not found, trying corepack..."
  try { corepack enable; corepack prepare pnpm@latest --activate; $pnpmVer = pnpm --version } catch {}
  if (-not $pnpmVer) { Write-Err "pnpm not available, run: npm i -g pnpm"; Read-Host "Press Enter to exit"; exit 1 }
}
Write-Ok "pnpm $pnpmVer"

if (-not $SkipInstall) {
  Write-Step "Check dependencies"
  $needInstall = $false
  if (-not (Test-Path "node_modules")) { $needInstall = $true; Write-Warn "node_modules missing" }
  elseif (-not (Test-Path "node_modules/.modules.yaml")) { $needInstall = $true; Write-Warn "pnpm state broken" }
  if ($needInstall) {
    Write-Step "Running pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Write-Err "pnpm install failed"; Read-Host "Press Enter to exit"; exit $LASTEXITCODE }
    Write-Ok "Dependencies installed"
  } else {
    Write-Ok "Dependencies ready"
  }
}

Write-Step "Check port $Port"
$portInUse = $false
try {
  $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
  if ($conn) { $portInUse = $true }
} catch {
  $net = netstat -ano 2>$null | Select-String ":$Port "
  if ($net) { $portInUse = $true }
}
if ($portInUse) {
  Write-Warn "Port $Port in use, trying to free..."
  try {
    $procIds = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
    foreach ($procId in $procIds) {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc) { Write-Warn "  Kill $($proc.ProcessName) (PID $procId)"; Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 1
    Write-Ok "Port freed"
  } catch { Write-Warn "  Cannot free port, please close app using $Port" }
} else {
  Write-Ok "Port $Port free"
}

Write-Step "Start pnpm electron:dev"
Write-Host "  Vite will run at http://localhost:$Port, Electron opens automatically" -ForegroundColor DarkGray
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

pnpm electron:dev
$code = $LASTEXITCODE
# 143/130 是 Ctrl+C / SIGTERM 正常退出，不算错误
if ($code -ne 0 -and $code -ne 143 -and $code -ne 130 -and $null -ne $code) {
  Write-Err "electron:dev exited with code $code"
  Write-Host "  Try: 1) pnpm check  2) netstat -ano | findstr :$Port  3) remove node_modules and reinstall" -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
} else {
  Write-Host ""
  Write-Host "Exited cleanly." -ForegroundColor DarkGray
}
