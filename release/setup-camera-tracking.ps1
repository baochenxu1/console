# First-time setup: npm install + Python venv + pip deps + model auto-download
# Run from release package root: .\setup-camera-tracking.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root = if (Test-Path (Join-Path $ScriptDir "package.json")) { $ScriptDir } else { Split-Path -Parent $ScriptDir }
$TrackingDir = Join-Path $Root "tools\tracking_service"
$VenvDir = Join-Path $TrackingDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ModelPath = Join-Path $TrackingDir "models\face_landmarker.task"

$ModelHelper = if (Test-Path (Join-Path $ScriptDir "tracking-model.ps1")) {
  Join-Path $ScriptDir "tracking-model.ps1"
} else {
  Join-Path $Root "release\tracking-model.ps1"
}
. $ModelHelper

function Test-CommandAvailable([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host "=== FaceDEV camera tracking - setup ===" -ForegroundColor Cyan
Write-Host "Project root: $Root"

if (-not (Test-CommandAvailable "node")) {
  Write-Error "node not found. Install Node.js 18+: https://nodejs.org/"
}
if (-not (Test-CommandAvailable "npm")) {
  Write-Error "npm not found. Reinstall Node.js."
}
if (-not (Test-CommandAvailable "python")) {
  Write-Error "python not found. Install Python 3.10 or 3.11: https://www.python.org/"
}

$nodeVer = (node -p "process.versions.node") 2>$null
Write-Host "Node.js: $nodeVer"

$pyVer = (python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')") 2>$null
Write-Host "Python: $pyVer"

Write-Host ""
Write-Host "[1/3] MediaPipe model..." -ForegroundColor Yellow
Ensure-FaceLandmarkerModel -ModelPath $ModelPath

Write-Host ""
Write-Host "[2/3] npm install..." -ForegroundColor Yellow
Push-Location $Root
npm install
Pop-Location

Write-Host ""
Write-Host "[3/3] Python venv + pip install..." -ForegroundColor Yellow
if (-not (Test-Path $VenvPython)) {
  Push-Location $TrackingDir
  python -m venv .venv
  Pop-Location
}

& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $TrackingDir "requirements.txt")

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host "Next: double-click start-camera-tracking.bat or run .\start-camera-tracking.ps1"
