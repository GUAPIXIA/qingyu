<#
.SYNOPSIS
  从当前活跃 connection profile 安全拉取密钥并调用 evaluate-generation.ts。

.DESCRIPTION
  1. 创建随机临时目录
  2. 通过 Electron safeStorage 解密活跃 profile 的 API Key，写入临时文件（不进 argv/env）
  3. 从 settings.connectionProfiles[activeProfileId] 读取 provider/baseUrl/model/maxContext
  4. 用 metadata + key-file 调用评测器（不按模型名猜 provider）
  5. finally 删除密钥与临时目录

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
  throw '未找到 electron.exe；请安装依赖或用 -ElectronExe 指定路径'
}

function Read-ActiveProfileMeta {
  $settingsPath = Join-Path $env:USERPROFILE 'AppData/Roaming/qingyu/data/config/settings.json'
  if (-not (Test-Path $settingsPath)) {
    throw "未找到应用 settings.json: $settingsPath"
  }
  $json = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $profileId = $json.activeProfileId
  if (-not $profileId) { throw 'settings.activeProfileId 为空，无法确定活跃 profile' }

  $profile = $null
  if ($json.connectionProfiles) {
    $profile = @($json.connectionProfiles) | Where-Object { $_.id -eq $profileId } | Select-Object -First 1
  }
  if (-not $profile) {
    throw "connectionProfiles 中没有 id=$profileId 的活跃 profile"
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
  Write-Error "当前 provider=$($meta.provider) 尚未被评测器支持，停止真实模型阶段（不静默退回 OpenAI）。支持: $($supported -join ', ')"
  exit 4
}
if (-not $meta.baseUrl -or -not $meta.model) {
  Write-Error '活跃 profile 缺少 baseUrl 或 model，停止真实模型阶段。'
  exit 5
}

try {
  & $electron $decryptScript 'active' $keyFile
  if ($LASTEXITCODE -ne 0) { throw "decrypt-api-key 退出码 $LASTEXITCODE" }
  if (-not (Test-Path $keyFile)) { throw '密钥文件未生成' }

  $meta | ConvertTo-Json -Depth 5 | Set-Content -Path $metaFile -Encoding UTF8

  $env:GENERATION_EVAL_PROVIDER = $meta.provider
  $env:GENERATION_EVAL_BASE_URL = $meta.baseUrl
  $env:GENERATION_EVAL_MODEL = $meta.model
  # 密钥只经 --key-file，不进环境变量

  if ($SkipRealModel) {
    Write-Host '[eval-active-profile] SkipRealModel：仅校验 profile 与密钥链路，不发起真实调用'
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
      Write-Warning 'http-debug.jsonl 疑似含 Authorization，正在脱敏…'
      $redacted = $raw -replace 'Bearer\s+[A-Za-z0-9_\-\.]+', 'Bearer ***'
      $redacted = $redacted -replace '("api[_-]?key"\s*:\s*")[^"]+', '$1***'
      Set-Content -Path $debugPath -Value $redacted -Encoding UTF8
    }
  }
}
