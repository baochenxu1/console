# Shared: ensure MediaPipe face_landmarker.task exists (auto-download if missing)
# Dot-source from setup/start scripts: . "$PSScriptRoot\tracking-model.ps1"

$script:FaceLandmarkerModelUrl =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"

function Ensure-FaceLandmarkerModel {
  param(
    [Parameter(Mandatory = $true)][string]$ModelPath
  )

  if (Test-Path $ModelPath) {
    $size = (Get-Item $ModelPath).Length
    if ($size -gt 1000000) {
      return
    }
    Write-Warning "Model file exists but looks too small ($size bytes). Re-downloading..."
    Remove-Item $ModelPath -Force
  }

  if ($env:TRACKING_SKIP_MODEL_DOWNLOAD -eq "1") {
    Write-Error "Model missing and TRACKING_SKIP_MODEL_DOWNLOAD=1. Place face_landmarker.task at: $ModelPath"
  }

  $modelDir = Split-Path -Parent $ModelPath
  if (-not (Test-Path $modelDir)) {
    New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
  }

  Write-Host "Downloading face_landmarker.task (MediaPipe official)..." -ForegroundColor Yellow
  Write-Host "URL: $script:FaceLandmarkerModelUrl"

  try {
    Invoke-WebRequest -Uri $script:FaceLandmarkerModelUrl -OutFile $ModelPath -UseBasicParsing
  } catch {
    Write-Error @"
Failed to download face_landmarker.task.

Manual download:
  $($script:FaceLandmarkerModelUrl)

Save to:
  $ModelPath

See tools\tracking_service\models\README.md
"@
  }

  if (-not (Test-Path $ModelPath)) {
    Write-Error "Download finished but model file not found: $ModelPath"
  }

  $size = (Get-Item $ModelPath).Length
  if ($size -lt 1000000) {
    Remove-Item $ModelPath -Force -ErrorAction SilentlyContinue
    Write-Error "Downloaded file is too small ($size bytes). Check network or download manually."
  }

  Write-Host "Model ready: $ModelPath ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor Green
}
