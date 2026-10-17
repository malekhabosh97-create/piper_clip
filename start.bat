@echo off
title FreeLLM Work (Paperclip Unified Launcher)
cd /d "%~dp0"
echo Starting FreeLLM Browser Bridge + Paperclip Server...
start "FreeLLM Browser" cmd /c "FreeLLM_Browser.bat"
pnpm dev
pause
