@echo off
chcp 65001 >nul
title KMMZAVOD - Open-Source Phone Farm Bridge (20 Boards Rack via ADB)

echo ================================================================
echo   KMMZAVOD - АГЕНТ СТОЙКИ ТЕЛЕФОННОЙ ФЕРМЫ (NATIVE ADB)
echo   Бесплатный открытый контроллер (без подписок и без стороннего ПО)
echo ================================================================
echo.

:: 1. Проверка Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ОШИБКА] Node.js не найден в PATH! Установите Node.js 20+ с сайта nodejs.org.
    pause
    exit /b 1
)

:: 2. Проверка adb
where adb >nul 2>nul
if %errorlevel% neq 0 (
    echo [ПРЕДУПРЕЖДЕНИЕ] ADB не найден в системном PATH.
    echo Проверка стандартных каталогов Android SDK / Platform-Tools...
    if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
        set "PATH=%PATH%;%LOCALAPPDATA%\Android\Sdk\platform-tools"
        echo [OK] ADB обнаружен в Android SDK.
    ) else if exist ".\platform-tools\adb.exe" (
        set "PATH=%PATH%;.\platform-tools"
        echo [OK] ADB обнаружен в локальной папке platform-tools.
    ) else (
        echo [ВНИМАНИЕ] Утилита adb.exe не найдена!
        echo Скачайте бесплатный Android platform-tools от Google:
        echo https://developer.android.com/tools/releases/platform-tools
        echo и добавьте его в PATH или положите папку platform-tools рядом со скриптом.
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
echo Проверка туннеля с сервером AWS (10.13.13.2):
ipconfig | findstr "10.13.13.2" >nul
if %errorlevel% neq 0 (
    echo [ВНИМАНИЕ] IP 10.13.13.2 не найден в ipconfig!
    echo Убедитесь, что AmneziaWG клиент подключен к серверу AWS.
) else (
    echo [OK] Интерфейс AmneziaWG активен (10.13.13.2).
)

echo.
echo ================================================================
echo   ЗАПУСК NATIVE DEVICE-AGENT (ADB CONTROLLER)...
echo ================================================================
echo.

if not exist node_modules (
    echo Установка зависимостей npm...
    call npm install
)

npm run dev

pause
