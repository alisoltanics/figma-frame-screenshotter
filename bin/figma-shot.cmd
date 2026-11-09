@echo off
setlocal
set "ROOT=%~dp0.."

if exist "%ROOT%\node_modules\electron\dist\electron.exe" (
  "%ROOT%\node_modules\electron\dist\electron.exe" "%ROOT%\cli.js" %*
) else (
  echo Electron is not installed. Run: cd /d "%ROOT%" ^&^& npm install 1>&2
  exit /b 1
)
