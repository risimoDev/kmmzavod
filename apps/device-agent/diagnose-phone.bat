@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "SERIAL=%~1"
if not defined SERIAL (
    echo [ИНФО] Серийный номер не передан. Запуск полной диагностики всех плат...
    call "%~dp0deep-diagnose.bat"
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deep-diagnose.ps1" -TargetSerial "%SERIAL%"
echo.
pause
