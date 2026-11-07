@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

title KMMZAVOD - Настройка Magisk на плате

set "SERIAL=%~1"
if not defined SERIAL (
    set "SERIAL=98895a36533756304e"
)

:: Настройка PATH для ADB и Scrcpy
if exist "%~dp0platform-tools\adb.exe" (
    set "PATH=%~dp0platform-tools;!PATH!"
) else if exist "%~dp0..\..\platform-tools\adb.exe" (
    set "PATH=%~dp0..\..\platform-tools;!PATH!"
)

echo ================================================================
echo   KMMZAVOD - НАСТРОЙКА ДОСТУПА ROOT В MAGISK ДЛЯ ПЛАТЫ: !SERIAL!
echo ================================================================
echo.

echo 1. Открываем приложение Magisk на плате...
adb -s !SERIAL! shell monkey -p com.topjohnwu.magisk 1 >nul 2>nul
adb -s !SERIAL! shell am start -n com.topjohnwu.magisk/.ui.MainActivity >nul 2>nul

echo 2. Запускаем окно scrcpy для управления платой...
where scrcpy >nul 2>nul
if not errorlevel 1 (
    start "Плата !SERIAL! - Magisk" scrcpy -s !SERIAL!
) else if exist "%~dp0platform-tools\scrcpy.exe" (
    start "Плата !SERIAL! - Magisk" "%~dp0platform-tools\scrcpy.exe" -s !SERIAL!
) else if exist "%~dp0..\..\platform-tools\scrcpy.exe" (
    start "Плата !SERIAL! - Magisk" "%~dp0..\..\platform-tools\scrcpy.exe" -s !SERIAL!
)

echo.
echo ================================================================
echo ИНСТРУКЦИЯ (3 КЛИКА НА ЭКРАНЕ ТЕЛЕФОНА):
echo ================================================================
echo   1) В приложении Magisk нажмите на ШЕСТЕРЕНКУ (Настройки)
echo      в правом верхнем углу экрана.
echo.
echo   2) Пролистайте вниз до раздела "Суперпользователь" (Superuser).
echo.
echo   3) Нажмите "Доступ суперпользователя" (Superuser Access)
echo      и выберите: "Приложения и ADB" (Apps and ADB).
echo.
echo   ИЛИ перейдите на вкладку "Суперпользователь" (щит с галочкой внизу)
echo   и включите тумблер напротив "com.android.shell" (Shell).
echo ================================================================
echo.
echo После включения агент фермы АВТОМАТИЧЕСКИ активирует transparent proxy
echo в течение 10-15 секунд (перезапускать ничего не нужно).
echo.
pause
