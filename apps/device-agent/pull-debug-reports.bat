@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

title KMMZAVOD - Сбор и анализ скриншотов с плат стойки

where powershell >nul 2>nul
if not errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pull-debug-reports.ps1"
    echo.
    pause
    exit /b 0
)

echo [ОШИБКА] PowerShell не найден в системе.
pause
exit /b 1
