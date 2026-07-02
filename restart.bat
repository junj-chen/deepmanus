@echo off
REM deepmanus restart — kills any running deepmanus services, then starts
REM backend + frontend fresh. This is the single launcher script (double-click
REM it whenever you change code and want to restart).
REM Usage: double-click restart.bat  (or run in cmd).
REM
REM NOTE: taskkill /F /IM python.exe kills ALL python processes, and
REM       /F /IM node.exe kills ALL node processes. If you run other
REM       python/node apps at the same time, stop those first or kill by PID.

setlocal
set ROOT=%~dp0
set LOGDIR=%ROOT%.logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo [deepmanus] stopping old services...

REM Kill any running processes. Ignore errors (process may not exist).
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1

REM Give the OS a moment to free ports :8999 / :5173.
timeout /t 2 /nobreak >nul

echo [deepmanus] starting services fresh...
echo.

REM --- 1. backend (Python, :8999) ---
echo [deepmanus] starting backend  (logs: .logs\backend.log)
start "deepmanus-backend" /D "%ROOT%backend" cmd /c "uv run uvicorn openmanus.main:app --port 8999"

REM --- 2. frontend (vite, :5173) ---
timeout /t 2 /nobreak >nul
echo [deepmanus] starting frontend (logs: .logs\frontend.log)
start "deepmanus-frontend" /D "%ROOT%frontend" cmd /c "yarn dev > %LOGDIR%\frontend.log"

echo.
echo [deepmanus] all services starting.
echo    frontend: http://localhost:5173
echo    backend:  http://localhost:8999/agents/main/health
echo    (close the 2 popup windows to stop each service)
echo.

REM keep this window open so you can see the message
pause
endlocal
