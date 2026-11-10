@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

title KMMZAVOD - Open-Source Phone Farm Bridge (20 Boards Rack via ADB)

where powershell >nul 2>nul
if not errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-farm.ps1"
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] start-farm.ps1 завершился с кодом ошибки: %errorlevel%
        pause
    )
    exit /b %errorlevel%
)

echo [ОШИБКА] PowerShell не найден в системе.
pause
exit /b 1
