@echo off
chcp 65001 >nul
title FreeLLM Work (Paperclip Studio)
cd /d "%~dp0"

echo ==========================================================
echo        🚀 FreeLLM Work (Paperclip Studio)
echo ==========================================================
echo.

:: 1. Check if Chrome debugging port 9223 is running
netstat -ano | findstr ":9223" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [1/3] Chrome is already running with remote debugging on port 9223.
) else (
    echo [1/3] Starting isolated Chrome for FreeLLM Work on port 9223...
    start "FreeLLM Browser" /min cmd /c "FreeLLM_Browser.bat"
)

:: 2. Auto-open application in browser after 4 seconds
start "" /b cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:3100"

:: 3. Start Paperclip Server
echo [2/3] Starting FreeLLM + Paperclip Server on http://localhost:3100...
echo [3/3] The application will open automatically in your browser...
echo.
echo Press Ctrl+C to stop the server at any time.
echo ==========================================================
echo.

call pnpm --filter @paperclipai/server dev

pause
