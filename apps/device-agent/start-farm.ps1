<#
.SYNOPSIS
    KMMZAVOD - Запуск агента стойки телефонной фермы (Native ADB Device-Agent)
.DESCRIPTION
    Скрипт проверяет окружение, очищает зависшие процессы ADB, опрашивает подключенные платы
    и запускает bridge-сервер между фермой и оркестратором платформы.
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Phone Farm Bridge (ADB Controller)"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - АГЕНТ СТОЙКИ ТЕЛЕФОННОЙ ФЕРМЫ (NATIVE ADB)        " -ForegroundColor Cyan
Write-Host "   Бесплатный открытый контроллер (без стороннего ПО и подписок)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Проверка Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ОШИБКА] Node.js не найден в PATH!" -ForegroundColor Red
    Write-Host "Установите Node.js 20+: https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "Нажмите Enter для выхода..."
    exit 1
}

# 2. Поиск и настройка ADB (локальная папка platform-tools в приоритете)
$adbBin = $null
$localPlatformTools = Join-Path $PSScriptRoot "platform-tools"
$rootPlatformTools = Join-Path $PSScriptRoot "..\..\platform-tools"
$sdkPlatformTools = "$env:LOCALAPPDATA\Android\Sdk\platform-tools"

if (Test-Path (Join-Path $localPlatformTools "adb.exe")) {
    $env:PATH = "$localPlatformTools;$env:PATH"
    $adbBin = Join-Path $localPlatformTools "adb.exe"
    Write-Host "[OK] ADB найден в локальной папке: $localPlatformTools" -ForegroundColor Green
} elseif (Test-Path (Join-Path $rootPlatformTools "adb.exe")) {
    $env:PATH = "$rootPlatformTools;$env:PATH"
    $adbBin = Join-Path $rootPlatformTools "adb.exe"
    Write-Host "[OK] ADB найден в корне проекта: $rootPlatformTools" -ForegroundColor Green
} elseif (Test-Path (Join-Path $sdkPlatformTools "adb.exe")) {
    $env:PATH = "$sdkPlatformTools;$env:PATH"
    $adbBin = Join-Path $sdkPlatformTools "adb.exe"
    Write-Host "[OK] ADB найден в Android SDK: $sdkPlatformTools" -ForegroundColor Green
} elseif (Get-Command adb -ErrorAction SilentlyContinue) {
    $adbBin = "adb"
    Write-Host "[OK] ADB доступен в системном PATH" -ForegroundColor Green
} else {
    Write-Host "[ВНИМАНИЕ] adb.exe не найден! Поместите папку platform-tools рядом со скриптом." -ForegroundColor Yellow
}

