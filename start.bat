@echo off
setlocal
cd /d "%~dp0"
set "ANVIL_OPEN=1"

if not exist node_modules (
  echo [ANVIL] installing dependencies...
  call npm install || goto fail
)
if not exist "packages\web\dist\index.html" (
  echo [ANVIL] building web...
  call npm run build || goto fail
)

echo [ANVIL] http://localhost:7788
call npm start
goto end

:fail
echo [ANVIL] startup failed, see the messages above.
pause

:end
