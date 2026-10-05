@echo off
setlocal
title Fuel Performance Studio
rem Double-click to start Fuel Performance Studio. It opens in your browser.
rem To stop it, press Ctrl+C in this window or close it.

set "PORT=8771"
cd /d "%~dp0"

rem If it is already running, just open the browser.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/api/ping -TimeoutSec 1 | Out-Null; exit 1 } catch { exit 0 }"
if errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 22 or newer from nodejs.org, then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
)
call npm run build
if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )

rem Open the browser once the server answers (up to 30 s).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/api/ping -TimeoutSec 1 | Out-Null; Start-Process 'http://127.0.0.1:%PORT%/'; break } catch { Start-Sleep -Milliseconds 500 } }"

set "FEED_PORT=%PORT%"
node dist\server\server.js
if errorlevel 1 (
  echo.
  echo Fuel Performance Studio stopped with an error. See the messages above.
  pause
)
