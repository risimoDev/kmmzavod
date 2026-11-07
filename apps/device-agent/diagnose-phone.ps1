<#
.SYNOPSIS
    KMMZAVOD - Глубокая диагностика и авто-починка конкретной платы (PowerShell)
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
Write-Host "   KMMZAVOD - ДИАГНОСТИКА И ПОЧИНКА ПЛАТЫ: $Serial              " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# Определение внешнего IP фермы
$farmHostIp = $null
try {
    $rawHost = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 3 -ErrorAction SilentlyContinue)
    if ($rawHost -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') { $farmHostIp = $matches[0] }
} catch {}

# Доставка curl если отсутствует
$hasCurl = ("$(& adb -s $Serial shell '{ if command -v curl >/dev/null 2>&1 || [ -x /data/local/tmp/curl ]; then echo YES; else echo NO; fi; } 2>/dev/null')").Trim()
if ($hasCurl -ne "YES") {
    $tempCurl = Join-Path $env:TEMP "kmm_curl_arm64"
    if (Test-Path $tempCurl) {
        & adb -s $Serial push $tempCurl /data/local/tmp/curl 2>$null | Out-Null
        & adb -s $Serial shell "chmod 755 /data/local/tmp/curl" 2>$null | Out-Null
    }
}

Write-Host "[1/7] Проверка интерфейса tun0 (Gnirehtet USB)..." -ForegroundColor Yellow
$tunCheck = (& adb -s $Serial shell "ip addr show tun0 2>/dev/null") -join " "
if ($tunCheck -match "10\.0\.0\.2") {
    Write-Host "  --> [OK] USB интернет активен (интерфейс tun0: 10.0.0.2)" -ForegroundColor Green
} else {
    Write-Host "  --> [ИСПРАВЛЕНИЕ] Перезапуск Gnirehtet..." -ForegroundColor Yellow
    & adb -s $Serial shell "am force-stop com.genymobile.gnirehtet; am start -n com.genymobile.gnirehtet/.GnirehtetActivity" 2>$null | Out-Null
    Start-Sleep -Milliseconds 1500
    Write-Host "  --> [OK] Служба Gnirehtet перезапущена" -ForegroundColor Green
}

Write-Host ""
Write-Host "[2/7] DNS на телефоне (разрешение ya.ru)..." -ForegroundColor Yellow
$dnsCheck = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 4 -o /dev/null -w '%{http_code}' http://ya.ru 2>&1") -join " "
if ($dnsCheck -match "(200|301|302|400|403|404|HTTP)" -or $dnsCheck -match "^[1-5]\d\d$") {
    Write-Host "  --> [OK] DNS работает исправно (ya.ru разрешен)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] DNS не отвечает" -ForegroundColor Red
}

Write-Host ""
Write-Host "[3/7] Проверка Root (Magisk su)..." -ForegroundColor Yellow
$rootCheck = (& adb -s $Serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || id 2>&1 || true") -join " "
if ($rootCheck -match "uid=0\(") {
    Write-Host "  --> [OK] Root активен (uid=0)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] Нет прав root: $rootCheck" -ForegroundColor Red
    Write-Host "      Открываем Magisk на экране..." -ForegroundColor Yellow
    & adb -s $Serial shell "monkey -p com.topjohnwu.magisk 1 >/dev/null 2>&1; am start -n com.topjohnwu.magisk/.ui.MainActivity >/dev/null 2>&1" 2>$null | Out-Null
    Write-Host "      Включите: Настройки (шестеренка) -> 'Доступ суперпользователя' -> 'Приложения и ADB'" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[4/7] Связь с шлюзом агента на ПК (127.0.0.1:8888)..." -ForegroundColor Yellow
$gwPing = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 4 http://127.0.0.1:8888/__kmm/ping 2>&1") -join " "
if ($gwPing -match "KMM_GATEWAY_OK") {
    Write-Host "  --> [OK] Шлюз агента отвечает: $gwPing" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] Шлюз не отвечает. Перепривязка порта..." -ForegroundColor Yellow
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/apply-device" -Method Post -Body (@{ deviceId = $Serial } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
    } catch {}
}

Write-Host ""
Write-Host "[5/7] Внешний IP через шлюз (curl -x 127.0.0.1:8888)..." -ForegroundColor Yellow
$rawProxyIp = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 7 -x http://127.0.0.1:8888 http://api.ipify.org 2>&1") -join " "
Write-Host "  --> IP: $rawProxyIp" -ForegroundColor White

Write-Host ""
Write-Host "[6/7] Прозрачный перехват sing-box (curl БЕЗ -x)..." -ForegroundColor Yellow
$rawTransIp = (& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 7 http://api.ipify.org 2>&1") -join " "
Write-Host "  --> IP: $rawTransIp" -ForegroundColor White

Write-Host ""
Write-Host "[7/7] Связь с серверами TikTok..." -ForegroundColor Yellow
$ttPing = ([string](& adb -s $Serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 6 -k -o /dev/null -w '%{http_code}' https://api.tiktokv.com/ping/ 2>&1")).Trim()
if ($ttPing -match "^(200|403|404|301|302)$") {
    Write-Host "  --> [OK] TikTok доступен (HTTP $ttPing)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] TikTok недоступен: $ttPing" -ForegroundColor Red
}

& adb -s $Serial shell "am force-stop com.zhiliaoapp.musically 2>/dev/null; am force-stop com.ss.android.ugc.trill 2>/dev/null" 2>$null | Out-Null

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Диагностика завершена." -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
