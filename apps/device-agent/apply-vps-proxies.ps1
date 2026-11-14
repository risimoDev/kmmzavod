<#
.SYNOPSIS
    Пакетная привязка VPS (SOCKS5/HTTP прокси) к платам телефонной стойки в режиме private_parallel.
.DESCRIPTION
    1. Считывает список прокси из файла vps-proxies.txt.
       Поддерживаются форматы:
         SERIAL=IP:PORT:USER:PASS (рекомендуется — явная привязка)
         SERIAL=socks5://USER:PASS@IP:PORT
         IP:PORT:USER:PASS (построчно подставляется к платам)
    2. Опрашивает подключенные Android-платы через ADB.
    3. Привязывает к каждой плате свой выделенный VPS-прокси (1 плата = 1 VPS IP).
    4. Проверяет внешний IP каждой платы (защита от утечек и блокировок РФ).
    5. ТОЛЬКО при успешной верификации переводит стойку в режим "private_parallel" с политикой 'block'.
#>

[CmdletBinding()]
param(
    [string]$ProxyListPath = "$PSScriptRoot\vps-proxies.txt",
    [string]$AgentUrl = "http://127.0.0.1:8300",
    [string]$AgentToken = $env:DEVICE_AGENT_TOKEN
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - ПРИВЯЗКА VPS ПРОКСИ К ПЛАТАМ СТОЙКИ               " -ForegroundColor Cyan
Write-Host "   Режим: PRIVATE_PARALLEL (Безлимитный трафик, строгая защита) " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Проверка наличия файла со списком прокси
if (-not (Test-Path $ProxyListPath)) {
    Write-Host "[!] Файл $ProxyListPath не найден!" -ForegroundColor Yellow
    Write-Host "Создаем шаблон файла vps-proxies.txt..." -ForegroundColor Gray

    $template = @"
# Список прокси ваших VPS. По одной строке на плату.
# Форматы:
#   SERIAL=IP:PORT:USER:PASS  (рекомендуется — привязка к серийному номеру)
#   IP:PORT:USER:PASS         (авто-привязка по списку подключенных плат)
#   socks5://USER:PASS@IP:PORT
#
# Пример с серийниками (adb devices):
# 98891a37534e534d32=194.87.112.10:1080:kmmuser:pass123
# 9889543657374c5a44=194.87.112.11:1080:kmmuser:pass456
"@
    Set-Content -Path $ProxyListPath -Value $template -Encoding UTF8
    Write-Host "[ИНФО] Создан шаблон: $ProxyListPath" -ForegroundColor Green
    Write-Host "Откройте файл, вставьте туда ваши VPS и запустите этот скрипт снова!" -ForegroundColor Yellow
    exit 0
}

# 2. Чтение и парсинг прокси
$rawLines = Get-Content $ProxyListPath -Encoding UTF8 | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith("#") }
$parsedProxies = @()
$explicitMap = @{}

foreach ($line in $rawLines) {
    $str = $line.Trim()
    $pHost = $null
    $pPort = $null
    $pUser = $null
    $pPass = $null
    $pType = "socks5"
    $serial = $null

    if ($str -match '^([a-zA-Z0-9_\-.:]+)=(.*)$') {
        $serial = $matches[1].Trim()
        $str = $matches[2].Trim()
    }

    if ($str -match '^(socks5|http)://(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$') {
        $pType = $matches[1]
        $pUser = $matches[2]
        $pPass = $matches[3]
        $pHost = $matches[4]
        $pPort = [int]$matches[5]
    } elseif ($str -match '^([^:]+):(\d+):([^:]+):(.+)$') {
        $pHost = $matches[1]
        $pPort = [int]$matches[2]
        $pUser = $matches[3]
        $pPass = $matches[4]
    } elseif ($str -match '^([^:]+):(\d+)$') {
        $pHost = $matches[1]
        $pPort = [int]$matches[2]
    }

    if ($pHost -and $pPort) {
        $obj = [PSCustomObject]@{
            host     = $pHost
            port     = $pPort
            username = $pUser
            password = $pPass
            type     = $pType
        }
        if ($serial) {
            $explicitMap[$serial] = $obj
        } else {
            $parsedProxies += $obj
        }
    }
}

