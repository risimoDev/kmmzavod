@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KMMZAVOD - Разблокировка Root в Magisk
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-magisk.ps1"
