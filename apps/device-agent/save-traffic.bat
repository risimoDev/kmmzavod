@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KMMZAVOD - Ультра-Экономия Трафика (Защита Баланса Прокси $10/ГБ)

echo ================================================================
echo   KMMZAVOD - ОПТИМИЗАТОР ТРАФИКА И ЗАЩИТА БАЛАНСА ПРОКСИ
echo   Экономия до 98%% платного трафика AstroProxy ($10 / 1 ГБ)
echo ================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0save-traffic.ps1"

echo.
pause