<#
.SYNOPSIS
  G2 主对话观测采集：解密 chenxi + relayapi 密钥 → g2-collect.ts 真实调用并写观测。

.DESCRIPTION
  chenxi/deepseek-v4.1-flash 负责大部分样本；relayapi/gemini-3.8-flash 补第二供应商。
  密钥只落临时文件，用后删除；观测写入 userData generation-observations.jsonl。
  分段：不设 gateLevel（gate:none），与本机既有样本同段凑满 500。

.EXAMPLE
  pwsh scripts/g2-collect.ps1 -ChenxiWeight 400 -RelayWeight 100 -Concurrency 2
#>
[CmdletBinding()]
param(
  [int]$ChenxiWeight = 400,
  [int]$RelayWeight = 100,
  [int]$Concurrency = 2,
  [string]$ChenxiProfileId = '-UbocPROcmYx9QN-vdfGO',
  [string]$RelayProfileId = 'VDbr6C_m4Z_3iHitU4jxo',
  [string]$ProgressFile = '.poc-tmp/g2-collect-progress.json',
  [switch]$SkipRealModel
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('g2-collect-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $tmpRoot -Force
$chenxiKey = Join-Path $tmpRoot 'chenxi.key'
$relayKey = Join-Path $tmpRoot 'relay.key'
$decryptScript = Join-Path $repoRoot 'scripts/decrypt-api-key.cjs'

function Find-Electron {
  $candidates = @(
    (Join-Path $repoRoot 'node_modules/electron/dist/electron.exe'),
    (Join-Path $repoRoot 'node_modules\electron\dist\electron.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
  throw 'electron.exe not found'
}

function Decrypt-Key([string]$profileId, [string]$outFile) {
  $electron = Find-Electron
  $dec = Start-Process -FilePath $electron -ArgumentList @($decryptScript, $profileId, $outFile) -Wait -PassThru -NoNewWindow
  if ($dec.ExitCode -ne 0) { throw "decrypt-api-key exit $($dec.ExitCode) for $profileId" }
  if (-not (Test-Path $outFile)) { throw "key file missing $outFile" }
}

try {
  Write-Host "[g2-collect] decrypt chenxi=$ChenxiProfileId relay=$RelayProfileId"
  Decrypt-Key $ChenxiProfileId $chenxiKey
  Decrypt-Key $RelayProfileId $relayKey

  $settingsPath = Join-Path $env:USERPROFILE 'AppData/Roaming/qingyu/data/config/settings.json'
  $settingsRaw = Get-Content $settingsPath -Raw
  # 不解析损坏可能的 settings（中文编码问题）：用已知 profile 元数据
  $chenxiBase = 'http://171.80.3.245:28080/v1'
  $chenxiModel = 'deepseek-v4.1-flash'
  $relayBase = 'https://relayapi.app/v1'
  $relayModel = 'gemini-3.8-flash'

  if ($SkipRealModel) {
    Write-Host '[g2-collect] SkipRealModel — keys path validated only'
    exit 0
  }

  $armChenxi = "name=chenxi,provider=openai,model=$chenxiModel,baseUrl=$chenxiBase,keyFile=$chenxiKey,weight=$ChenxiWeight"
  $armRelay = "name=relayapi,provider=openai,model=$relayModel,baseUrl=$relayBase,keyFile=$relayKey,weight=$RelayWeight"

  $tsx = Join-Path $repoRoot 'node_modules/tsx/dist/cli.mjs'
  $script = Join-Path $repoRoot 'scripts/g2-collect.ts'
  $argList = @(
    $tsx, $script,
    '--arm', $armChenxi,
    '--arm', $armRelay,
    '--concurrency', "$Concurrency",
    '--progress', $ProgressFile
  )
  Write-Host "[g2-collect] start chenxi=$ChenxiWeight relay=$RelayWeight conc=$Concurrency"
  & node @argList
  exit $LASTEXITCODE
}
finally {
  Remove-Item -Path $chenxiKey -ErrorAction SilentlyContinue
  Remove-Item -Path $relayKey -ErrorAction SilentlyContinue
  Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}
