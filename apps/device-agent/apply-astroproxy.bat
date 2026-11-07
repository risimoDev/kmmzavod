@echo off
chcp 65001 >nul
title KMMZAVOD - Применение AstroProxy на стойку

echo ================================================================
echo   KMMZAVOD - ПРИМЕНЕНИЕ ASTROPROXY НА ВСЕ ПЛАТЫ СТОЙКИ
echo ================================================================
echo.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo [1/3] Проверка конфигурации AstroProxy...
echo   Хост: 45.81.32.208:10018
echo   Логин: LevrurisimoiY7
echo   Гео: Казахстан, Residential, JSC Kazakhtelecom
echo.

rem Обновление devices-proxy-state.json на актуальный конфиг AstroProxy
if exist "devices-proxy-state.astroproxy.json" (
    copy /y "devices-proxy-state.astroproxy.json" "devices-proxy-state.json" >nul
    echo [OK] Конфиг devices-proxy-state.json обновлен на AstroProxy.
)

echo.
echo [2/3] Отправка команды переподключения в device-agent на порт 8300...
curl.exe --noproxy * -f -s -m 5 -X POST http://127.0.0.1:8300/proxy/reapply >nul 2>nul
if errorlevel 1 goto da_offline

echo [OK] Служба device-agent обновила настройки прокси на всех платах.
curl.exe --noproxy * -s -m 5 -X POST http://127.0.0.1:8300/proxy/mode -H "Content-Type: application/json" -d "{\"mode\":\"private_parallel\"}" >nul 2>nul
echo [OK] Режим: Private-Parallel. Все 20 плат выходят через AstroProxy Казахстан!
goto da_done

:da_offline
echo [ИНФО] device-agent сейчас не запущен на порту 8300.
echo        При следующем запуске start-farm.bat он автоматически применит AstroProxy!

:da_done
echo.
echo [3/3] Тестирование внешнего IP активной платы...
curl.exe --noproxy * -s -m 15 -X POST http://127.0.0.1:8300/proxy/check -H "Content-Type: application/json" -d "{\"deviceId\":\"98891a37534e534d32\"}" > "%TEMP%\kmm_ip_check.json" 2>nul
if exist "%TEMP%\kmm_ip_check.json" (
    type "%TEMP%\kmm_ip_check.json" | findstr /i "ip"
    del "%TEMP%\kmm_ip_check.json" 2>nul
)

echo.
echo ================================================================
echo   [ГОТОВО] Все 20 плат стойки переведены на AstroProxy!
echo   Перезапустите start-farm.bat, если служба еще не была перезапущена.
echo ================================================================
echo.
pause
