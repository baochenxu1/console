# One-click start: Python MediaPipe backend + Vite frontend
# Run from release package root: .\start-camera-tracking.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root = if (Test-Path (Join-Path $ScriptDir "package.json")) { $ScriptDir } else { Split-Path -Parent $ScriptDir }
$SetupScript = if (Test-Path (Join-Path $Root "setup-camera-tracking.ps1")) {
  Join-Path $Root "setup-camera-tracking.ps1"
} else {
  Join-Path $Root "release\setup-camera-tracking.ps1"
}
$ModelHelper = if (Test-Path (Join-Path $ScriptDir "tracking-model.ps1")) {
  Join-Path $ScriptDir "tracking-model.ps1"
} else {
  Join-Path $Root "release\tracking-model.ps1"
}
. $ModelHelper

$TrackingDir = Join-Path $Root "tools\tracking_service"
$VenvPython = Join-Path $TrackingDir ".venv\Scripts\python.exe"
$ModelPath = Join-Path $TrackingDir "models\face_landmarker.task"
$NodeModules = Join-Path $Root "node_modules"
$CameraIndex = if ($env:TRACKING_CAMERA) { $env:TRACKING_CAMERA } else { "0" }
$FrontendUrl = "http://localhost:5173/?page=trackingPreview"

function Test-CommandAvailable([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-TcpPortOpen([int]$Port, [string]$HostName = "127.0.0.1") {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect($HostName, $Port)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Wait-ForPort([int]$Port, [int]$TimeoutSec = 45) {
  $elapsed = 0
  while ($elapsed -lt $TimeoutSec) {
    if (Test-TcpPortOpen $Port) {
      return $true
    }
    Start-Sleep -Seconds 1
    $elapsed++
  }
  return $false
}

Write-Host "=== FaceDEV camera tracking - start ===" -ForegroundColor Cyan

if (-not (Test-CommandAvailable "node") -or -not (Test-CommandAvailable "npm")) {
  Write-Error "Node.js / npm not found. Run setup-camera-tracking.ps1 first."
}

if (-not (Test-Path $VenvPython)) {
  Write-Host "Python venv missing - running setup..." -ForegroundColor Yellow
  & $SetupScript
}

if (-not (Test-Path $NodeModules)) {
  Write-Host "node_modules missing - running setup..." -ForegroundColor Yellow
  & $SetupScript
}

Ensure-FaceLandmarkerModel -ModelPath $ModelPath

if (Test-TcpPortOpen 8766) {
  Write-Warning "Port 8766 is already in use. OK if tracking server is already running."
} else {
  Write-Host "Starting Python MediaPipe server (camera index $CameraIndex)..." -ForegroundColor Yellow
  $serverCmd = "cd '$TrackingDir'; & '$VenvPython' mediapipe_tracking_server.py --camera $CameraIndex"
  Start-Process powershell -ArgumentList @("-NoExit", "-Command", $serverCmd) | Out-Null

  Write-Host "Waiting for WebSocket on 127.0.0.1 port 8766..."
  if (-not (Wait-ForPort 8766 45)) {
    Write-Error "Tracking server not ready within 45s. Check the Python window for errors."
  }
  Write-Host "Tracking server is ready." -ForegroundColor Green
}

Write-Host "Starting Vite dev server..." -ForegroundColor Yellow
Write-Host "Browser URL: $FrontendUrl"

Push-Location $Root
try {
  npm run dev -- --open $FrontendUrl
} finally {
  Pop-Location
}
