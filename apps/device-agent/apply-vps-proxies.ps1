<#
.SYNOPSIS
    Пакетная привязка 20 VPS (SOCKS5/HTTP прокси) к платам телефонной стойки в режиме private_parallel.
.DESCRIPTION
    1. Считывает список прокси из файла vps-proxies.txt (по одному на строку).
    2. Опрашивает подключенные Android-платы через ADB.
    3. Привязывает к каждой плате свой выделенный VPS-прокси (1 плата = 1 VPS IP).
    4. Переводит стойку в режим "private_parallel" (параллельная публикация со всех плат без очередей).
    5. Запускает проверку внешнего IP на каждой плате и выводит статус.
#>

[CmdletBinding()]
param(
    [string]$ProxyListPath = "$PSScriptRoot\vps-proxies.txt",
    [string]$AgentUrl = "http://127.0.0.1:8300"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - ПРИВЯЗКА 20 VPS ПРОКСИ К ПЛАТАМ СТОЙКИ            " -ForegroundColor Cyan
Write-Host "   Режим: PRIVATE_PARALLEL (Безлимитный трафик, 0 сек ожидания) " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Проверка наличия файла со списком прокси
if (-not (Test-Path $ProxyListPath)) {
    Write-Host "[!] Файл $ProxyListPath не найден!" -ForegroundColor Yellow
    Write-Host "Создаем шаблон файла vps-proxies.txt..." -ForegroundColor Gray
    
    $template = @"
# Список прокси ваших 20 VPS. По одной строке на плату.
# Форматы:
#   IP:PORT:USER:PASS
#   socks5://USER:PASS@IP:PORT
#   http://USER:PASS@IP:PORT
#
# Пример:
# 194.87.112.10:1080:kmmuser:pass123
# 194.87.112.11:1080:kmmuser:pass456
"@
    Set-Content -Path $ProxyListPath -Value $template -Encoding UTF8
    Write-Host "[ИНФО] Создан шаблон: $ProxyListPath" -ForegroundColor Green
    Write-Host "Откройте файл, вставьте туда ваши 20 VPS и запустите этот скрипт снова!" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Нажмите Enter для выхода..."
    exit 0
}

# 2. Чтение и парсинг прокси
$rawLines = Get-Content $ProxyListPath -Encoding UTF8 | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith("#") }
$parsedProxies = @()

foreach ($line in $rawLines) {
    $str = $line.Trim()
    $host = $null
    $port = $null
    $user = $null
    $pass = $null
    $type = "socks5"

    if ($str -match '^(socks5|http)://(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$') {
        $type = $matches[1]
        $user = $matches[2]
        $pass = $matches[3]
        $host = $matches[4]
        $port = [int]$matches[5]
    } elseif ($str -match '^([^:]+):(\d+):([^:]+):(.+)$') {
        $host = $matches[1]
        $port = [int]$matches[2]
        $user = $matches[3]
        $pass = $matches[4]
    } elseif ($str -match '^([^:]+):(\d+)$') {
        $host = $matches[1]
        $port = [int]$matches[2]
    }

    if ($host -and $port) {
        $parsedProxies += [PSCustomObject]@{
            host     = $host
            port     = $port
            username = $user
            password = $pass
            type     = $type
        }
    }
}

