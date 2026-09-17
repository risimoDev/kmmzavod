@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: Всегда переходим в папку скрипта, даже если запустили ярлыком
cd /d "%~dp0"

title KMMZAVOD - Open-Source Phone Farm Bridge (20 Boards Rack via ADB)

echo ================================================================
echo   KMMZAVOD - АГЕНТ СТОЙКИ ТЕЛЕФОННОЙ ФЕРМЫ (NATIVE ADB)
echo   Бесплатный открытый контроллер (без подписок и без стороннего ПО)
echo ================================================================
echo.

:: 1. Проверка Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ОШИБКА] Node.js не найден в PATH!
    echo Установите Node.js 20+ с официального сайта: https://nodejs.org/
    echo После установки перезапустите этот скрипт.
    echo.
    pause
    exit /b 1
)

:: 2. Проверка adb
where adb >nul 2>nul
if %errorlevel% neq 0 (
    echo [ПРЕДУПРЕЖДЕНИЕ] ADB не найден в системном PATH.
    echo Поиск в каталогах Android SDK / Platform-Tools...
    if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
        set "PATH=%PATH%;%LOCALAPPDATA%\Android\Sdk\platform-tools"
        echo [OK] ADB обнаружен в Android SDK.
    ) else if exist ".\platform-tools\adb.exe" (
        set "PATH=%PATH%;%~dp0platform-tools"
        echo [OK] ADB обнаружен в локальной папке platform-tools.
    ) else if exist "..\..\platform-tools\adb.exe" (
        set "PATH=%PATH%;%~dp0..\..\platform-tools"
        echo [OK] ADB обнаружен в корневой папке platform-tools.
    ) else (
        echo.
        echo [ВНИМАНИЕ] Утилита adb.exe не найдена!
        echo Скачайте бесплатный Google Android platform-tools:
        echo https://developer.android.com/tools/releases/platform-tools
        echo и положите папку platform-tools рядом с этим скриптом.
        echo.
    )
) else (
    echo [OK] ADB доступен в PATH.
)

:: 3. Запуск ADB-сервера и опрос плат
echo.
echo Запуск службы ADB...
adb start-server >nul 2>nul

echo Подключенные платы в стойке:
adb devices -l
echo.

:: 4. Проверка интерфейса AmneziaWG
echo Проверка туннеля с сервером AWS:
ipconfig | findstr "10.66.66.2 10.13.13.2" >nul
if %errorlevel% neq 0 (
    echo [ВНИМАНИЕ] Туннельный IP (10.66.66.2 / 10.13.13.2) не найден в ipconfig!
    echo Убедитесь, что AmneziaWG клиент подключен к серверу AWS.
) else (
    echo [OK] Интерфейс AmneziaWG активен.
)

echo.
echo ================================================================
echo   ЗАПУСК NATIVE DEVICE-AGENT (ADB CONTROLLER)...
echo ================================================================
echo.

:: 5. Определение пакетного менеджера (pnpm или npm)
set "RUN_CMD="
where pnpm >nul 2>nul
if %errorlevel% equ 0 (
    set "RUN_CMD=pnpm"
) else (
    where npm >nul 2>nul
    if %errorlevel% equ 0 (
        set "RUN_CMD=npm"
    ) else (
        echo [ОШИБКА] Ни pnpm, ни npm не найдены в системе!
        pause
        exit /b 1
    )
)

:: 6. Установка зависимостей, если еще не установлены
if not exist "node_modules" (
    echo Папка node_modules не найдена. Установка зависимостей через %RUN_CMD%...
    if "%RUN_CMD%"=="pnpm" (
        call pnpm install
    ) else (
        call npm install
    )
    if %errorlevel% neq 0 (
        echo [ОШИБКА] Не удалось установить зависимости!
        pause
        exit /b %errorlevel%
    )
)

:: 7. Запуск приложения (обязательно с call, чтобы окно не закрывалось)
if "%RUN_CMD%"=="pnpm" (
    call pnpm dev
) else (
    call npm run dev
)

if %errorlevel% neq 0 (
    echo.
    echo [ОШИБКА] Device-agent завершился с кодом ошибки %errorlevel%.
)

echo.
echo Процесс завершен. Окно останется открытым для просмотра логов.
pause
