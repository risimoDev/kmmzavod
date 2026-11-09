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
if errorlevel 1 (
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

:: 3. Проверка и подготовка служб (ADB, Gnirehtet, Device-Agent)
echo.
echo [1/4] Освобождение портов и процессов 8300 и 5037...

:: Очистка зависших процессов старого device-agent на порту 8300 через нативный netstat
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr :8300') do (
    if not "%%a"=="0" taskkill /F /PID %%a >nul 2>nul
)

:: Завершение старых процессов ADB и Gnirehtet
taskkill /F /IM gnirehtet.exe >nul 2>nul
adb kill-server >nul 2>nul
taskkill /F /IM adb.exe >nul 2>nul

:: Очистка порта 5037 через нативный netstat, если кто-то еще удерживает порт
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr :5037') do (
    if not "%%a"=="0" taskkill /F /PID %%a >nul 2>nul
)
ping 127.0.0.1 -n 2 >nul

echo [2/4] Запуск чистого сервера ADB...
adb start-server
if errorlevel 1 (
    echo [ПРЕДУПРЕЖДЕНИЕ] Первая попытка запуска ADB вернула код ошибки.
    echo Повторный запуск...
    adb kill-server >nul 2>nul
    taskkill /F /IM adb.exe >nul 2>nul
    ping 127.0.0.1 -n 2 >nul
    adb start-server
)
echo [OK] Служба ADB активна.

echo.
echo [3/4] Поиск подключенных плат в стойке...
adb devices -l
echo.

:: 3b. Автозапуск Gnirehtet (раздача интернета по USB для стоек без Wi-Fi)
if not exist "%~dp0platform-tools\gnirehtet.exe" goto :skip_gnirehtet
echo [GNIREHTET] Запуск службы раздачи интернета по USB (DNS 77.88.8.8)...
taskkill /F /IM gnirehtet.exe >nul 2>nul
start "KMMZAVOD - Gnirehtet USB Reverse Tethering" "%~dp0platform-tools\gnirehtet.exe" autorun -d 77.88.8.8,1.1.1.1
echo [OK] Служба Gnirehtet активна.
echo.
:skip_gnirehtet

:: 3c. Проверка нативного движка sing-box (с защитой от зависания при DPI-блокировках)
if not exist "%~dp0bin\sing-box" (
    echo [PROXIES] Проверка нативного движка sing-box для Android ARM64...
    if not exist "%~dp0bin" mkdir "%~dp0bin"
    curl.exe -L -k --connect-timeout 4 --max-time 10 -s -o "%~dp0bin\sing-box.tar.gz" https://github.com/SagerNet/sing-box/releases/download/v1.14.2/sing-box-1.14.2-android-arm64.tar.gz >nul 2>nul
    if exist "%~dp0bin\sing-box.tar.gz" (
        tar -xzf "%~dp0bin\sing-box.tar.gz" -C "%~dp0bin" --strip-components=1 sing-box-1.14.2-android-arm64/sing-box >nul 2>nul
        del "%~dp0bin\sing-box.tar.gz" >nul 2>nul
    )
    if exist "%~dp0bin\sing-box" (
        echo [OK] Нативный движок sing-box загружен в bin\sing-box.
    ) else (
        echo [ИНФО] sing-box не загружен. Агент будет использовать нативный Android system proxy.
    )
)

:: 4. Проверка интерфейса AmneziaWG
echo Проверка туннеля с сервером:
ipconfig | findstr "10.66.66.2 10.13.13.2" >nul
if errorlevel 1 (
    echo [ВНИМАНИЕ] Туннельный IP 10.66.66.2 или 10.13.13.2 не найден в ipconfig!
    echo Убедитесь, что AmneziaWG клиент подключен к серверу платформы.
) else (
    echo [OK] Интерфейс AmneziaWG активен.
)

:: 4a. Прямое подключение к AstroProxy (без промежуточного relay сервера)
set "DEVICE_AGENT_UPSTREAM_VIA="
echo [OK] Режим подключения: Прямой канал к AstroProxy (без задержек relay).

:: 4b. Автоматическое обновление конфигурации прокси на AstroProxy Казахстан
if exist "%~dp0devices-proxy-state.astroproxy.json" (
    if not exist "%~dp0devices-proxy-state.json" (
        copy /y "%~dp0devices-proxy-state.astroproxy.json" "%~dp0devices-proxy-state.json" >nul
        echo [OK] Создана конфигурация AstroProxy для всех 20 плат.
    )
    if exist "%~dp0devices-proxy-state.json" (
        findstr /m "37.27.123.90" "%~dp0devices-proxy-state.json" >nul 2>nul
        if not errorlevel 1 (
            copy /y "%~dp0devices-proxy-state.astroproxy.json" "%~dp0devices-proxy-state.json" >nul
            echo [OK] Обновлен устаревший прокси на AstroProxy Казахстан.
        )
    )
)

:: 4c. Проверка правила Брандмауэра Windows для порта 8300 (AmneziaWG -> device-agent)
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
echo   ЗАПУСК NATIVE DEVICE-AGENT (порт 8300)...
echo ================================================================
echo.

:: 5. Определение пакетного менеджера (pnpm или npm)
set "RUN_CMD="
where pnpm >nul 2>nul
if not errorlevel 1 set "RUN_CMD=pnpm"
if not defined RUN_CMD (
    if exist "%LOCALAPPDATA%\pnpm\pnpm.cmd" set "RUN_CMD=%LOCALAPPDATA%\pnpm\pnpm.cmd"
    if exist "%APPDATA%\npm\pnpm.cmd" set "RUN_CMD=%APPDATA%\npm\pnpm.cmd"
)
if not defined RUN_CMD (
    where npm >nul 2>nul
    if not errorlevel 1 set "RUN_CMD=npm"
)
if not defined RUN_CMD (
    echo [ОШИБКА] Ни pnpm, ни npm не найдены в системе!
    echo Установите Node.js: https://nodejs.org/
    pause
    exit /b 1
)

:: 6. Установка зависимостей, если еще не установлены
if not exist "node_modules" (
    if exist "..\..\package.json" (
        echo Установка зависимостей в корне монорепозитория через %RUN_CMD%...
        cd /d "%~dp0..\.."
        call %RUN_CMD% install
        cd /d "%~dp0"
    ) else (
        echo Установка зависимостей через %RUN_CMD%...
        call %RUN_CMD% install
    )
)

:: 7. Запуск приложения
if "%RUN_CMD%"=="pnpm" (
    call pnpm dev
) else (
    call npx tsx watch src/index.ts
)

if errorlevel 1 (
    echo.
    echo [ОШИБКА] Device-agent завершился с кодом ошибки: %errorlevel%
    echo Возможные причины:
    echo 1. Порт 8300 занят другим процессом
    echo 2. Ошибка в конфигурации devices-proxy-state.json
    echo 3. Ошибка сборки TypeScript
)

echo.
echo Процесс завершен. Окно останется открытым для просмотра логов.
pause
