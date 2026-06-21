@echo off
title WePost Server
cd /d i:\WorkBuddy\WePost
echo ========================================
echo   WePost - Starting server...
echo   http://localhost:3000
echo   Press Ctrl+C to stop
echo ========================================
echo Killing old process...
taskkill /f /im node.exe 2>nul
timeout /t 1 /nobreak >nul
echo Starting...
node src/server.js
pause
