@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KMMZAVOD - Глубокий анализатор сети и приложений

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deep-diagnose.ps1" %*
echo.
pause
