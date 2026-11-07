@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

set "SERIAL=%~1"
if not defined SERIAL (
    echo [ИНФО] Серийный номер не указан. Запускаем полную диагностику всей стойки...
    call "%~dp0diagnose-rack.bat"
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-phone.ps1" "%SERIAL%"
echo.
pause
