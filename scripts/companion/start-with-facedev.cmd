@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  FaceDEV + Xinqi launcher
echo ========================================
echo.

if not exist "%~dp0start.cmd" (
  echo [ERROR] start.cmd not found in this folder.
  echo Put start-with-facedev.cmd and FaceDEV-Companion.exe next to Xinqi start.cmd.
  pause
  exit /b 1
)

if not exist "%~dp0FaceDEV-Companion.exe" (
  echo [ERROR] FaceDEV-Companion.exe not found in this folder.
  echo Copy FaceDEV-Companion.exe from the FaceDEV deliver folder.
  pause
  exit /b 1
)

set "XINQI_ROOT=%~dp0"
if "%XINQI_ROOT:~-1%"=="\" set "XINQI_ROOT=%XINQI_ROOT:~0,-1%"
set "COMPANION_PORT=18740"

echo [1/3] Checking Companion on 127.0.0.1:%COMPANION_PORT% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=[int]$env:COMPANION_PORT; try { $c=New-Object Net.Sockets.TcpClient; $iar=$c.BeginConnect('127.0.0.1',$p,$null,$null); if (-not $iar.AsyncWaitHandle.WaitOne(1200,$false)) { try{$c.Close()}catch{}; exit 2 }; $c.EndConnect($iar); $c.Close() } catch { exit 2 }; try { $r=Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/api/companion/discover' -f $p) -UseBasicParsing -TimeoutSec 2; $j=$r.Content | ConvertFrom-Json; if ($j.ok -and $j.service -eq 'facedev-local-xinqi-companion') { exit 0 } else { exit 3 } } catch { exit 3 }"
set "DISC_EXIT=%ERRORLEVEL%"

if "%DISC_EXIT%"=="0" (
  echo [OK] Companion already running. Skip start.
  goto START_XINQI
)
if "%DISC_EXIT%"=="3" (
  echo [ERROR] Port %COMPANION_PORT% is used by another program ^(not FaceDEV Companion^).
  pause
  exit /b 1
)

echo [2/3] Starting FaceDEV-Companion.exe ...
start "FaceDEV Local Companion" /D "%XINQI_ROOT%" "%XINQI_ROOT%\FaceDEV-Companion.exe" --xinqi-root="%XINQI_ROOT%"

set /a _tries=0
:WAIT_COMPANION
set /a _tries+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/api/companion/discover' -f [int]$env:COMPANION_PORT) -UseBasicParsing -TimeoutSec 2; $j=$r.Content | ConvertFrom-Json; if ($j.ok -and $j.service -eq 'facedev-local-xinqi-companion') { exit 0 } else { exit 1 } } catch { exit 1 }"
if "%ERRORLEVEL%"=="0" (
  echo [OK] Companion is ready.
  echo      Pairing code: Companion window OR %%USERPROFILE%%\.facedev\companion\PAIRING_CODE.txt
  goto START_XINQI
)
if %_tries% GEQ 20 (
  echo [ERROR] Companion start timeout. Check the FaceDEV Local Companion window.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto WAIT_COMPANION

:START_XINQI
echo.
echo [3/3] Calling original start.cmd ...
echo ----------------------------------------
call "%XINQI_ROOT%\start.cmd"
set "XINQI_EXIT=%ERRORLEVEL%"
echo ----------------------------------------
if not "%XINQI_EXIT%"=="0" (
  echo [ERROR] Xinqi start.cmd exit code: %XINQI_EXIT%
  echo Companion window is left running if it already started.
  pause
  exit /b %XINQI_EXIT%
)

echo [DONE] Xinqi process ended. You may close the Companion window manually.
pause
endlocal
exit /b 0
