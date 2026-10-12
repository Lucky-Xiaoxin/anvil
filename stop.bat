@echo off
setlocal
set "PORT=7788"

set "BUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do set "BUSY=%%P"

if defined BUSY goto stop

echo [ANVIL] nothing is listening on port %PORT% - ANVIL is not running.
goto end

:stop
echo [ANVIL] stopping PID %BUSY% (port %PORT%) ...
taskkill /PID %BUSY% /F
if errorlevel 1 echo [ANVIL] could not stop it, see the message above.

:end
pause
