@echo off
rem Double-click to start Studio Forge on Windows.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (call npm install || (pause & exit /b 1))
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:4317"
call npm start
pause
