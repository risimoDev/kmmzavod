@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KMMZAVOD - Проверка Root и Magisk на платах
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-rack-root.ps1"
