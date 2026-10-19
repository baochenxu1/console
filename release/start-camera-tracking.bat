@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-camera-tracking.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. If first time, run setup-camera-tracking.ps1 first.
  pause
)
