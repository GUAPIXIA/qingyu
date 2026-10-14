<#
.SYNOPSIS
  受控清理脚本：仅处理显式登记且可重建的仓库内产物。

.DESCRIPTION
  与旧版 git clean -ndX 的关键区别：
  - 可删范围来自下方 $Registry 显式白名单，不以“被 Git 忽略”作为可删依据。
  - 每个目标先计算绝对路径，校验位于仓库根之内、非仓库根、非受保护子树，且不是 reparse point（junction／symlink）。
  - 业务数据（data/、server/app/data/、models/、png/、public/、node_modules 之外的工作区内容）、
    凭据与联验证据（output/、.qa/、docs/、shared/、server/、relay-server/、spatial-board/ 源码）不在名单内，
    本脚本永不删除。
  - press 类目标（验证数据副本、发布产物）默认不处理，需要显式 -Ack。
  - 删除前请先执行 preview 核对；实际删除仅使用 -LiteralPath。

.PARAMETER Target
  preview（默认，只读预览）| build | cache | deps | all

.PARAMETER Ack
  显式确认处理 press 类目标（.poc-tmp、.tmp-archive、release-v2）。

.EXAMPLE
  pwsh scripts/clean.ps1 preview
  pwsh scripts/clean.ps1 build -Ack
  pwsh scripts/clean.ps1 deps
#>
[CmdletBinding()]
param(
  [ValidateSet('preview', 'build', 'cache', 'deps', 'all')]
  [string]$Target = 'preview',
  [switch]$Ack
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))

# kind: build / cache / deps / ops；press = 默认跳过，需要 -Ack
$Registry = @(
  # ---- deps（独立选择：-Target deps）----
  @{ cat = 'deps'; kind = 'deps'; path = 'node_modules';            desc = '根依赖树（pnpm install 可重建）';       press = $false }
  @{ cat = 'deps'; kind = 'deps'; path = 'server/app/node_modules'; desc = '公告服务依赖树';                       press = $false }
  @{ cat = 'deps'; kind = 'deps'; path = 'relay-server/node_modules'; desc = 'Relay 依赖树';                       press = $false }
  @{ cat = 'deps'; kind = 'deps'; path = 'spatial-board/node_modules'; desc = '独立画板依赖树';                     press = $false }
  # ---- build（-Target build）----
  @{ cat = 'build'; kind = 'build'; path = 'dist';            desc = 'Vite 前端产物';              press = $false }
  @{ cat = 'build'; kind = 'build'; path = 'dist-electron';   desc = 'Electron 主进程产物';        press = $false }
  @{ cat = 'build'; kind = 'build'; path = 'coverage';        desc = 'vitest 覆盖率报告';          press = $false }
  @{ cat = 'build'; kind = 'build'; path = 'release-v2';      desc = '安装包输出（发布产物）';     press = $true }
  # ---- cache（-Target cache）----
  @{ cat = 'cache'; kind = 'cache'; path = '.cache';           desc = '通用缓存';                   press = $false }
  # ---- 本地验证数据副本（-Target all -Ack 才处理）----
  @{ cat = 'ops'; kind = 'ops'; path = '.poc-tmp';     desc = '本地评测输出（部分被文档引用）';   press = $true }
  @{ cat = 'ops'; kind = 'ops'; path = '.tmp-archive'; desc = '测试沙盒 userData 副本归档';      press = $true }
)

# 永不删除的保护清单（仅用于 preview 说明与防御性断言；可删范围以 $Registry 为准）
$Protected = @(
  '.git', 'src', 'electron', 'shared', 'server', 'relay-server', 'spatial-board',
  'docs', 'scripts', 'tools', 'tests', 'public', 'png', 'models', 'output', '.qa', '.qa-poc',
  'data', 'server/app/data'
)

$RegistryPaths = @($Registry | ForEach-Object { $_.path })

