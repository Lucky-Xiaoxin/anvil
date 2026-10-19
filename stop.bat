@echo off
setlocal
rem Prefer vault\server.pid written by the ANVIL server. If port owner and pid file
rem disagree, stop.bat asks before killing anything. If only a port owner is found
rem and there is no pid file, it also asks because the owner is not verified.
if not defined ANVIL_PORT set "ANVIL_PORT=7788"
set "PORT=%ANVIL_PORT%"
set "PIDFILE=%~dp0vault\server.pid"

set "PID="
if exist "%PIDFILE%" set /p PID=<"%PIDFILE%"

set "BUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr "LISTENING"') do set "BUSY=%%P"

if not defined BUSY goto nolistener

if defined PID (
  if "%BUSY%"=="%PID%" goto stopport
)

echo [ANVIL] port %PORT% is used by PID %BUSY%.
if not defined PID (
  echo         No vault\server.pid was found, so this owner is not verified as ANVIL.
  echo         [1] kill port owner PID %BUSY%
  echo         [2] quit
  choice /c 12 /m "[ANVIL] pick 1 or 2"
  if errorlevel 2 goto end
  goto stopport
)

echo         vault\server.pid records PID %PID%.
echo         [1] kill port owner PID %BUSY%
echo         [2] kill recorded PID %PID%
echo         [3] quit
choice /c 123 /m "[ANVIL] pick 1, 2 or 3"
if errorlevel 3 goto end
if errorlevel 2 goto stoprecorded
goto stopport

:stopport
echo [ANVIL] stopping port owner PID %BUSY% ...
taskkill /PID %BUSY% /F
if errorlevel 1 goto fail
goto clepid

:stoprecorded
echo [ANVIL] stopping recorded PID %PID% ...
taskkill /PID %PID% /F
if errorlevel 1 goto fail
goto clepid

:nolistener
if defined PID (
  echo [ANVIL] port %PORT% has no listener, but vault\server.pid still records PID %PID%.
  echo         [1] kill that PID
  echo         [2] remove stale pid file only
  echo         [3] quit
  choice /c 123 /m "[ANVIL] pick 1, 2 or 3"
  if errorlevel 3 goto end
  if errorlevel 2 goto clepid
  taskkill /PID %PID% /F
  if errorlevel 1 goto fail
  goto clepid
)

echo [ANVIL] nothing is listening on port %PORT% - ANVIL is not running.
goto end

:clepid
if defined PID del "%PIDFILE%" >nul 2>&1
goto end

:fail
echo [ANVIL] could not stop it, see the message above.

:end
pause
