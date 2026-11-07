<#
.SYNOPSIS
    KMMZAVOD - Глубокая диагностика сети платы стойки (PowerShell)
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

param([string]$Serial = "ce041714d383c0b70d")

$localPlatformTools = Join-Path $PSScriptRoot "platform-tools"
$rootPlatformTools = Join-Path $PSScriptRoot "..\..\platform-tools"

if (Test-Path (Join-Path $localPlatformTools "adb.exe")) {
    $env:PATH = "$localPlatformTools;$env:PATH"
} elseif (Test-Path (Join-Path $rootPlatformTools "adb.exe")) {
    $env:PATH = "$rootPlatformTools;$env:PATH"
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - ГЛУБОКАЯ ДИАГНОСТИКА СЕТИ ПЛАТЫ: $Serial          " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/7] Проверка интерфейса tun0 (Gnirehtet USB)..." -ForegroundColor Yellow
$tunCheck = (& adb -s $Serial shell "ip addr show tun0 2>/dev/null") -join " "
if ($tunCheck -match "10\.0\.0\.2") {
    Write-Host "  --> [OK] USB интернет активен (интерфейс tun0: 10.0.0.2)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] Интерфейс tun0 не найден! Gnirehtet не подключен к этой плате." -ForegroundColor Red
}

Write-Host ""
Write-Host "[2/7] DNS на телефоне (проверка разрешения ya.ru)..." -ForegroundColor Yellow
$dnsCheck = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl -s -m 4 -o /dev/null -w '%{http_code}' http://ya.ru; else (printf 'HEAD / HTTP/1.0
Host: ya.ru

'; sleep 1) | toybox nc ya.ru 80; fi; } 2>&1") -join " "
if ($dnsCheck -match "(200|301|302|400|403|404|HTTP)" -or $dnsCheck -match "^[1-5]\d\d$") {
    Write-Host "  --> [OK] DNS работает исправно (ya.ru успешно разрешен)" -ForegroundColor Green
} else {
    $nsCheck = (& adb -s $Serial shell "nslookup ya.ru 2>/dev/null || toybox nslookup ya.ru 2>/dev/null") -join " "
    if ($nsCheck -match "Address") {
        Write-Host "  --> [OK] DNS работает исправно (ya.ru разрешен через nslookup)" -ForegroundColor Green
    } else {
        Write-Host "  --> [ОШИБКА] DNS не разрешает имена! Провайдер блокирует DNS или нет доступа." -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "[3/7] Связь с шлюзом агента на ПК (adb reverse 127.0.0.1:8888)..." -ForegroundColor Yellow
$gwPing = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl -s -m 4 http://127.0.0.1:8888/__kmm/ping; else echo NOCURL; fi; } 2>&1") -join " "
Write-Host "  --> Ответ шлюза: $gwPing" -ForegroundColor White
if ($gwPing -match "KMM_GATEWAY_OK") {
    Write-Host "  --> [OK] adb reverse и шлюз агента работают" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] Плата не достучалась до шлюза 127.0.0.1:8888!" -ForegroundColor Red
}

Write-Host ""
Write-Host "[4/7] Внешний IP через шлюз с прокси (curl -x 127.0.0.1:8888)..." -ForegroundColor Yellow
$rawProxyIp = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl -s -m 7 -x http://127.0.0.1:8888 http://api.ipify.org; else (printf 'GET http://api.ipify.org/ HTTP/1.0
Host: api.ipify.org

'; sleep 3) | toybox nc 127.0.0.1 8888; fi; } 2>&1") -join " "
Write-Host "  --> IP: $rawProxyIp" -ForegroundColor White

Write-Host ""
Write-Host "[5/7] Прозрачный перехват sing-box (curl БЕЗ -x)..." -ForegroundColor Yellow
$rawTransIp = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl -s -m 7 http://api.ipify.org; else (printf 'GET / HTTP/1.0
Host: api.ipify.org

'; sleep 3) | toybox nc api.ipify.org 80; fi; } 2>&1") -join " "
Write-Host "  --> IP: $rawTransIp" -ForegroundColor White

Write-Host ""
Write-Host "[6/7] Проверка Root (Magisk su)..." -ForegroundColor Yellow
$rootCheck = (& adb -s $Serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || id 2>&1 || true") -join " "
if ($rootCheck -match "uid=0\(") {
    Write-Host "  --> [OK] Root активен (uid=0)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] Нет прав root: $rootCheck" -ForegroundColor Red
    Write-Host "      Включите 'Приложения и ADB' в настройках Magisk на плате!" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[7/7] Связь с серверами TikTok..." -ForegroundColor Yellow
$ttPing = ([string](& adb -s $Serial shell "curl -s -m 6 -k -o /dev/null -w '%{http_code}' https://api.tiktokv.com/ping/ 2>&1")).Trim()
if ($ttPing -match "^(200|403|404|301|302)$") {
    Write-Host "  --> [OK] TikTok доступен (HTTP $ttPing)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] TikTok недоступен: $ttPing" -ForegroundColor Red
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Диагностика завершена." -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
