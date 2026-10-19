# 为当前用户安装登录后自动启动 Companion（不要求每次手动敲命令）
# 用法（项目根）:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/companion/install-autostart-windows.ps1
# 卸载:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/companion/install-autostart-windows.ps1 -Uninstall

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$TaskName = "FaceDEV-Local-Xinqi-Companion"
$Node = (Get-Command node -ErrorAction Stop).Source
$ServerJs = Join-Path $Root "server\voice\companion\companionServer.mjs"
$WorkDir = "$Root"

if ($Uninstall) {
  schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
  Write-Host "[companion] removed scheduled task: $TaskName"
  exit 0
}

if (-not (Test-Path $ServerJs)) {
  throw "Companion entry not found: $ServerJs"
}

# 登录时启动；工作目录为仓库根，以便读取 .env
$Tr = "`"$Node`" `"$ServerJs`""
schtasks /Create /TN $TaskName /TR $Tr /SC ONLOGON /RL LIMITED /F /IT | Out-Null

# schtasks 不直接支持 WorkingDirectory；用 wrapper cmd
$Wrapper = Join-Path $env:APPDATA "FaceDEV\start-companion.cmd"
New-Item -ItemType Directory -Force -Path (Split-Path $Wrapper) | Out-Null
@"
@echo off
cd /d "$WorkDir"
set FACEDEV_COMPANION_PORT=18740
"$Node" "$ServerJs"
"@ | Set-Content -Path $Wrapper -Encoding ASCII

$Tr2 = "`"$Wrapper`""
schtasks /Create /TN $TaskName /TR $Tr2 /SC ONLOGON /RL LIMITED /F /IT | Out-Null

Write-Host "[companion] installed logon task: $TaskName"
Write-Host "[companion] wrapper: $Wrapper"
Write-Host "[companion] 下次登录将自动启动；也可立即运行: schtasks /Run /TN $TaskName"