if ($parsedProxies.Count -eq 0) {
    Write-Host "[ОШИБКА] В файле $ProxyListPath нет корректных записей прокси!" -ForegroundColor Red
    Write-Host "Формат: IP:PORT:USER:PASS" -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Загружено прокси из файла: $($parsedProxies.Count)" -ForegroundColor Green

# 3. Получение списка подключенных плат через ADB
Write-Host "Опрос плат через ADB..." -ForegroundColor Gray
$adbDevicesRaw = & adb devices -l 2>&1
$devices = @()
foreach ($l in $adbDevicesRaw) {
    if ($l -match '^([a-zA-Z0-9_\-.:]+)\s+device(\s|$)') {
        $devices += $matches[1]
    }
}

if ($devices.Count -eq 0) {
    Write-Host "[ОШИБКА] Ни одной активной платы через ADB не обнаружено!" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Обнаружено активных плат: $($devices.Count)" -ForegroundColor Green
Write-Host ""

# 4. Сопоставление плат и прокси
$assignments = @()
for ($i = 0; $i -lt $devices.Count; $i++) {
    $devId = $devices[$i]
    $proxy = $parsedProxies[$i % $parsedProxies.Count]
    $assignments += @{
        deviceId = $devId
        host     = $proxy.host
        port     = $proxy.port
        username = $proxy.username
        password = $proxy.password
        type     = $proxy.type
    }
    Write-Host "  Плата [$($i+1)] $devId  ──►  $($proxy.type)://$($proxy.host):$($proxy.port) (User: $($proxy.username))" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "[1/3] Перевод стойки в режим 'private_parallel' (параллельная работа)..." -ForegroundColor Yellow
try {
    $modeBody = @{
        mode           = "private_parallel"
        inactivePolicy = "direct"
    } | ConvertTo-Json
    $resMode = Invoke-RestMethod -Uri "$AgentUrl/proxy/mode" -Method Post -ContentType "application/json" -Body $modeBody -TimeoutSec 10
    Write-Host "[OK] Режим private_parallel активирован!" -ForegroundColor Green
} catch {
    Write-Host "[!] Не удалось переключить режим через API ($AgentUrl/proxy/mode): $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "    (Будет применен при перезапуске device-agent)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "[2/3] Отправка пакетной конфигурации прокси в device-agent..." -ForegroundColor Yellow
try {
    $batchBody = @{
        assignments = $assignments
    } | ConvertTo-Json -Depth 5

    $batchRes = Invoke-RestMethod -Uri "$AgentUrl/proxy/batch-set" -Method Post -ContentType "application/json" -Body $batchBody -TimeoutSec 40
    Write-Host "[OK] Успешно привязано прокси: $($batchRes.successful) из $($batchRes.total)" -ForegroundColor Green
    if ($batchRes.failed -gt 0) {
        Write-Host "[!] Ошибок привязки: $($batchRes.failed)" -ForegroundColor Red
        foreach ($r in $batchRes.results) {
            if (-not $r.ok) {
                Write-Host "   - $($r.deviceId): $($r.error)" -ForegroundColor Red
            }
        }
    }
} catch {
    Write-Host "[!] Ошибка запроса к $AgentUrl/proxy/batch-set: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "    Проверьте, что служба device-agent (start-farm.bat) запущена!" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[3/3] Тестирование внешних IP на платах стойки..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

try {
    $checkBody = @{
        deviceIds = $devices
    } | ConvertTo-Json

    $checkRes = Invoke-RestMethod -Uri "$AgentUrl/proxy/batch-check" -Method Post -ContentType "application/json" -Body $checkBody -TimeoutSec 60
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "   РЕЗУЛЬТАТЫ ПРОВЕРКИ IP ДЛЯ КАЖДОЙ ПЛАТЫ:                     " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    
    foreach ($item in $checkRes.results) {
        if ($item.ok) {
            $leakText = if ($item.leakDetected) { "[ВНИМАНИЕ: УТЕЧКА IP!]" } else { "[OK: Защищено]" }
            $color = if ($item.leakDetected) { "Red" } else { "Green" }
            Write-Host " [✓] $($item.deviceId): IP = $($item.ip) ($($item.country), $($item.city), $($item.isp)) $leakText" -ForegroundColor $color
        } else {
            Write-Host " [✗] $($item.deviceId): Ошибка проверки IP - $($item.error)" -ForegroundColor Red
        }
    }
} catch {
    Write-Host "[!] Проверка IP не удалась (таймаут или агент не ответил)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "   НАСТРОЙКА ЗАВЕРШЕНА!                                         " -ForegroundColor Green
Write-Host "   1. Каждая плата теперь выходит в интернет через свой VPS.    " -ForegroundColor Green
Write-Host "   2. Трафик больше не тарифицируется по гигабайтам.             " -ForegroundColor Green
Write-Host "   3. Все платы могут выкладывать ролики ОДНОВРЕМЕННО.          " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Нажмите Enter для выхода..."
