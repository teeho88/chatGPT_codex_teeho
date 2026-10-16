@echo off
setlocal
title Teeho - Update upstream and push

pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot open repository directory.
    pause
    exit /b 1
)

echo =============================================
echo   Teeho - Update upstream and push to GitHub
echo =============================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-upstream.ps1" %*
set "result=%errorlevel%"
echo.
if not "%result%"=="0" (
    echo [FAILED] Update or push failed. Exit code: %result%
) else (
    echo [SUCCESS] Script finished successfully.
)
echo.
pause
popd
exit /b %result%
