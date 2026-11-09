@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

title KMMZAVOD - Traffic Saver

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0save-traffic.ps1"
echo.
pause
