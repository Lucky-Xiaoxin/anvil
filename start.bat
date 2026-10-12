@echo off
setlocal
cd /d "%~dp0"
set "ANVIL_OPEN=1"
set "PORT=7788"

rem ---------- port already taken? name the owner, then let the user pick ----------
set "BUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do set "BUSY=%%P"

if not defined BUSY goto preflight

echo [ANVIL] port %PORT% is already in use by PID %BUSY%.
echo         [1] kill it and start ANVIL here
echo         [2] open the running instance in the browser
echo         [3] quit
choice /c 123 /m "[ANVIL] pick 1, 2 or 3"
if errorlevel 3 goto quit
if errorlevel 2 goto open
taskkill /PID %BUSY% /F || goto fail

:preflight
if not exist node_modules (
  echo [ANVIL] installing dependencies...
  call npm install || goto fail
)
if not exist "packages\web\dist\index.html" (
  echo [ANVIL] building web...
  call npm run build || goto fail
)

echo [ANVIL] http://localhost:%PORT%
rem The server gets its own window and node runs in its foreground: no batch file is
rem interrupting it, so Ctrl+C stops it without asking "Terminate batch job (Y/N)?".
rem cmd /k keeps that window open so a crash stays readable. This line mirrors the
rem "start" script in package.json - change both if one changes.
start "ANVIL %PORT%" cmd /k "node --disable-warning=ExperimentalWarning packages/server/src/index.ts"
goto end

:open
start "" "http://localhost:%PORT%"
goto end

:quit
goto end

:fail
echo [ANVIL] startup failed, see the messages above.
pause

:end