function Resolve-CleanPath {
  param([Parameter(Mandatory)][string]$Rel, [Parameter(Mandatory)][string]$Desc)
  $full = [System.IO.Path]::GetFullPath((Join-Path $Root $Rel))
  if (-not $full.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝：目标越出仓库根（$Rel）"
  }
  if ($full.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -ieq $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar)) {
    throw "拒绝：目标是仓库根（$Rel）"
  }
  $relNorm = $Rel.Replace('\', '/')
  if ($RegistryPaths -contains $relNorm) { return $full }
  # 注册表之外的路径一律拒绝；给出更明确的受保护范围提示
  foreach ($p in $Protected) {
    if ($relNorm -ieq $p -or $relNorm.StartsWith($p + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝：位于受保护范围（$p）"
    }
  }
  throw "拒绝：目标不在白名单注册表中（$Rel）"
}

function Test-IsReparsePoint {
  param([Parameter(Mandatory)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $false }
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Show-Plan {
  param([Parameter(Mandatory)][string[]]$Categories)
  Write-Host "仓库根: $Root"
  Write-Host ''
  $any = $false
  foreach ($entry in $Registry) {
    if ($Categories -notcontains $entry.cat) { continue }
    $full = Resolve-CleanPath -Rel $entry.path -Desc $entry.desc
    $exists = Test-Path -LiteralPath $full
    $tag = if ($entry.press) { if ($Ack) { '[press·已确认]' } else { '[press·需 -Ack]' } } else { '[可清理]' }
    $state = if (-not $exists) { '不存在（跳过）' } elseif (Test-IsReparsePoint -Path $full) { '是链接（拒绝处理）' } else { '存在' }
    Write-Host ("  {0} {1,-22} {2,-10} {3}" -f $tag, $entry.path, $state, $entry.desc)
    if ($exists) { $any = $true }
  }
  if (-not $any) { Write-Host '  （没有可处理的目标）' }
  Write-Host ''
  Write-Host '  output/、.qa/、.qa-poc/、docs/、models/、server/app/data/ 等证据或业务目录不在名单内，本脚本永不删除。'
}

function Invoke-Clean {
  param([Parameter(Mandatory)][string[]]$Categories)
  $done = 0
  foreach ($entry in $Registry) {
    if ($Categories -notcontains $entry.cat) { continue }
    if ($entry.press -and -not $Ack) {
      Write-Host ("  跳过（press，需 -Ack）: {0}" -f $entry.path)
      continue
    }
    $full = Resolve-CleanPath -Rel $entry.path -Desc $entry.desc
    if (-not (Test-Path -LiteralPath $full)) { Write-Host ("  跳过（不存在）: {0}" -f $entry.path); continue }
    if (Test-IsReparsePoint -Path $full) { throw ("拒绝：目标为 reparse point，不跟随删除（{0}）" -f $entry.path) }
    Remove-Item -LiteralPath $full -Recurse -Force
    Write-Host ("  已删除: {0}" -f $entry.path)
    $done++
  }
  Write-Host ("清理完成，共处理 {0} 项。" -f $done)
}

switch ($Target) {
  'preview' { Show-Plan -Categories @('build', 'cache', 'ops', 'deps') }
  'build'   { Show-Plan -Categories @('build'); Invoke-Clean -Categories @('build') }
  'cache'   { Show-Plan -Categories @('cache'); Invoke-Clean -Categories @('cache') }
  'deps'    { Show-Plan -Categories @('deps');  Invoke-Clean -Categories @('deps') }
  'all' {
    Show-Plan -Categories @('build', 'cache', 'ops')
    Write-Host ''
    Write-Host '  提示：node_modules 属独立清理范围，请单独执行 -Target deps；.poc-tmp/.tmp-archive/release-v2 需要 -Ack。'
    $answer = Read-Host '输入 YES 清理 build+cache（press 类按 -Ack 决定，deps 不动）'
    if ($answer -eq 'YES') { Invoke-Clean -Categories @('build', 'cache', 'ops') } else { Write-Host '已取消。' }
  }
}