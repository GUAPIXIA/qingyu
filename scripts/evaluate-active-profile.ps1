<#
.SYNOPSIS
  Load active connection profile securely and invoke evaluate-generation.ts.

.DESCRIPTION
  1. Create a random temp directory
  2. Decrypt active profile API key via Electron safeStorage into a temp file (never argv/env)
  3. Read provider/baseUrl/model/maxContext from settings.connectionProfiles[activeProfileId]
  4. Run evaluator with metadata + --key-file (no provider guessing by model name)
  5. Delete key and temp dir in finally

.EXAMPLE
  pwsh scripts/evaluate-active-profile.ps1 -Batches dialogue,group,stream -Reps 1 -Out .poc-tmp/eval-dialog-render-smoke
#>
[CmdletBinding()]
param(
  [string]$Batches = 'dialogue,group,stream',
  [int]$Reps = 1,
  [string]$Out = '.poc-tmp/eval-dialog-render-smoke',
  [string]$Judge = 'off',
  [string]$ElectronExe = '',
  [string]$Only = '',
  [switch]$NoGate,
  [switch]$NoThinkingParam,
  [switch]$SkipRealModel
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('qingyu-eval-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $tmpRoot -Force
$keyFile = Join-Path $tmpRoot 'key.bin'
$metaFile = Join-Path $tmpRoot 'profile-meta.json'
$decryptScript = Join-Path $repoRoot 'scripts/decrypt-api-key.cjs'

function Find-Electron {
  if ($ElectronExe -and (Test-Path $ElectronExe)) { return (Resolve-Path $ElectronExe).Path }
  $candidates = @(
    (Join-Path $repoRoot 'node_modules/electron/dist/electron.exe'),
    (Join-Path $repoRoot 'node_modules\electron\dist\electron.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw 'electron.exe not found; install deps or pass -ElectronExe'
}

function Read-ActiveProfileMeta {
  $settingsPath = Join-Path $env:USERPROFILE 'AppData/Roaming/qingyu/data/config/settings.json'
  if (-not (Test-Path $settingsPath)) {
    throw "settings.json not found: $settingsPath"
  }
  $json = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $profileId = $json.activeProfileId
  if (-not $profileId) { throw 'settings.activeProfileId is empty' }

  $profile = $null
  if ($json.connectionProfiles) {
    $profile = @($json.connectionProfiles) | Where-Object { $_.id -eq $profileId } | Select-Object -First 1
  }
  if (-not $profile) {
    throw "connectionProfiles has no entry for activeProfileId=$profileId"
  }

  $provider = [string]$profile.provider
  if (-not $provider) { $provider = [string]$json.activeProvider }
  $baseUrl = [string]$profile.baseUrl
  $model = [string]$profile.model
  if (-not $model) { $model = [string]$json.activeModel }

  return [pscustomobject]@{
    profileId  = $profileId
    name       = [string]$profile.name
    provider   = $provider
    baseUrl    = $baseUrl
    model      = $model
    maxContext = if ($profile.maxContext) { [int]$profile.maxContext } else { 0 }
  }
}

$supported = @('openai', 'openai-compatible', 'openrouter', 'deepseek', 'custom', 'claude', 'anthropic')
$electron = Find-Electron
$meta = Read-ActiveProfileMeta

Write-Host "[eval-active-profile] name=$($meta.name) provider=$($meta.provider) model=$($meta.model) baseUrl=$($meta.baseUrl) maxContext=$($meta.maxContext)"
if ($supported -notcontains $meta.provider) {
  Write-Error "Unsupported provider=$($meta.provider). Stop real-model phase (no silent OpenAI fallback). Supported: $($supported -join ', ')"
  exit 4
}
if (-not $meta.baseUrl -or -not $meta.model) {
  Write-Error 'Active profile missing baseUrl or model. Stop real-model phase.'
  exit 5
}

try {
  # Electron GUI 进程不会阻塞 & 调用；必须 Start-Process -Wait
  $dec = Start-Process -FilePath $electron -ArgumentList @($decryptScript, 'active', $keyFile) -Wait -PassThru -NoNewWindow
  if ($dec.ExitCode -ne 0) { throw "decrypt-api-key exit code $($dec.ExitCode)" }
  if (-not (Test-Path $keyFile)) { throw 'key file was not created' }

  $meta | ConvertTo-Json -Depth 5 | Set-Content -Path $metaFile -Encoding UTF8

  $env:GENERATION_EVAL_PROVIDER = $meta.provider
  $env:GENERATION_EVAL_BASE_URL = $meta.baseUrl
  $env:GENERATION_EVAL_MODEL = $meta.model
  # key only via --key-file, never env/argv

  # G1/阶段8 取证用的臂开关（只影响评测器，不改变生产）：
  # -NoGate          不发门控指令（改造前路径对照；legacy reasoningMode 仍在）
  # -NoThinkingParam 连 legacy 的 reasoningMode:'disabled' 也不发（真基线：验证端点能否关闭推理）
  if ($NoGate) { $env:GENERATION_EVAL_NO_GATE = '1' } else { Remove-Item Env:GENERATION_EVAL_NO_GATE -ErrorAction SilentlyContinue }
  if ($NoThinkingParam) { $env:GENERATION_EVAL_NO_THINKING_PARAM = '1' } else { Remove-Item Env:GENERATION_EVAL_NO_THINKING_PARAM -ErrorAction SilentlyContinue }

  if ($SkipRealModel) {
    Write-Host '[eval-active-profile] SkipRealModel: profile/key path validated, no live calls'
    exit 0
  }

  $tsx = Join-Path $repoRoot 'node_modules/tsx/dist/cli.mjs'
  $evalScript = Join-Path $repoRoot 'scripts/evaluate-generation.ts'
  $argList = @(
    $tsx, $evalScript,
    '--batch', $Batches,
    '--reps', "$Reps",
    '--judge', $Judge,
    '--out', $Out,
    '--provider', $meta.provider,
    '--base-url', $meta.baseUrl,
    '--model', $meta.model,
    '--key-file', $keyFile
  )
  if ($Only) { $argList += @('--only', $Only) }
  & node @argList
  exit $LASTEXITCODE
}
finally {
  Remove-Item -Path $keyFile -ErrorAction SilentlyContinue
  Remove-Item -Path $metaFile -ErrorAction SilentlyContinue
  Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
  $debugPath = Join-Path $Out 'http-debug.jsonl'
  if (Test-Path $debugPath) {
    $raw = Get-Content $debugPath -Raw
    if ($raw -match 'Bearer\s+[A-Za-z0-9_\-\.]{8,}') {
      Write-Warning 'http-debug.jsonl appears to contain Authorization; redacting...'
      $redacted = $raw -replace 'Bearer\s+[A-Za-z0-9_\-\.]+', 'Bearer ***'
      $redacted = $redacted -replace '("api[_-]?key"\s*:\s*")[^"]+', '$1***'
      Set-Content -Path $debugPath -Value $redacted -Encoding UTF8
    }
  }
}
