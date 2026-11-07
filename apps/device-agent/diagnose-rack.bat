@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

title KMMZAVOD - Полная диагностика всех плат стойки

:: Проверка наличия PowerShell
where powershell >nul 2>nul
if not errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-rack.ps1"
    echo.
    pause
    goto :end
)

echo [ОШИБКА] PowerShell не найден в системе.
pause

:end
