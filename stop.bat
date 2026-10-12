@echo off
setlocal
rem ---------- port: same single source as start.bat / server / vite proxy ----------
if not defined ANVIL_PORT set "ANVIL_PORT=7788"
set "PORT=%ANVIL_PORT%"

rem exact match ":7788 " so 77880-77889 don't false-hit
set "BUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr "LISTENING"') do set "BUSY=%%P"

if defined BUSY goto stop

echo [ANVIL] nothing is listening on port %PORT% - ANVIL is not running.
goto end

:stop
echo [ANVIL] stopping PID %BUSY% (port %PORT%) ...
taskkill /PID %BUSY% /F
if errorlevel 1 echo [ANVIL] could not stop it, see the message above.

:end
pause
