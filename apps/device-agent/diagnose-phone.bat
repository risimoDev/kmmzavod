@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

title KMMZAVOD - Диагностика сети платы

set "SERIAL=%~1"
if not defined SERIAL (
    set "SERIAL=ce041714d383c0b70d"
)

if exist "%~dp0platform-tools\adb.exe" (
    set "PATH=%~dp0platform-tools;!PATH!"
) else if exist "%~dp0..\..\platform-tools\adb.exe" (
    set "PATH=%~dp0..\..\platform-tools;!PATH!"
)

echo ================================================================
echo   KMMZAVOD - ГЛУБОКАЯ ДИАГНОСТИКА СЕТИ ПЛАТЫ: !SERIAL!
echo ================================================================
echo.

echo [1/7] Проверка базового интернет-туннеля USB (Gnirehtet ping 77.88.8.8)...
adb -s !SERIAL! shell "ping -c 2 -W 3 77.88.8.8" 2>nul
if errorlevel 1 (
    echo   --^> [ОШИБКА] Пинг 77.88.8.8 не прошел!
    echo       Туннель Gnirehtet не работает на этой плате (нет значка ключа VPN вверху).
) else (
    echo   --^> [OK] Базовый интернет по USB работает (Gnirehtet активен).
)
echo.

echo [2/7] Проверка DNS на телефоне (ping ya.ru)...
adb -s !SERIAL! shell "ping -c 2 -W 3 ya.ru" 2>nul
if errorlevel 1 (
    echo   --^> [ОШИБКА] DNS не разрешает имена! ya.ru не найден.
    echo       Причина: провайдер глушит DNS-запросы или неверный DNS.
) else (
    echo   --^> [OK] DNS работает исправно (ya.ru успешно разрешен).
)
echo.

echo [3/7] Проверка связи с шлюзом агента на ПК (adb reverse 127.0.0.1:8888)...
for /f "delims=" %%R in ('adb -s !SERIAL! shell "{ if command -v curl >/dev/null 2>&1; then curl -s -m 4 http://127.0.0.1:8888/__kmm/ping; else echo NOCURL; fi; } 2>&1"') do (
    set "GW_PING=%%R"
)
echo   --^> Ответ шлюза: !GW_PING!
echo !GW_PING! | findstr "KMM_GATEWAY_OK" >nul
if not errorlevel 1 (
    echo   --^> [OK] adb reverse и шлюз агента работают!
) else (
    echo   --^> [ОШИБКА] Плата не достучалась до шлюза 127.0.0.1:8888 через adb reverse!
)
echo.

echo [4/7] Проверка выхода в интернет через прокси-шлюз (curl -x 127.0.0.1:8888)...
for /f "delims=" %%R in ('adb -s !SERIAL! shell "curl -s -m 8 -x http://127.0.0.1:8888 http://api.ipify.org 2>&1"') do (
    set "GW_IP=%%R"
)
echo   --^> Внешний IP через шлюз: !GW_IP!
echo.

echo [5/7] Проверка прозрачного перехвата sing-box (curl БЕЗ -x)...
for /f "delims=" %%R in ('adb -s !SERIAL! shell "curl -s -m 8 http://api.ipify.org 2>&1"') do (
    set "TRANSPARENT_IP=%%R"
)
echo   --^> Внешний IP через перехват: !TRANSPARENT_IP!
echo.

echo [6/7] Статус службы sing-box на плате...
for /f "delims=" %%P in ('adb -s !SERIAL! shell "pidof sing-box 2>/dev/null"') do (
    set "SB_PID=%%P"
)
if defined SB_PID (
    echo   --^> [OK] sing-box запущен (PID: !SB_PID!)
) else (
    echo   --^> [ОШИБКА] sing-box НЕ ЗАПУЩЕН!
)
echo.
echo Последние строки лога sing-box (/data/local/tmp/kmm-singbox.log):
adb -s !SERIAL! shell "cat /data/local/tmp/kmm-singbox.log 2>/dev/null || echo Нет логов sing-box"
echo.

echo [7/7] Счётчики пакетов iptables KMM_PROXY...
adb -s !SERIAL! shell "su -c 'iptables -t nat -L KMM_PROXY -v -n 2>/dev/null || echo Не удалось прочитать iptables'"
echo.

echo ================================================================
echo Диагностика завершена. Скопируйте весь вывод выше и отправьте мне.
echo ================================================================
pause
