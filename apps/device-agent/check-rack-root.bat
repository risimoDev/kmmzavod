@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

title KMMZAVOD - Проверка Root и Magisk на платах стойки

echo ================================================================
echo   KMMZAVOD - ДИАГНОСТИКА ROOT И MAGISK НА ПЛАТАХ СТОЙКИ
echo   Проверка разрешений суперпользователя для прозрачного прокси
echo ================================================================
echo.

set "ADB_EXE=adb"
if exist "%~dp0platform-tools\adb.exe" (
    set "ADB_EXE=%~dp0platform-tools\adb.exe"
) else if exist "%~dp0..\..\platform-tools\adb.exe" (
    set "ADB_EXE=%~dp0..\..\platform-tools\adb.exe"
)

echo Поиск подключенных плат...
for /f "tokens=1,2" %%A in ('%ADB_EXE% devices ^| findstr /r /v "^$" ^| findstr /v "List"') do (
    if "%%B"=="device" (
        set "SERIAL=%%A"
        echo.
        echo ----------------------------------------------------
        echo Плата: !SERIAL!

        :: Проверка ответа su
        set "ROOT_OUT="
        for /f "delims=" %%R in ('%ADB_EXE% -s !SERIAL! shell "id; su -c 'id' 2>&1 || su 0 id 2>&1 || true" 2^>nul') do (
            set "ROOT_OUT=!ROOT_OUT! %%R"
        )

        echo !ROOT_OUT! | findstr "uid=0" >nul
        if not errorlevel 1 (
            echo   [OK - ROOT] Суперпользователь активен (uid=0). Прозрачный режим sing-box работает!
        ) else (
            echo   [ВНИМАНИЕ - НЕТ ROOT] Shell не получил права root: !ROOT_OUT!
            echo   ==^> Откройте приложение Magisk на этой плате через scrcpy.
            echo   ==^> В Настройках (шестеренка вверху справа) ^> "Доступ суперпользователя"
            echo   ==^> Выберите: "Приложения и ADB" (или нажмите "Разрешить" в окне запроса).
        )

        :: Проверка запущен ли sing-box
        set "SB_PID="
        for /f "delims=" %%P in ('%ADB_EXE% -s !SERIAL! shell "pidof sing-box" 2^>nul') do (
            set "SB_PID=%%P"
        )
        if defined SB_PID (
            echo   [OK - SING-BOX] sing-box запущен (PID: !SB_PID!)
        ) else (
            echo   [ИНФО] sing-box не активен (запустится автоматически при старте farm-agent)
        )
    )
)

echo.
echo ================================================================
echo Диагностика завершена.
echo ================================================================
pause
