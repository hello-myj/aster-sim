@echo off
setlocal
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" "%~dp0desktop\main.py" %*
) else (
  python "%~dp0desktop\main.py" %*
)
if errorlevel 1 pause
