# FaceDEV Local Xinqi Companion — 前台启动（开发 / 排查）
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root

$env:FACEDEV_COMPANION_PORT = if ($env:FACEDEV_COMPANION_PORT) { $env:FACEDEV_COMPANION_PORT } else { "18740" }

Write-Host "[companion] root=$Root"
Write-Host "[companion] port=$($env:FACEDEV_COMPANION_PORT)"
Write-Host "[companion] 请先启动 Xinqi Engine；本进程仅代理 Gateway。"

node server/voice/companion/companionServer.mjs
