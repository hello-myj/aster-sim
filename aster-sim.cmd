@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0src\cli.js" %*
) else (
  node "%~dp0src\cli.js" %*
)
exit /b %errorlevel%
