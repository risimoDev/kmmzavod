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
    4. Включает режим "private_parallel" с политикой 'block' (в shared-режиме через прокси
       ходит только одна плата, проверить остальные нельзя).
    5. Проверяет внешний IP каждой платы; при любой ошибке возвращает прежний режим.
#>

[CmdletBinding()]
param(
    [string]$ProxyListPath = "$PSScriptRoot\vps-proxies.txt",
    [string]$AgentUrl = "http://127.0.0.1:8300",
    [string]$AgentToken = $env:DEVICE_AGENT_TOKEN
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Токен: параметр -AgentToken, иначе переменная окружения или .env агента (agent-auth.ps1).
$tokenParam = $AgentToken
. "$PSScriptRoot\agent-auth.ps1"
if ($tokenParam) {
    $AgentHeaders = @{ 'x-agent-token' = $tokenParam }
} elseif ($AgentHeaders.Count -gt 0) {
    # $AgentHeaders (x-agent-token из .env через agent-auth.ps1) — уже готов к использованию.
} else {
    Write-Warning "DEVICE_AGENT_TOKEN не задан (ни параметром, ни окружением, ни в .env) — запросы к агенту пойдут без токена и получат 401."
}

# adb пишет служебные сообщения и ошибки в stderr. При $ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 превращает такую строку в завершающую ошибку — глушим это локально.
function Invoke-Adb {
    $ErrorActionPreference = 'Continue'
    & adb @args 2>&1 | ForEach-Object { "$_" }
}

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
    $pType = "residential"
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
    } elseif ($str -match '^(?:(http|socks5)://)?([^:]+):(\d+):([^:]+):(.+)$') {
        if ($matches[1]) { $pType = $matches[1] }
        $pHost = $matches[2]
        $pPort = [int]$matches[3]
        $pUser = $matches[4]
        $pPass = $matches[5]
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
$adbDevicesRaw = @(Invoke-Adb devices -l)
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

$headers = $AgentHeaders

# Поле ответа может отсутствовать (например, гео-сервис не ответил) — под StrictMode
# обращение к несуществующему свойству бросает исключение, поэтому читаем безопасно.
function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

function Set-ProxyMode([string]$mode, [string]$policy) {
    $body = @{ mode = $mode; inactivePolicy = $policy } | ConvertTo-Json
    Invoke-RestMethod -Uri "$AgentUrl/proxy/mode" -Method Post -ContentType "application/json" -Headers $headers -Body $body -TimeoutSec 15 | Out-Null
}

# 5. Запоминаем текущий режим, чтобы вернуть его при неудаче
$prevMode = $null
$prevPolicy = $null
try {
    $cur = Invoke-RestMethod -Uri "$AgentUrl/proxy/mode" -Method Get -Headers $headers -TimeoutSec 15
    $prevMode = Get-Prop $cur 'mode'
    $prevPolicy = Get-Prop $cur 'inactivePolicy'
} catch {
    Write-Host "[ОШИБКА] device-agent не отвечает на $AgentUrl/proxy/mode : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Проверьте, что служба запущена и что DEVICE_AGENT_TOKEN совпадает с .env агента." -ForegroundColor Yellow
    exit 1
}
if (-not $prevMode) { $prevMode = 'shared_sequential' }
if (-not $prevPolicy) { $prevPolicy = 'block' }

function Restore-Mode {
    if ($prevMode -eq 'private_parallel' -and $prevPolicy -eq 'block') { return }
    try {
        Set-ProxyMode $prevMode $prevPolicy
        Write-Host "[ОТКАТ] Возвращён прежний режим стойки: $prevMode (inactivePolicy: $prevPolicy)." -ForegroundColor Yellow
    } catch {
        Write-Host "[!] Не удалось вернуть прежний режим: $($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host "[ВНИМАНИЕ] Прокси плат уже могли быть заменены. Поставьте автопилот на паузу, исправьте $ProxyListPath и запустите скрипт снова." -ForegroundColor Yellow
}

# 6. Сначала режим private_parallel + block. В shared_sequential через прокси ходит только
#    одна активная плата, поэтому проверить IP всех плат можно лишь в параллельном режиме.
#    Политика block безопасна: плата либо идёт через свой прокси, либо её трафик блокируется.
Write-Host ""
Write-Host "[1/3] Перевод стойки в режим 'private_parallel' (inactivePolicy: block)..." -ForegroundColor Yellow
try {
    Set-ProxyMode 'private_parallel' 'block'
    Write-Host "[OK] Режим включён (было: $prevMode / $prevPolicy)." -ForegroundColor Green
} catch {
    Write-Host "[ОШИБКА] Не удалось переключить режим через API: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# 7. Применение прокси через device-agent (batch-set)
Write-Host ""
Write-Host "[2/3] Применение конфигурации прокси на платах через device-agent..." -ForegroundColor Yellow

$batchBody = @{ assignments = $assignments } | ConvertTo-Json -Depth 5

try {
    $batchRes = Invoke-RestMethod -Uri "$AgentUrl/proxy/batch-set" -Method Post -ContentType "application/json" -Headers $headers -Body $batchBody -TimeoutSec 120
} catch {
    Write-Host "[ОШИБКА] Запрос к $AgentUrl/proxy/batch-set не удался: $($_.Exception.Message)" -ForegroundColor Red
    Restore-Mode
    exit 1
}

$batchFailed = [int](Get-Prop $batchRes 'failed')
Write-Host "Привязано прокси: $(Get-Prop $batchRes 'successful') из $(Get-Prop $batchRes 'total')" -ForegroundColor $(if ($batchFailed -gt 0) { 'Red' } else { 'Green' })
if ($batchFailed -gt 0) {
    foreach ($r in @(Get-Prop $batchRes 'results')) {
        if (-not (Get-Prop $r 'ok')) {
            Write-Host "   - $(Get-Prop $r 'deviceId'): $(Get-Prop $r 'error')" -ForegroundColor Red
        }
    }
    Write-Host "[ОШИБКА] Привязка прокси завершилась с ошибками." -ForegroundColor Red
    Restore-Mode
    exit 1
}

# 8. Проверка внешних IP плат (batch-check)
Write-Host ""
Write-Host "[3/3] Проверка внешних IP на всех платах стойки..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

$checkBody = @{ deviceIds = $devices } | ConvertTo-Json
$hasErrors = $false
$seenIps = @{}

try {
    $checkRes = Invoke-RestMethod -Uri "$AgentUrl/proxy/batch-check" -Method Post -ContentType "application/json" -Headers $headers -Body $checkBody -TimeoutSec 180
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "   РЕЗУЛЬТАТЫ ПРОВЕРКИ IP ДЛЯ КАЖДОЙ ПЛАТЫ:                     " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan

    foreach ($item in @(Get-Prop $checkRes 'results')) {
        $devId   = Get-Prop $item 'deviceId'
        $ip      = Get-Prop $item 'ip'
        $country = Get-Prop $item 'country'

        if (-not (Get-Prop $item 'ok')) {
            Write-Host " [✗] ${devId}: ошибка проверки IP - $(Get-Prop $item 'error')" -ForegroundColor Red
            $hasErrors = $true
            continue
        }
        if (-not $ip) {
            Write-Host " [✗] ${devId}: внешний IP не определён" -ForegroundColor Red
            $hasErrors = $true
            continue
        }
        if ($seenIps.ContainsKey($ip)) {
            Write-Host " [✗] ${devId}: ДУБЛИРУЮЩИЙСЯ IP $ip (совпадает с $($seenIps[$ip]))" -ForegroundColor Red
            $hasErrors = $true
            continue
        }
        $seenIps[$ip] = $devId

        if ((Get-Prop $item 'leakDetected') -or (Get-Prop $item 'exposesHostIp')) {
            Write-Host " [✗] ${devId}: УТЕЧКА — плата выходит с IP фермы ($ip)" -ForegroundColor Red
            $hasErrors = $true
        } elseif (-not $country) {
            # Страну узнать не удалось: не считаем это успехом — российский выход остался бы незамеченным.
            Write-Host " [✗] ${devId}: IP = $ip, страну определить не удалось (гео-сервис не ответил) — повторите запуск" -ForegroundColor Red
            $hasErrors = $true
        } elseif ($country -eq 'RU' -or $country -eq 'Russia' -or $country -eq 'Russian Federation') {
            Write-Host " [✗] ${devId}: российский выходной IP $ip ($country)" -ForegroundColor Red
            $hasErrors = $true
        } else {
            Write-Host " [✓] ${devId}: IP = $ip ($country, $(Get-Prop $item 'city'), $(Get-Prop $item 'isp')) [OK]" -ForegroundColor Green
        }
    }
} catch {
    Write-Host "[ОШИБКА] Проверка IP не удалась: $($_.Exception.Message)" -ForegroundColor Red
    $hasErrors = $true
}

if ($hasErrors) {
    Write-Host ""
    Write-Host "[ОТМЕНА] Проверка внешних IP плат не пройдена." -ForegroundColor Red
    Restore-Mode
    exit 1
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "   [УСПЕХ] ПРОКСИ ПРИВЯЗАНЫ И ПРОВЕРЕНЫ НА $($devices.Count) ПЛАТАХ" -ForegroundColor Green
Write-Host "   1. У каждой платы свой подтверждённый нероссийский IP.       " -ForegroundColor Green
Write-Host "   2. Режим private_parallel, политика block: без прокси        " -ForegroundColor Green
Write-Host "      трафик платы блокируется, а не идёт напрямую.             " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
