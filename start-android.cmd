@echo off
setlocal
chcp 65001 >nul
title Gonglun Mobile Test
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 or newer, then try again.
  pause
  exit /b 1
)
node "%~dp0scripts\start-android.mjs" %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
timeout /t 3 >nul 2>nul
endlocal
exit /b 0
