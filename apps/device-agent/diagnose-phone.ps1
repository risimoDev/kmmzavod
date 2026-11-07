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

Write-Host "[1/7] Базовый туннель USB (Gnirehtet ping 77.88.8.8)..." -ForegroundColor Yellow
$pingRaw = & adb -s $Serial shell "ping -c 2 -W 3 77.88.8.8" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  --> [OK] USB интернет работает (Gnirehtet активен)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] Пинг 77.88.8.8 не прошел! Туннель Gnirehtet не работает на этой плате." -ForegroundColor Red
}

Write-Host ""
Write-Host "[2/7] DNS на телефоне (ping ya.ru)..." -ForegroundColor Yellow
$pingDns = & adb -s $Serial shell "ping -c 2 -W 3 ya.ru" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  --> [OK] DNS работает исправно (ya.ru успешно разрешен)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] DNS не разрешает имена! Провайдер блокирует DNS или нет доступа." -ForegroundColor Red
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
$gwIp = (& adb -s $Serial shell "curl -s -m 8 -x http://127.0.0.1:8888 http://api.ipify.org 2>&1") -join " "
Write-Host "  --> IP: $gwIp" -ForegroundColor White

Write-Host ""
Write-Host "[5/7] Прозрачный перехват sing-box (curl БЕЗ -x)..." -ForegroundColor Yellow
$transIp = (& adb -s $Serial shell "curl -s -m 8 http://api.ipify.org 2>&1") -join " "
Write-Host "  --> IP: $transIp" -ForegroundColor White

Write-Host ""
Write-Host "[6/7] Статус sing-box на плате..." -ForegroundColor Yellow
$sbPid = (& adb -s $Serial shell "pidof sing-box 2>/dev/null").Trim()
if ($sbPid) {
    Write-Host "  --> [OK] sing-box запущен (PID: $sbPid)" -ForegroundColor Green
} else {
    Write-Host "  --> [ОШИБКА] sing-box НЕ запущен!" -ForegroundColor Red
}
Write-Host "Лог sing-box (/data/local/tmp/kmm-singbox.log):" -ForegroundColor DarkGray
& adb -s $Serial shell "cat /data/local/tmp/kmm-singbox.log 2>/dev/null || echo Нет логов"

Write-Host ""
Write-Host "[7/7] Счётчики правил iptables KMM_PROXY..." -ForegroundColor Yellow
& adb -s $Serial shell "su -c 'iptables -t nat -L KMM_PROXY -v -n 2>/dev/null || echo Ошибка iptables'"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Скопируйте вывод выше и отправьте в чат." -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Read-Host "Нажмите Enter для завершения..."