# Verify the VPS relay and its DNS before interrupting a running farm.
$agentEnvPath = Join-Path $PSScriptRoot '.env'
function Get-AgentSetting([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($value) { return $value.Trim() }
    if (-not (Test-Path -LiteralPath $agentEnvPath)) { return '' }
    $assignment = Select-String -LiteralPath $agentEnvPath -Pattern "^\s*$Name\s*=" | Select-Object -First 1
    if (-not $assignment) { return '' }
    return (($assignment.Line -split '=', 2)[1] -replace '\s+#.*$', '').Trim().Trim('"', "'")
}

$relayUrl = Get-AgentSetting 'DEVICE_AGENT_UPSTREAM_VIA'
$allowDirect = (Get-AgentSetting 'DEVICE_AGENT_ALLOW_DIRECT') -eq '1'
if (-not $relayUrl -and -not $allowDirect) {
    foreach ($address in @('10.66.66.1', '10.13.13.1', '10.8.0.1')) {
        $candidate = "http://${address}:3129"
        & curl.exe -fsS --noproxy '*' -m 3 -o NUL "$candidate/health" 2>$null
        if ($LASTEXITCODE -eq 0) { $relayUrl = $candidate; break }
    }
}
if (-not $relayUrl -and -not $allowDirect) {
    Write-Host '[ОШИБКА] Реле главного VPS недоступно. Проверьте AmneziaWG.' -ForegroundColor Red
    exit 1
}
$gnirehtetDns = '77.88.8.8,1.1.1.1'
if ($relayUrl) {
    if ((Get-AgentSetting 'DEVICE_AGENT_PROXY_ROOT_MODE') -eq 'off') {
        Write-Host '[ОШИБКА] Маршрут через VPS требует прозрачного режима. Проверьте DEVICE_AGENT_PROXY_ROOT_MODE.' -ForegroundColor Red
        exit 1
    }
    if ($relayUrl -notmatch '^\w+://') { $relayUrl = "http://$relayUrl" }
    $relayUri = $null
    if (-not [Uri]::TryCreate($relayUrl, [UriKind]::Absolute, [ref]$relayUri) -or
        $relayUri.Scheme -ne 'http' -or $relayUri.UserInfo -or
        $relayUri.Host -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9.]+$') {
        Write-Host '[ОШИБКА] Укажите HTTP-адрес реле VPS без реквизитов.' -ForegroundColor Red
        exit 1
    }
    if ($relayUri.IsDefaultPort) { $relayUrl = 'http://{0}:3129' -f $relayUri.Host }
    & curl.exe -fsS --noproxy '*' -m 4 -o NUL "$($relayUrl.TrimEnd('/'))/health" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[ОШИБКА] Реле VPS не отвечает на /health.' -ForegroundColor Red
        exit 1
    }
    $dnsIp = Get-AgentSetting 'DEVICE_AGENT_DNS_VIA'
    if (-not $dnsIp) { $dnsIp = $relayUri.Host }
    $parsedDns = $null
    if ($dnsIp -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or
        -not [System.Net.IPAddress]::TryParse($dnsIp, [ref]$parsedDns) -or $parsedDns.ToString() -ne $dnsIp) {
        Write-Host '[ОШИБКА] DEVICE_AGENT_DNS_VIA должен указывать на IPv4 DNS внутри туннеля.' -ForegroundColor Red
        exit 1
    }
    if (-not (Resolve-DnsName -Name 'api.ipify.org' -Server $dnsIp -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress })) {
        Write-Host "[ОШИБКА] DNS через VPS ($dnsIp) не отвечает. Проверьте сервис farm-dns и доступ по порту 53 внутри туннеля." -ForegroundColor Red
        exit 1
    }
    $env:DEVICE_AGENT_UPSTREAM_VIA = $relayUrl
    $env:DEVICE_AGENT_DNS_VIA = $dnsIp
    $gnirehtetDns = $dnsIp
    Write-Host "[OK] Реле и DNS через главный VPS доступны." -ForegroundColor Green
}

# 3. Очистка старых зависших процессов и подготовка ADB
Write-Host ""
Write-Host "Проверка порта агента (8300)..." -ForegroundColor Yellow

# Очистка старого процесса device-agent на порту 8300 через netstat (не зависает на VPN/TUN)
try {
    $lines8300 = netstat -ano 2>$null | Select-String ":8300\s+.*LISTENING"
    foreach ($line in $lines8300) {
        if ($line.Line -match '\s+(\d+)\s*$') {
            $pId = [int]$matches[1]
            if ($pId -gt 0) {
                Write-Host "[ОЧИСТКА] Завершение процесса на порту 8300 (PID $pId)..." -ForegroundColor Yellow
                Stop-Process -Id $pId -Force -ErrorAction SilentlyContinue
            }
        }
    }
} catch {}

if ($adbBin) {
    Write-Host "Запуск службы ADB..." -ForegroundColor Yellow
    & $adbBin start-server
    Write-Host "[OK] Служба ADB активна." -ForegroundColor Green
}

