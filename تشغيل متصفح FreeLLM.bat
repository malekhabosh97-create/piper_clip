@echo off
echo Starting Google Chrome for Paperclip FreeLLM Work (Port 9223)...
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="C:\Users\malek\.piperclip-browser-profile" --no-first-run --no-default-browser-check "https://chat.deepseek.com"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Failed to start Chrome. Trying Microsoft Edge...
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223 --user-data-dir="C:\Users\malek\.piperclip-browser-profile" --no-first-run --no-default-browser-check "https://chat.deepseek.com"
)
