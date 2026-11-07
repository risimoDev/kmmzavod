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

:: Настройка PATH для ADB с поддержкой путей с пробелами
if exist "%~dp0platform-tools\adb.exe" (
    set "PATH=%~dp0platform-tools;!PATH!"
) else if exist "%~dp0..\..\platform-tools\adb.exe" (
    set "PATH=%~dp0..\..\platform-tools;!PATH!"
)

where adb >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] Утилита adb.exe не найдена!
    pause
    exit /b 1
)

echo Поиск подключенных плат в стойке...
echo.

set "COUNT_TOTAL=0"
set "COUNT_ROOT=0"
set "COUNT_NOROOT=0"

for /f "tokens=1,2" %%A in ('adb devices ^| findstr /r /v "^$" ^| findstr /v "List"') do (
    if "%%B"=="device" (
        set /a COUNT_TOTAL+=1
        set "SERIAL=%%A"
        echo ----------------------------------------------------
        echo [!COUNT_TOTAL!] Плата: !SERIAL!

        :: Пробуем сначала adb root
        adb -s !SERIAL! root >nul 2>nul

        :: Проверка ответа su
        set "ROOT_OUT="
        for /f "delims=" %%R in ('adb -s !SERIAL! shell "id; su -c 'id' 2>&1 || su 0 id 2>&1 || true"') do (
            set "ROOT_OUT=!ROOT_OUT! %%R"
        )

        echo !ROOT_OUT! | findstr "uid=0" >nul
        if not errorlevel 1 (
            set /a COUNT_ROOT+=1
            echo   [OK - ROOT] Суперпользователь АКТИВЕН (uid=0). Прозрачный режим TikTok РАБОТАЕТ!
        ) else (
            set /a COUNT_NOROOT+=1
            echo   [ВНИМАНИЕ - НЕТ ROOT] Shell получил отказ: !ROOT_OUT!
            echo   ==^> Открываем Magisk на экране этой платы...
            adb -s !SERIAL! shell monkey -p com.topjohnwu.magisk 1 >nul 2>nul
            adb -s !SERIAL! shell am start -n com.topjohnwu.magisk/.ui.MainActivity >nul 2>nul
            echo   ==^> В Magisk на телефоне: Настройки (шестеренка вверху справа) ^> "Доступ суперпользователя"
            echo   ==^> Установите: "Приложения и ADB" (или на вкладке Superuser включите тумблер для Shell).
        )

        :: Проверка запущен ли sing-box
        set "SB_PID="
        for /f "delims=" %%P in ('adb -s !SERIAL! shell "pidof sing-box 2>/dev/null"') do (
            set "SB_PID=%%P"
        )
        if defined SB_PID (
            echo   [OK - ДВИЖОК] sing-box активен (PID: !SB_PID!)
        ) else (
            echo   [ИНФО] sing-box ожидает назначения прокси или прав root
        )
        echo.
    )
)

echo ================================================================
echo ИТОГИ ДИАГНОСТИКИ:
echo   Всего плат в стойке:  !COUNT_TOTAL!
echo   С активным Root (OK): !COUNT_ROOT! (готовность 100%% к TikTok)
echo   Без прав Root:        !COUNT_NOROOT! (требуется включить в Magisk)
echo ================================================================
echo.
echo Для плат без Root:
echo Откройте Magisk на проблемной плате через scrcpy и переключите
echo "Доступ суперпользователя" на "Приложения и ADB".
echo.
pause