if ($adbBin) {
    Write-Host "Ожидание обнаружения USB-плат в стойке (2 сек)..." -ForegroundColor Yellow
    Start-Sleep -Seconds 2

    Write-Host ""
    Write-Host "Подключенные платы в стойке:" -ForegroundColor Cyan
    $rawDevices = & $adbBin devices -l
    $deviceCount = 0
    foreach ($line in $rawDevices) {
        if ($line -match "^([^\s]+)\s+(device|offline|unauthorized)(.*)$") {
            $deviceCount++
            $serial = $matches[1]
            $state = $matches[2]
            $info = $matches[3].Trim()
            $color = if ($state -eq "device") { "Green" } else { "Red" }
            Write-Host "  [$deviceCount] $serial - $state ($info)" -ForegroundColor $color
            if ($state -eq "device") {
                & $adbBin -s $serial shell "cmd netpolicy set restrict-background false; cmd netpolicy set metered-network false tun0; settings put global data_saver 0; settings put global data_saver_enabled 0; true" 2>$null | Out-Null
            }
        }
    }

    if ($deviceCount -eq 0) {
        Write-Host "  [ВНИМАНИЕ] Ни одна плата не обнаружена в статусе 'device'!" -ForegroundColor Yellow
        Write-Host "  Проверьте USB-подключение хаба и отладку по USB на телефонах." -ForegroundColor Yellow
    } else {
        Write-Host "  Всего активно плат: $deviceCount" -ForegroundColor Green
    }
}

# 3b. Автозапуск Gnirehtet для раздачи интернета по USB (стойки без Wi-Fi)
$gnirehtetExe = Join-Path $PSScriptRoot "platform-tools\gnirehtet.exe"
if (Test-Path $gnirehtetExe) {
    Write-Host ""
    Write-Host "[GNIREHTET] Запуск раздачи интернета по USB..." -ForegroundColor Cyan
    $dnsArgument = [regex]::Escape($gnirehtetDns)
    $relayRunning = Get-CimInstance Win32_Process -Filter "Name='gnirehtet.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match ('(?:^|\s)-d\s+"?' + $dnsArgument + '"?(?:\s|$)') }
    if (-not $relayRunning) {
        Get-Process -Name gnirehtet -ErrorAction SilentlyContinue | Stop-Process -ErrorAction Stop
        Start-Process -FilePath $gnirehtetExe -ArgumentList "autorun", "-d", $gnirehtetDns -WindowStyle Hidden
    }
    Write-Host "[OK] Gnirehtet использует DNS $gnirehtetDns." -ForegroundColor Green
}

# 4. Проверка VPN-туннеля AmneziaWG
Write-Host ""
Write-Host "Проверка туннеля с сервером платформы:" -ForegroundColor Cyan
$ipconfig = ipconfig
if ($ipconfig -match "10\.66\.66\.2" -or $ipconfig -match "10\.13\.13\.2") {
    Write-Host "[OK] Интерфейс AmneziaWG активен (10.66.66.2 / 10.13.13.2)" -ForegroundColor Green
} else {
    Write-Host "[ВНИМАНИЕ] Туннельный IP 10.66.66.2 не найден в ipconfig!" -ForegroundColor Yellow
    Write-Host "Убедитесь, что клиент AmneziaWG запущен и подключен." -ForegroundColor Yellow
}

# 4b. Проверка правила Брандмауэра Windows для порта 8300
try {
    $fw = netsh advfirewall firewall show rule name="DeviceAgent 8300" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Настройка Брандмауэра Windows: открытие порта 8300..." -ForegroundColor Yellow
        netsh advfirewall firewall add rule name="DeviceAgent 8300" dir=in action=allow protocol=TCP localport=8300 >$null 2>$null
    }
} catch {}

# 5. Определение пакетного менеджера (pnpm / npm)
$pkgManager = if (Get-Command pnpm -ErrorAction SilentlyContinue) { "pnpm" } else { "npm" }

# 6. Установка зависимостей, если нет node_modules
Set-Location $PSScriptRoot
if (-not (Test-Path "node_modules")) {
    Write-Host "Папка node_modules не найдена. Установка через $pkgManager..." -ForegroundColor Yellow
    if ($pkgManager -eq "pnpm") { & pnpm install } else { & npm install }
}

# 7. Запуск приложения
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   ЗАПУСК NATIVE DEVICE-AGENT (порт 8300)...                    " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

if ($pkgManager -eq "pnpm") {
    & pnpm dev
} else {
    & npm run dev
}
exit $LASTEXITCODE
