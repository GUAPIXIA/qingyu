param(
  [ValidateSet("build","cache","deps","all","preview")]
  [string]$Target = "preview"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
function Preview { git clean -ndX }
function CleanBuild { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue dist, dist-electron, release-v2, android/build, android/app/build }
function CleanCache { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue .cache, .trae, android/.gradle, android/.kotlin }
function CleanDeps { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue node_modules, server/app/node_modules }
switch ($Target) {
  "preview" { Preview }
  "build" { CleanBuild; Write-Host "clean:build done" }
  "cache" { CleanCache; Write-Host "clean:cache done" }
  "deps" { CleanDeps; Write-Host "clean:deps done" }
  "all" { Preview; $c=Read-Host "输入 YES 确认清理 build+cache (保留 deps)"; if($c -eq "YES"){ CleanBuild; CleanCache; Write-Host "clean:all done" } }
}
