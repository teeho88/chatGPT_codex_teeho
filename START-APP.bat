@echo off
setlocal
title Codex Web GPT - Run from source

pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot open project directory.
    pause
    exit /b 1
)

if not exist "scripts\start-launcher.ts" (
    echo [ERROR] Source entry script scripts\start-launcher.ts was not found.
    popd
    pause
    exit /b 1
)

set "APP_BUN=bun"
where bun >nul 2>&1
if errorlevel 1 (
    if exist "%USERPROFILE%\.bun\bin\bun.exe" (
        set "APP_BUN=%USERPROFILE%\.bun\bin\bun.exe"
    ) else (
        echo [ERROR] Bun was not found. Install Bun 1.4.0 and try again.
        echo https://bun.sh
        popd
        pause
        exit /b 1
    )
)

echo Starting Codex Web GPT from scripts\start-launcher.ts (production)...
echo Dependencies will be installed automatically if needed.
echo This window will close when the app UI is visible.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1" -BunPath "%APP_BUN%" -ScriptPath "scripts/start-launcher.ts"
set "APP_RESULT=%errorlevel%"

if not "%APP_RESULT%"=="0" (
    echo.
    echo [ERROR] App startup failed. Exit code: %APP_RESULT%
    pause
)

popd
exit /b %APP_RESULT%