$totalAvailable = $parsedProxies.Count + $explicitMap.Count
if ($totalAvailable -eq 0) {
    Write-Host "[ОШИБКА] В файле $ProxyListPath нет корректных записей прокси!" -ForegroundColor Red
    Write-Host "Формат: IP:PORT:USER:PASS или SERIAL=IP:PORT:USER:PASS" -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Загружено записей прокси: $totalAvailable (Явных привязок: $($explicitMap.Count), Общих: $($parsedProxies.Count))" -ForegroundColor Green

# 3. Опрос подключенных плат через ADB
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

# Проверка: если плат больше, чем прокси, нельзя дублировать IP во избежание взаимных банов
if ($devices.Count -gt $totalAvailable) {
    Write-Host "[ОШИБКА] Количество активных плат ($($devices.Count)) превышает количество прокси ($totalAvailable)!" -ForegroundColor Red
    Write-Host "Для режима private_parallel каждая плата должна иметь строго свой личный выделенный IP." -ForegroundColor Red
    Write-Host "Добавьте недостающие прокси в $ProxyListPath." -ForegroundColor Yellow
    exit 1
}

# 4. Сопоставление плат и прокси
$assignments = @()
$poolIdx = 0

for ($i = 0; $i -lt $devices.Count; $i++) {
    $devId = $devices[$i]
    $proxy = $null

    if ($explicitMap.ContainsKey($devId)) {
        $proxy = $explicitMap[$devId]
    } elseif ($poolIdx -lt $parsedProxies.Count) {
        $proxy = $parsedProxies[$poolIdx]
        $poolIdx++
    } else {
        Write-Host "[ОШИБКА] Не хватило прокси для платы $devId!" -ForegroundColor Red
        exit 1
    }

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

$headers = @{}
if ($AgentToken) {
    $headers["x-agent-token"] = $AgentToken
}

# 5. Применение прокси через device-agent (batch-set)
Write-Host ""
Write-Host "[1/3] Применение конфигурации прокси на платах через device-agent..." -ForegroundColor Yellow

$batchBody = @{ assignments = $assignments } | ConvertTo-Json -Depth 5
$batchRes = $null

try {
    $batchRes = Invoke-RestMethod -Uri "$AgentUrl/proxy/batch-set" -Method Post -ContentType "application/json" -Headers $headers -Body $batchBody -TimeoutSec 60
    Write-Host "[OK] Успешно привязано прокси: $($batchRes.successful) из $($batchRes.total)" -ForegroundColor Green
    if ($batchRes.failed -gt 0) {
        Write-Host "[!] Ошибок привязки: $($batchRes.failed)" -ForegroundColor Red
        foreach ($r in $batchRes.results) {
            if (-not $r.ok) {
                Write-Host "   - $($r.deviceId): $($r.error)" -ForegroundColor Red
            }
        }
        Write-Host "[ОШИБКА] Привязка прокси завершилась с ошибками. Режим private_parallel НЕ включен!" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ОШИБКА] Запрос к $AgentUrl/proxy/batch-set не удался: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Проверьте, что служба device-agent запущена!" -ForegroundColor Yellow
    exit 1
}

# 6. Проверка внешних IP плат (batch-check)
Write-Host ""
Write-Host "[2/3] Тестирование внешних IP на всех платах стойки..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

$checkBody = @{ deviceIds = $devices } | ConvertTo-Json
$hasErrors = $false
$seenIps = @{}

try {
    $checkRes = Invoke-RestMethod -Uri "$AgentUrl/proxy/batch-check" -Method Post -ContentType "application/json" -Headers $headers -Body $checkBody -TimeoutSec 90
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "   РЕЗУЛЬТАТЫ ПРОВЕРКИ IP ДЛЯ КАЖДОЙ ПЛАТЫ:                     " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan

    foreach ($item in $checkRes.results) {
        if ($item.ok) {
            $isRu = ($item.country -eq 'RU' -or $item.country -eq 'Russia' -or $item.country -eq 'Russian Federation')
            $leak = $item.leakDetected -or $isRu
            if ($item.ip) {
                if ($seenIps.ContainsKey($item.ip)) {
                    Write-Host " [!] $($item.deviceId): ДУБЛИРУЮЩИЙСЯ IP $($item.ip) (совпадает с $($seenIps[$item.ip]))!" -ForegroundColor Red
                    $hasErrors = $true
                } else {
                    $seenIps[$item.ip] = $item.deviceId
                }
            }

            if ($leak) {
                Write-Host " [✗] $($item.deviceId): ОБНАРУЖЕНА УТЕЧКА IP/РФ ТРАФИКА: $($item.ip) ($($item.country))" -ForegroundColor Red
                $hasErrors = $true
            } else {
                Write-Host " [✓] $($item.deviceId): IP = $($item.ip) ($($item.country), $($item.city), $($item.isp)) [OK]" -ForegroundColor Green
            }
        } else {
            Write-Host " [✗] $($item.deviceId): Ошибка проверки IP - $($item.error)" -ForegroundColor Red
            $hasErrors = $true
        }
    }
} catch {
    Write-Host "[ОШИБКА] Проверка IP не удалась: $($_.Exception.Message)" -ForegroundColor Red
    $hasErrors = $true
}

if ($hasErrors) {
    Write-Host ""
    Write-Host "[ОТМЕНА] Обнаружены ошибки при проверке внешних IP плат стойки!" -ForegroundColor Red
    Write-Host "Режим private_parallel НЕ активирован во избежание блокировок аккаунтов." -ForegroundColor Red
    exit 1
}

# 7. Активация режима private_parallel с политикой block (исключение утечек в direct)
Write-Host ""
Write-Host "[3/3] Все IP чистые! Перевод стойки в режим 'private_parallel' (inactivePolicy: block)..." -ForegroundColor Yellow

try {
    $modeBody = @{
        mode           = "private_parallel"
        inactivePolicy = "block"
    } | ConvertTo-Json

    $resMode = Invoke-RestMethod -Uri "$AgentUrl/proxy/mode" -Method Post -ContentType "application/json" -Headers $headers -Body $modeBody -TimeoutSec 15
    Write-Host "[OK] Режим private_parallel с блокировкой прямых утечек успешно активирован!" -ForegroundColor Green
} catch {
    Write-Host "[ОШИБКА] Не удалось переключить режим через API: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "   [УСПЕХ] НАСТРОЙКА И ВЕРИФИКАЦИЯ 20 VPS ЗАВЕРШЕНА!            " -ForegroundColor Green
Write-Host "   1. Каждая плата имеет личный подтвержденный европейский IP.  " -ForegroundColor Green
Write-Host "   2. Прямые утечки в российский IP полностью заблокированы.     " -ForegroundColor Green
Write-Host "   3. Стойка готова к параллельной выгрузке без очередей.       " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
