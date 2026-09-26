@echo off
chcp 65001 >nul
title KMMZAVOD - Установка APK на стойку телефонов

:: Переход в директорию скрипта
cd /d "%~dp0"

if "%~1"=="" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-apk.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-apk.ps1" -ApkPath "%~1"
)

echo.
pause
