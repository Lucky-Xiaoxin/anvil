@echo off
setlocal
cd /d "%~dp0"
rem NOTE: command line is the primary entry - "npm run dev" (vite 5173 + server 7788),
rem or "npm run build" then "npm start" (serve built assets on 7788).
rem This .bat stays as a double-click convenience. Explorer may warn about an unknown
rem publisher for .bat files - that is Explorer's own shell check, not this script
rem (running the same file from cmd does not prompt).
set "ANVIL_OPEN=1"
rem ---------- port: ANVIL_PORT is the single source (server / vite proxy / dev.mjs read the same) ----------
if not defined ANVIL_PORT set "ANVIL_PORT=7788"
set "PORT=%ANVIL_PORT%"

rem ---------- port already taken? name the owner, then let the user pick ----------
rem exact match ":7788 " so 77880-77889 don't false-hit
set "BUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr "LISTENING"') do set "BUSY=%%P"

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
rem ---------- always rebuild: editing the frontend then double-clicking must not serve a stale bundle ----------
echo [ANVIL] building web...
call npm run build || goto fail

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
