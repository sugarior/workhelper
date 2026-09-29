<#
.SYNOPSIS
  创建 / 移除 WorkHelper 的桌面快捷方式（M0 过渡方案）。

.DESCRIPTION
  全局热键要等 M1 的 Tauri 外壳才能实现，在那之前用桌面快捷方式 +
  自动启动的本地服务，做到"双击图标就能记一句"。

  这个脚本在 M1 完成后应当删除 —— 它只是过渡手段，不是产品的一部分。

.EXAMPLE
  pwsh -File scripts\setup-shortcuts.ps1
  pwsh -File scripts\setup-shortcuts.ps1 -Remove
#>
[CmdletBinding()]
param(
  # 移除已创建的快捷方式
  [switch]$Remove,
  # 服务端口
  [int]$Port = 7317
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot 'wh.cmd'
$shortcutName = 'WorkHelper 快记.lnk'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop $shortcutName

function Remove-Shortcuts {
  if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "已删除快捷方式: $shortcutPath"
  } else {
    Write-Host "没有找到已创建的快捷方式"
  }
}

if ($Remove) {
  Remove-Shortcuts
  return
}

# ---------- 生成启动脚本 ----------
# 用绝对路径，避免依赖当前工作目录——这正是 CLI 修过的那个坑
$launcher = @"
@echo off
rem WorkHelper 快记启动器（M0 过渡方案，M1 的 Tauri 外壳完成后可删除）
rem 1) 若服务未运行则后台拉起  2) 打开快记窗
setlocal
set ROOT=$projectRoot
set PORT=$Port

rem 探测服务是否已在监听（用 PowerShell 的 TcpClient，避免依赖 curl）
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', $Port); exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "WorkHelper 服务" /min cmd /c "cd /d ""%ROOT%"" && node src\ui\main.ts --port $Port"
  rem 给服务一点启动时间；node 冷启动通常远快于此
  timeout /t 2 /nobreak >nul
)

start "" "http://127.0.0.1:$Port/capture"
endlocal
"@

Set-Content -Path $launcherPath -Value $launcher -Encoding ASCII
Write-Host "已生成启动器: $launcherPath"

# ---------- 创建快捷方式 ----------
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'WorkHelper 快记（M0 过渡方案）'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,167"
$shortcut.Save()

Write-Host "已创建快捷方式: $shortcutPath"
Write-Host ''
Write-Host '用法：双击桌面上的「WorkHelper 快记」即可打开快记窗。'
Write-Host '注意：这不是全局热键——不能在任何程序里一按就出，那是 M1 才能做到的。'
Write-Host "移除：pwsh -File scripts\setup-shortcuts.ps1 -Remove"
