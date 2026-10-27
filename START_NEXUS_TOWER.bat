@echo off
setlocal
cd /d "%~dp0"
echo ================================================
echo       TINETECH NEXUS TOWER - STARTUP
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
if not exist node_modules (
  echo Installing project dependencies. This may take a few minutes...
  call npm install
  if errorlevel 1 goto error
)
call npm run dev
if errorlevel 1 goto error
goto end
:error
echo Startup failed. Read the error above and check README.md.
pause
:end
endlocal
