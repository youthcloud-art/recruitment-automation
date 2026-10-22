@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-local.ps1" %*
set "localExitCode=%errorlevel%"
if not "%localExitCode%"=="0" pause
exit /b %localExitCode%
