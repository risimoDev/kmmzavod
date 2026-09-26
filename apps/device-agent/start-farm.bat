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

:: 2. Приоритетный поиск ADB (локальная папка platform-tools всегда в приоритете)
set "ADB_FOUND=0"
if exist "%~dp0platform-tools\adb.exe" (
    set "PATH=%~dp0platform-tools;%PATH%"
    set "ADB_FOUND=1"
    echo [OK] ADB обнаружен в локальной папке: %~dp0platform-tools
) else if exist "%~dp0..\..\platform-tools\adb.exe" (
    set "PATH=%~dp0..\..\platform-tools;%PATH%"
    set "ADB_FOUND=1"
    echo [OK] ADB обнаружен в корне проекта platform-tools
) else if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
    set "PATH=%LOCALAPPDATA%\Android\Sdk\platform-tools;%PATH%"
    set "ADB_FOUND=1"
    echo [OK] ADB обнаружен в Android SDK: %LOCALAPPDATA%\Android\Sdk\platform-tools
) else (
    where adb >nul 2>nul
    if not errorlevel 1 (
        set "ADB_FOUND=1"
        echo [OK] ADB доступен в системном PATH.
    )
)

if "%ADB_FOUND%"=="0" (
    echo.
    echo [ВНИМАНИЕ] Утилита adb.exe не найдена!
    echo Скачайте бесплатный Google Android platform-tools:
    echo https://developer.android.com/tools/releases/platform-tools
    echo и положите папку platform-tools рядом с этим скриптом.
    echo.
)

:: 3. Очистка старых/зависших процессов ADB и безопасный запуск службы
echo.
echo Проверка процессов ADB...
taskkill /F /IM adb.exe >nul 2>nul
ping 127.0.0.1 -n 2 >nul

echo Запуск службы ADB...
adb start-server
if errorlevel 1 (
    echo [ПРЕДУПРЕЖДЕНИЕ] Первая попытка запуска ADB вернула код ошибки.
    echo Сброс и повторный запуск...
    taskkill /F /IM adb.exe >nul 2>nul
    ping 127.0.0.1 -n 2 >nul
    adb start-server
)

echo Ожидание обнаружения USB-плат в стойке (3 сек)...
ping 127.0.0.1 -n 4 >nul

echo.
echo Подключенные платы в стойке:
adb devices -l
echo.

:: 4. Проверка интерфейса AmneziaWG
echo Проверка туннеля с сервером:
ipconfig | findstr "10.66.66.2 10.13.13.2" >nul
if errorlevel 1 (
    echo [ВНИМАНИЕ] Туннельный IP 10.66.66.2 или 10.13.13.2 не найден в ipconfig!
    echo Убедитесь, что AmneziaWG клиент подключен к серверу платформы.
) else (
    echo [OK] Интерфейс AmneziaWG активен.
)

:: 4b. Проверка правила Брандмауэра Windows для порта 8300 (AmneziaWG -> device-agent)
netsh advfirewall firewall show rule name="DeviceAgent 8300" >nul 2>nul
if errorlevel 1 (
    echo Настройка Брандмауэра Windows: открытие порта 8300 для запросов с сервера...
    netsh advfirewall firewall add rule name="DeviceAgent 8300" dir=in action=allow protocol=TCP localport=8300 >nul 2>nul
    if errorlevel 1 (
        echo [СОВЕТ] Если сервер не достучится до 8300, запустите этот bat-файл от имени Администратора для авто-настройки брандмауэра.
    ) else (
        echo [OK] Порт 8300 открыт в Брандмауэре Windows.
    )
) else (
    echo [OK] Правило Брандмауэра для порта 8300 активно.
)

echo.
echo ================================================================
echo   ЗАПУСК NATIVE DEVICE-AGENT (ADB CONTROLLER)...
echo ================================================================
echo.

:: 5. Определение пакетного менеджера (pnpm или npm)
set "RUN_CMD="
where pnpm >nul 2>nul
if not errorlevel 1 set "RUN_CMD=pnpm"
if not defined RUN_CMD (
    where npm >nul 2>nul
    if not errorlevel 1 set "RUN_CMD=npm"
)
if not defined RUN_CMD (
    echo [ОШИБКА] Ни pnpm, ни npm не найдены в системе!
    pause
    exit /b 1
)

:: 6. Установка зависимостей, если еще не установлены
if not exist "node_modules" (
    echo Папка node_modules не найдена. Установка зависимостей через %RUN_CMD%...
    call %RUN_CMD% install
    if errorlevel 1 (
        echo [ОШИБКА] Не удалось установить зависимости!
        pause
        exit /b 1
    )
)

:: 7. Запуск приложения
if "%RUN_CMD%"=="pnpm" (
    call pnpm dev
) else (
    call npm run dev
)

if errorlevel 1 (
    echo.
    echo [ОШИБКА] Device-agent завершился с ошибкой.
)

echo.
echo Процесс завершен. Окно останется открытым для просмотра логов.
pause
