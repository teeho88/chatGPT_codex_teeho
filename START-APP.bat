@echo off
setlocal
title Codex Web GPT - Run from source
set "APP_HIDDEN=0"
set "APP_HIDDEN_ARG="
if /I "%~1"=="--hidden" (
    set "APP_HIDDEN=1"
    set "APP_HIDDEN_ARG=-Hidden"
)

pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot open project directory.
    if "%APP_HIDDEN%"=="0" pause
    exit /b 1
)

if not exist "scripts\start-launcher.ts" (
    echo [ERROR] Source entry script scripts\start-launcher.ts was not found.
    popd
    if "%APP_HIDDEN%"=="0" pause
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
        if "%APP_HIDDEN%"=="0" pause
        exit /b 1
    )
)

echo Starting Codex Web GPT from scripts\start-launcher.ts (production)...
echo Dependencies will be installed automatically if needed.
echo This window will close when the app UI is visible.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1" -BunPath "%APP_BUN%" -ScriptPath "scripts/start-launcher.ts" %APP_HIDDEN_ARG%
set "APP_RESULT=%errorlevel%"

if not "%APP_RESULT%"=="0" (
    echo.
    echo [ERROR] App startup failed. Exit code: %APP_RESULT%
    if "%APP_HIDDEN%"=="0" pause
)

popd
exit /b %APP_RESULT%
