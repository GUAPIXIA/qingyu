// 原生文件对话框后端（Windows）——**实验性，未接入执行器**。
//
// 结论（2026-10-03 实测）：本机环境下无法可靠完成系统文件对话框，因此执行器统一返回
// `needs_interaction`（方案 §6.3 允许），本模块保留为后续接入专业桌面自动化库的起点。
//
// 已验证的事实（不要凭直觉重写）：
//  - 对话框可定位：Win32 通用对话框 class=#32770；启动 pid 常是 cmd 包装进程，需先展开进程树；
//  - 控件可枚举，但 `PropertyCondition(ClassNameProperty)` 查不到控件（DirectUI），
//    必须 `TrueCondition` 取全部后代再按 ClassName 过滤；ControlType 也一律是 Pane；
//  - 文件名 Edit（class=Edit, AutomationId=1001）**不支持 ValuePattern**；
//  - `SetWindowText` 只改显示、不更新对话框内部状态 → 保存会落到默认目录（下载），
//    实测会污染用户文件系统，因此不要再尝试这条路；
//  - `SendKeys` 需要目标对话框在前台，后台进程的 `SetForegroundWindow` 不保证生效；
//  - 按钮 `BM_CLICK` 能关闭对话框（但文件名不生效时结果落在默认目录）。
//
// 若要真正自动化，需要：能稳定激活前台窗口的桌面自动化库（或产品侧提供导出目标路径参数）。
import { spawnSync } from 'node:child_process'

function buildScript({ pid, path, kind }) {
  const escapedPath = String(path ?? '').replace(/'/g, "''")
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$rootPid = ${pid}
$path = '${escapedPath}'
$kind = '${kind}'

$all = Get-CimInstance Win32_Process
$tree = @($rootPid)
$frontier = @($rootPid)
for ($round = 0; $round -lt 6; $round++) {
  $next = @()
  foreach ($p in $frontier) {
    foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $p })) {
      if ($tree -notcontains $child.ProcessId) { $tree += $child.ProcessId; $next += $child.ProcessId }
    }
  }
  if ($next.Count -eq 0) { break }
  $frontier = $next
}

$auto = [System.Windows.Automation.AutomationElement]::RootElement
$classCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
$trueCond = [System.Windows.Automation.Condition]::TrueCondition

# 注意：PropertyCondition(ClassNameProperty, ...) 在本机 DirectUI 对话框上查不到控件，
# 必须先 TrueCondition 取全部后代再在 PowerShell 里按 ClassName 过滤（实测可行）。
function Get-DescendantsByClass($root, $className) {
  $result = @()
  foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $trueCond)) {
    if ($e.Current.ClassName -eq $className) { $result += $e }
  }
  return $result
}

function Get-Dialog {
  foreach ($w in $auto.FindAll([System.Windows.Automation.TreeScope]::Children, $classCond)) {
    if ($tree -contains $w.Current.ProcessId) { return $w }
  }
  return $null
}

function Invoke-Cancel($dlg) {
  if (-not $dlg) { return }
  foreach ($b in (Get-DescendantsByClass $dlg 'Button')) {
    if ($b.Current.Name -like '*取消*') {
      try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
      return
    }
  }
}

$dialog = $null
for ($i = 0; $i -lt 40; $i++) { $dialog = Get-Dialog; if ($dialog) { break }; Start-Sleep -Milliseconds 500 }
if (-not $dialog) { Write-Output ('DIALOG_NOT_FOUND tree=' + ($tree -join ',')); exit 2 }
Write-Output 'DIALOG_FOUND'
# 键盘输入需要对话框在前台
try { [W32]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle) | Out-Null } catch {}
Start-Sleep -Milliseconds 300

# 文件名编辑框：class=Edit（DirectUI 下 ControlType 不可靠）
$edit = $null
foreach ($e in (Get-DescendantsByClass $dialog 'Edit')) {
  $vp = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    if (-not $vp.Current.IsReadOnly) { $edit = $e; break }
  }
}
if (-not $edit) {
  Invoke-Cancel $dialog
  Write-Output 'EDIT_NOT_FOUND'
  exit 3
}

if ($path -ne '') {
  # 这些对话框的 Edit 不支持 ValuePattern（实测 TryGetCurrentPattern 返回 false），
  # SetWindowText 也只会改显示、不更新对话框内部状态（会把文件存到默认目录）。
  # 因此用真实键盘输入：聚焦文件名框 → Ctrl+A → 输入完整路径。
  try {
    $edit.SetFocus()
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 150
    $escaped = $path -replace '([+^%~(){}\[\]])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    Start-Sleep -Milliseconds 250
    Write-Output 'FILLED'
  } catch {
    Invoke-Cancel $dialog
    Write-Output ('FILL_FAILED:' + $_.Exception.Message)
    exit 4
  }
} else {
  Write-Output 'FILLED_EMPTY'
}

# 确认按钮：class=Button 且名称含「保存」/「打开」（排除「取消」与下拉箭头）
$confirm = $null
foreach ($b in (Get-DescendantsByClass $dialog 'Button')) {
  $n = $b.Current.Name
  if (-not $n -or $n -like '*取消*' -or $b.Current.AutomationId -eq 'DropDown') { continue }
  if ($kind -eq 'open' -and $n -like '*打开*') { $confirm = $b; break }
  if ($kind -eq 'save' -and $n -like '*保存*') { $confirm = $b; break }
}
if (-not $confirm) {
  Invoke-Cancel $dialog
  Write-Output 'CONFIRM_NOT_FOUND'
  exit 5
}
# 按钮的 InvokePattern 不保证可用；优先用 Win32 BM_CLICK（实测可关闭对话框）
$clicked = $false
try {
  $confirm.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  $clicked = $true
} catch {
  $hwnd = [IntPtr]$confirm.Current.NativeWindowHandle
  if ($hwnd -ne [IntPtr]::Zero) {
    [W32]::SendMessage($hwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $clicked = $true
  }
}
if (-not $clicked) {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Write-Output 'CLICKED'
`
}

/**
 * 完成一次原生文件对话框。
 * @returns {{ ok: boolean, detail: string, stdout: string, stderr: string }}
 */
export function completeNativeDialog({ pid, path, kind = 'save', timeoutMs = 45000 }) {
  if (process.platform !== 'win32') {
    return { ok: false, detail: 'UNSUPPORTED_PLATFORM', stdout: '', stderr: '仅支持 Windows' }
  }
  if (!pid) return { ok: false, detail: 'NO_PID', stdout: '', stderr: '缺少目标进程 pid' }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildScript({ pid, path, kind })], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const ok = /FILLED/.test(stdout) && /CLICKED/.test(stdout)
  const marker = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? ''
  const detail = ok ? marker : `${marker || `exit=${result.status}`}${stderr ? ` | ${stderr.trim().split('\n')[0]}` : ''}`
  return { ok, detail, stdout, stderr }
}
