<#
.SYNOPSIS
    KMMZAVOD - Глубокая диагностика и АВТО-ВОССТАНОВЛЕНИЕ всех плат стойки
    Проверка и исправление: USB-сеть -> DNS -> Magisk Root -> Шлюз -> Sing-box -> iptables -> AstroProxy -> TikTok
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Диагностика и авто-восстановление стойки"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - АВТО-ДОКТОР И ДИАГНОСТИКА СЕТИ ВСЕХ ПЛАТ В СТОЙКЕ " -ForegroundColor Cyan
Write-Host "   Проверка и АКТИВНОЕ ИСПРАВЛЕНИЕ всех уровней сети стойки     " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Поиск ADB
$localPlatformTools = Join-Path $PSScriptRoot "platform-tools"
$rootPlatformTools = Join-Path $PSScriptRoot "..\..\platform-tools"

if (Test-Path (Join-Path $localPlatformTools "adb.exe")) {
    $env:PATH = "$localPlatformTools;$env:PATH"
} elseif (Test-Path (Join-Path $rootPlatformTools "adb.exe")) {
    $env:PATH = "$rootPlatformTools;$env:PATH"
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Write-Host "[ОШИБКА] adb.exe не найден! Поместите platform-tools рядом со скриптом." -ForegroundColor Red
    Read-Host "Нажмите Enter для выхода..."
    exit 1
}

# 2. Поиск службы device-agent (порт 8300) на всех возможных IP
$agentRunning = $false
$agentStatus = $null
$agentUrl = "http://127.0.0.1:8300"
$candidateIps = @("127.0.0.1", "10.66.66.2", "10.13.13.2", "localhost")

try {
    $tcpConns = Get-NetTCPConnection -LocalPort 8300 -ErrorAction SilentlyContinue
    foreach ($c in $tcpConns) {
        if ($c.LocalAddress -and $candidateIps -notcontains $c.LocalAddress) {
            $candidateIps = @($c.LocalAddress) + $candidateIps
        }
    }
} catch {}

foreach ($ip in $candidateIps) {
    try {
        $resp = Invoke-RestMethod -Uri "http://${ip}:8300/proxy/status" -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($resp -and ($resp.ok -or $resp.mode)) {
            $agentRunning = $true
            $agentStatus = $resp
            $agentUrl = "http://${ip}:8300"
            break
        }
    } catch {}
}

# 3. Определение внешнего IP фермы в РФ (домашний провайдер ПК)
$farmHostIp = "5.166.179.153"
if ($agentStatus -and $agentStatus.hostIp) {
    $farmHostIp = $agentStatus.hostIp
} else {
    foreach ($ipSvc in @("http://ifconfig.me/ip", "http://icanhazip.com", "http://api.ipify.org")) {
        try {
            $rawHost = (Invoke-RestMethod -Uri $ipSvc -TimeoutSec 3 -ErrorAction SilentlyContinue).Trim()
            if ($rawHost -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
                $farmHostIp = $matches[0]
                break
            }
        } catch {}
    }
}

Write-Host "[ИНФО] Внешний IP фермы (домашний провайдер РФ): $farmHostIp" -ForegroundColor Gray

if ($agentRunning) {
    Write-Host "[OK] Служба farm-agent активна ($agentUrl отвечает)." -ForegroundColor Green
    if ($agentStatus) {
        $modeDesc = if ($agentStatus.mode -eq "shared_sequential") { "Shared (Поочередный: 1 активная плата)" } else { "Private (Параллельный: ВСЕ 20 плат)" }
        $activeDev = if ($agentStatus.activeDeviceId) { $agentStatus.activeDeviceId } else { "не выбрана" }
        Write-Host "  Режим прокси стойки: $modeDesc" -ForegroundColor Cyan
        if ($agentStatus.mode -eq "shared_sequential") {
            Write-Host "  Активная плата с прокси: $activeDev" -ForegroundColor Cyan
            Write-Host "  [ВАЖНО] В режиме Shared прокси Казахстана активен ТОЛЬКО на ОДНОЙ плате ($activeDev)." -ForegroundColor Yellow
            Write-Host "  Остальные 19 плат выходят через интернет РФ ($farmHostIp), где TikTok заблокирован." -ForegroundColor Yellow
        } else {
            Write-Host "  [ОТЛИЧНО] В режиме Private ВСЕ 20 плат выходят через AstroProxy Казахстан!" -ForegroundColor Green
        }
    }
} else {
    Write-Host "[ВНИМАНИЕ] Служба farm-agent не обнаружена на порту 8300." -ForegroundColor Yellow
}

# 4. Проверка процесса Gnirehtet
$gnirehtetProc = Get-Process gnirehtet -ErrorAction SilentlyContinue
if ($gnirehtetProc) {
    Write-Host "[OK] Служба раздачи интернета Gnirehtet активна (PID: $($gnirehtetProc.Id))." -ForegroundColor Green
} else {
    Write-Host "[ВНИМАНИЕ] Процесс gnirehtet.exe не найден в процессах Windows!" -ForegroundColor Red
}
Write-Host ""

# 5. Опрос подключенных плат в стойке
Write-Host "Опрос подключенных плат в стойке..." -ForegroundColor Yellow
$rawDevices = & adb devices -l
$devices = @()

foreach ($line in $rawDevices) {
    if ($line -match "^([^\s]+)\s+device\b(.*)$") {
        $serial = $matches[1]
        $extra = $matches[2]
        $model = "Unknown"
        if ($extra -match "model:([^\s]+)") { $model = $matches[1] }
        $devices += [PSCustomObject]@{
            Serial = $serial
            Model = $model
        }
    }
}

if ($devices.Count -eq 0) {
    Write-Host "[ОШИБКА] Ни одна плата не обнаружена в статусе 'device'!" -ForegroundColor Red
    Read-Host "Нажмите Enter для выхода..."
    exit 1
}

Write-Host "Обнаружено плат: $($devices.Count)" -ForegroundColor Green
Write-Host "Начинаем проверку и самовосстановление..." -ForegroundColor Cyan
Write-Host ""

# Подготовка ARM64 бинарника curl для плат без встроенного curl
$tempCurl = Join-Path $env:TEMP "kmm_curl_arm64"
if (-not (Test-Path $tempCurl)) {
    foreach ($srcDev in $devices) {
        $srcCheck = ("$(& adb -s $srcDev.Serial shell 'command -v curl 2>/dev/null')").Trim()
        if ($srcCheck -and $srcCheck -match "^/") {
            & adb -s $srcDev.Serial pull $srcCheck $tempCurl 2>$null | Out-Null
            if (Test-Path $tempCurl) { break }
        }
    }
}

$results = @()
$counter = 0

foreach ($dev in $devices) {
    $counter++
    $serial = $dev.Serial
    $model = $dev.Model
    $repairedList = @()

    Write-Host "================================================================" -ForegroundColor DarkCyan
    Write-Host "[$counter/$($devices.Count)] Плата: $serial ($model)" -ForegroundColor White
    Write-Host "================================================================" -ForegroundColor DarkCyan

    # [1] Android & Model
    $androidVer = ([string](& adb -s $serial shell "getprop ro.build.version.release 2>/dev/null")).Trim()
    if (-not $androidVer) { $androidVer = "9" }
    Write-Host "  [1/9] Система: Android $androidVer, модель $model" -ForegroundColor Gray

    # [АВТО-ИСПРАВЛЕНИЕ 1] Доставка curl для корейских плат (SM-G955N)
    $hasCurl = ("$(& adb -s $serial shell 'command -v curl 2>/dev/null || [ -x /data/local/tmp/curl ] && echo YES || echo NO')").Trim()
    if ($hasCurl -ne "YES" -and (Test-Path $tempCurl)) {
        & adb -s $serial push $tempCurl /data/local/tmp/curl 2>$null | Out-Null
        & adb -s $serial shell "chmod 755 /data/local/tmp/curl" 2>$null | Out-Null
        $repairedList += "Установлен curl"
        Write-Host "  [АВТО-ИСПРАВЛЕНИЕ] Скопирован curl ARM64 на плату" -ForegroundColor Yellow
    }

    # Определение пути curl на данной плате
    $curlCmd = "curl"
    $checkCurl = ("$(& adb -s $serial shell 'if command -v curl >/dev/null 2>&1; then echo curl; elif [ -x /data/local/tmp/curl ]; then echo /data/local/tmp/curl; fi')").Trim()
    if ($checkCurl -match "/data/local/tmp/curl") {
        $curlCmd = "/data/local/tmp/curl"
    } elseif ($checkCurl -eq "curl") {
        $curlCmd = "curl"
    }

    # [2] Проверка интерфейса tun0 (Gnirehtet)
    $tunCheck = (& adb -s $serial shell "ip addr show tun0 2>/dev/null") -join " "
    $hasTun0 = $tunCheck -match "10\.0\.0\.2"

    if (-not $hasTun0) {
        Write-Host "  [2/9] USB-сеть (Gnirehtet): Интерфейс tun0 упал. Перезапуск службы..." -ForegroundColor Yellow
        & adb -s $serial shell "am force-stop com.genymobile.gnirehtet" 2>$null | Out-Null
        & adb -s $serial shell "am start -n com.genymobile.gnirehtet/.GnirehtetActivity" 2>$null | Out-Null
        Start-Sleep -Milliseconds 1500
        $tunCheck = (& adb -s $serial shell "ip addr show tun0 2>/dev/null") -join " "
        $hasTun0 = $tunCheck -match "10\.0\.0\.2"
        if ($hasTun0) {
            $repairedList += "Перезапущен tun0"
            Write-Host "  [2/9] USB-сеть (Gnirehtet): [АВТО-ИСПРАВЛЕНО] Туннель tun0 перезапущен" -ForegroundColor Green
        } else {
            Write-Host "  [2/9] USB-сеть (Gnirehtet): [ОШИБКА] Интерфейс tun0 не удалось поднять" -ForegroundColor Red
        }
    } else {
        Write-Host "  [2/9] USB-сеть (Gnirehtet): [OK] Туннель tun0 активен (10.0.0.2)" -ForegroundColor Green
    }
    $usbNetOk = $hasTun0

    # [3] Проверка DNS
    $dnsOk = $false
    $dnsCheck = (& adb -s $serial shell "$curlCmd -s -m 5 -o /dev/null -w '%{http_code}' http://ya.ru 2>&1") -join " "
    if ($dnsCheck -match "(200|301|302|400|403|404|HTTP)" -or $dnsCheck -match "^[1-5]\d\d$") {
        $dnsOk = $true
        Write-Host "  [3/9] DNS-резолвер: [OK] Домен ya.ru успешно разрешен" -ForegroundColor Green
    } else {
        $nsCheck = (& adb -s $serial shell "nslookup ya.ru 2>/dev/null || toybox nslookup ya.ru 2>/dev/null") -join " "
        if ($nsCheck -match "Address") {
            $dnsOk = $true
            Write-Host "  [3/9] DNS-резолвер: [OK] Домен ya.ru разрешен через nslookup" -ForegroundColor Green
        } else {
            Write-Host "  [3/9] DNS-резолвер: [ОШИБКА] Домен ya.ru не разрешается" -ForegroundColor Red
        }
    }

    # [4] Проверка Root (Magisk su — БЕЗ вызова adb root!)
    $rootOk = $false
    $rootCheck = (& adb -s $serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || true") -join " "
    if ($rootCheck -match "uid=0\(") {
        $rootOk = $true
        Write-Host "  [4/9] Root (Magisk): [OK] Суперпользователь АКТИВЕН (uid=0)" -ForegroundColor Green
    } else {
        $rootErr = ($rootCheck -replace "\r?\n", " ").Trim()
        Write-Host "  [4/9] Root (Magisk): [ОШИБКА] Shell получил отказ ($rootErr)" -ForegroundColor Red
        Write-Host "        --> В Magisk на телефоне: Вкладка ЩИТ (Суперпользователь) внизу -> Shell -> ВКЛ!" -ForegroundColor Yellow
        Write-Host "        --> Либо в Настройках Magisk (шестеренка): 'Автоматический ответ' -> 'Предоставить'" -ForegroundColor Yellow
        & adb -s $serial shell "monkey -p com.topjohnwu.magisk 1 >/dev/null 2>&1; am start -n com.topjohnwu.magisk/.ui.MainActivity >/dev/null 2>&1" 2>$null | Out-Null
    }

    # [5] Шлюз агента и adb reverse (порт 8888)
    $gatewayOk = $false
    $gwRoute = "none"
    $reverseList = (& adb -s $serial reverse --list 2>$null) -join " "
    $hasReverse = $reverseList -match "tcp:8888"

    if (-not $hasReverse -and $agentRunning) {
        Write-Host "  [5/9] Шлюз агента: Реверс-порт 8888 отсутствует. Перепривязка через агент..." -ForegroundColor Yellow
        try {
            Invoke-RestMethod -Uri "$agentUrl/proxy/apply-device" -Method Post -Body (@{ deviceId = $serial } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
            Start-Sleep -Milliseconds 500
            $reverseList = (& adb -s $serial reverse --list 2>$null) -join " "
            $hasReverse = $reverseList -match "tcp:8888"
            if ($hasReverse) { $repairedList += "Восстановлен reverse 8888" }
        } catch {}
    }

    $gwPing = (& adb -s $serial shell "$curlCmd -s -m 4 http://127.0.0.1:8888/__kmm/ping 2>&1") -join " "
    if ($gwPing -match "KMM_GATEWAY_OK") {
        $gatewayOk = $true
        if ($gwPing -match "proxy") { $gwRoute = "proxy" }
        elseif ($gwPing -match "direct") { $gwRoute = "direct" }
        elseif ($gwPing -match "block") { $gwRoute = "block" }
        Write-Host "  [5/9] Шлюз агента (127.0.0.1:8888): [OK] Маршрут: $gwRoute (reverse: OK)" -ForegroundColor Green
    } else {
        Write-Host "  [5/9] Шлюз агента (127.0.0.1:8888): [ОШИБКА] Нет ответа шлюза: $gwPing" -ForegroundColor Red
    }

    # [6] Выход через шлюз (curl -x)
    $proxyIp = "Нет ответа"
    $proxyOk = $false
    $rawProxyIp = (& adb -s $serial shell "$curlCmd -s -m 12 -x http://127.0.0.1:8888 http://api.ipify.org 2>&1") -join " "
    if ($rawProxyIp -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        $proxyIp = $matches[0]
        $proxyOk = $true
        if ($proxyIp -eq "95.56.111.109" -or $proxyIp -match '^95\.56\.') {
            Write-Host "  [6/9] Выход через шлюз (curl -x): [OK] IP: $proxyIp (AstroProxy Казахстан)" -ForegroundColor Green
        } else {
            Write-Host "  [6/9] Выход через шлюз (curl -x): [ИНФО] IP: $proxyIp (Интернет фермы РФ)" -ForegroundColor Yellow
        }
    } else {
        $proxyIp = ($rawProxyIp -replace "\r?\n", " ").Trim()
        Write-Host "  [6/9] Выход через шлюз (curl -x): [ОШИБКА] $proxyIp" -ForegroundColor Red
    }

    # [7] Движок sing-box и [8] iptables (Авто-восстановление при наличии Root)
    $singboxOk = $false
    $sbPid = ("$(& adb -s $serial shell 'pidof sing-box 2>/dev/null')").Trim()
    if ($sbPid) { $singboxOk = $true }

    $iptablesOk = $false
    $iptCheck = (& adb -s $serial shell "su -c 'iptables -w 3 -t nat -C OUTPUT -p tcp -j KMM_PROXY 2>/dev/null && echo IPT_OK || echo IPT_FAIL' 2>/dev/null") -join " "
    if ($iptCheck -match "IPT_OK") { $iptablesOk = $true }

    # АВТО-ИСПРАВЛЕНИЕ: если Root есть, но sing-box или iptables упали
    if ($rootOk -and (-not $singboxOk -or -not $iptablesOk)) {
        Write-Host "  [7-8] sing-box / iptables не активны. Перезапуск прозрачного режима..." -ForegroundColor Yellow
        if ($agentRunning) {
            try {
                Invoke-RestMethod -Uri "$agentUrl/proxy/apply-device" -Method Post -Body (@{ deviceId = $serial } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 10 -ErrorAction SilentlyContinue | Out-Null
            } catch {}
        } else {
            & adb -s $serial shell "su -c 'sh /data/local/tmp/kmm-proxy.sh start' 2>&1" 2>$null | Out-Null
        }
        Start-Sleep -Milliseconds 1200
        $sbPid = ("$(& adb -s $serial shell 'pidof sing-box 2>/dev/null')").Trim()
        if ($sbPid) { 
            $singboxOk = $true 
            $repairedList += "Запущен sing-box"
        }
        $iptCheck = (& adb -s $serial shell "su -c 'iptables -w 3 -t nat -C OUTPUT -p tcp -j KMM_PROXY 2>/dev/null && echo IPT_OK || echo IPT_FAIL' 2>/dev/null") -join " "
        if ($iptCheck -match "IPT_OK") { 
            $iptablesOk = $true 
            $repairedList += "Включен iptables KMM_PROXY"
        }
    }

    if ($singboxOk) {
        Write-Host "  [7/9] Движок sing-box: [OK] Активен (PID: $sbPid)" -ForegroundColor Green
    } elseif ($rootOk) {
        Write-Host "  [7/9] Движок sing-box: [ОШИБКА] sing-box не смог запуститься" -ForegroundColor Red
    } else {
        Write-Host "  [7/9] Движок sing-box: [ИНФО] Требуется Root в Magisk" -ForegroundColor Gray
    }

    if ($iptablesOk) {
        Write-Host "  [8/9] Правила iptables: [OK] Цепочка KMM_PROXY активна в OUTPUT" -ForegroundColor Green
    } elseif ($rootOk) {
        Write-Host "  [8/9] Правила iptables: [ОШИБКА] Цепочка KMM_PROXY не установлена" -ForegroundColor Red
    } else {
        Write-Host "  [8/9] Правила iptables: [ИНФО] Требуется Root в Magisk" -ForegroundColor Gray
    }

    # [9] Прозрачный выход в интернет БЕЗ -x (как ходят приложения TikTok и Chrome)
    $transIp = "Нет ответа"
    $transOk = $false
    $rawTransIp = (& adb -s $serial shell "$curlCmd -s -S -m 15 http://api.ipify.org 2>&1") -join " "
    if ($rawTransIp -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        $transIp = $matches[0]
        $transOk = $true
        if ($transIp -eq "95.56.111.109" -or $transIp -match '^95\.56\.') {
            Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [OK] IP: $transIp (AstroProxy Казахстан)" -ForegroundColor Green
        } else {
            Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [ИНФО] IP: $transIp (Интернет фермы РФ)" -ForegroundColor Yellow
        }
    } else {
        $transIp = ($rawTransIp -replace "\r?\n", " ").Trim()
        Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [ОШИБКА] $transIp" -ForegroundColor Red
    }

    # [TIKTOK] Проверка связи с серверами TikTok
    $tiktokOk = $false
    $rawTtPing = (& adb -s $serial shell "$curlCmd -s -S -m 15 -k -o /dev/null -w '%{http_code}' https://api.tiktokv.com/ping/ 2>&1") -join " "
    $ttPing = ("$rawTtPing").Trim()
    if ($ttPing -match "(200|403|404|301|302)") {
        $tiktokOk = $true
        Write-Host "  [TIKTOK] Связь с серверами TikTok: [OK] HTTP $ttPing" -ForegroundColor Green
    } else {
        Write-Host "  [TIKTOK] Связь с серверами TikTok: [ОШИБКА] Код: $ttPing (TikTok не отвечает)" -ForegroundColor Red
    }

    # Сброс зависших сетевых сессий TikTok
    & adb -s $serial shell "am force-stop com.zhiliaoapp.musically 2>/dev/null; am force-stop com.ss.android.ugc.trill 2>/dev/null" 2>$null | Out-Null

    # ИТОГОВЫЙ ВЕРДИКТ БЕЗ САМООБМАНА
    $verdict = "НЕИЗВЕСТНО"
    $verdictColor = "Red"
    $isKazakhstan = ($transIp -eq "95.56.111.109" -or $transIp -match '^95\.56\.') -or ($proxyIp -eq "95.56.111.109" -and $gwRoute -eq "proxy")
    $isRussianIp = ($transIp -eq $farmHostIp -or $transIp -match '^5\.166\.')

    if (-not $rootOk) {
        $verdict = "ТРЕБУЕТСЯ ROOT В MAGISK"
        $verdictColor = "Red"
    } elseif (-not $usbNetOk) {
        $verdict = "ОШИБКА СЕТИ USB (Gnirehtet)"
        $verdictColor = "Red"
    } elseif (-not $dnsOk) {
        $verdict = "ОШИБКА: DNS не отвечает"
        $verdictColor = "Red"
    } elseif (-not $singboxOk -or -not $iptablesOk) {
        $verdict = "ОШИБКА: sing-box/iptables не активен"
        $verdictColor = "Red"
    } elseif ($isKazakhstan -and $tiktokOk) {
        $verdict = "ГОТОВ 100% (TikTok через Казахстан: $transIp)"
        $verdictColor = "Green"
    } elseif ($gwRoute -eq "direct" -or $isRussianIp) {
        $verdict = "РЕЗЕРВ SHARED (Трафик РФ: $transIp)"
        $verdictColor = "Yellow"
    } elseif ($tiktokOk) {
        $verdict = "TikTok доступен ($transIp)"
        $verdictColor = "Yellow"
    } else {
        $verdict = "ОШИБКА СОЕДИНЕНИЯ"
        $verdictColor = "Red"
    }

    if ($repairedList.Count -gt 0) {
        Write-Host "  [АВТО-ИСПРАВЛЕНО]: $($repairedList -join ', ')" -ForegroundColor Magenta
    }
    Write-Host "  >> ИТОГ: $verdict" -ForegroundColor $verdictColor
    Write-Host ""

    $results += [PSCustomObject]@{
        Num = $counter
        Serial = $serial
        Model = $model
        UsbNet = if ($usbNetOk) { "OK" } else { "FAIL" }
        DNS = if ($dnsOk) { "OK" } else { "FAIL" }
        Root = if ($rootOk) { "OK" } else { "FAIL" }
        Route = $gwRoute
        ExitIP = if ($transOk) { $transIp } else { $proxyIp }
        TikTok = if ($tiktokOk) { "OK" } else { "FAIL" }
        Verdict = $verdict
    }
}

Write-Host "========================================================================================================" -ForegroundColor Cyan
Write-Host "                         СВОДНАЯ ТАБЛИЦА СТОЙКИ (РЕАЛЬНЫЙ СТАТУС БЕЗ ОБМАНА)                             " -ForegroundColor Cyan
Write-Host "========================================================================================================" -ForegroundColor Cyan

$results | Format-Table -Property Num, Serial, Model, UsbNet, DNS, Root, Route, ExitIP, TikTok, Verdict -AutoSize

$noRootDevices = $results | Where-Object { $_.Root -eq "FAIL" }
$readyDevices = $results | Where-Object { $_.Verdict -match "ГОТОВ 100%" }
$sharedDevices = $results | Where-Object { $_.Verdict -match "РЕЗЕРВ SHARED" }

Write-Host "========================================================================================================" -ForegroundColor Cyan
Write-Host "ИТОГОВЫЙ ОТЧЕТ:" -ForegroundColor Cyan
Write-Host "  Всего плат проверено: $($results.Count)" -ForegroundColor White
Write-Host "  Полностью готовы к TikTok (Казахстан): $($readyDevices.Count)" -ForegroundColor Green
Write-Host "  В резерве Shared (трафик РФ, ждут очереди): $($sharedDevices.Count)" -ForegroundColor Yellow
Write-Host "  Требуют включения Root в Magisk: $($noRootDevices.Count)" -ForegroundColor $(if ($noRootDevices.Count -gt 0) { "Red" } else { "Green" })
Write-Host ""

# Если стойка сейчас в Shared-режиме: предлагаем переключить в Private
if ($agentStatus -and $agentStatus.mode -eq "shared_sequential" -or ($sharedDevices.Count -gt 0)) {
    Write-Host "--------------------------------------------------------------------------------------------------------" -ForegroundColor Cyan
    Write-Host "СОВЕТ: КАК ВКЛЮЧИТЬ ПРОКСИ КАЗАХСТАНА НА ВСЕХ 20 ПЛАТАХ СРАЗУ:" -ForegroundColor Yellow
    Write-Host "Сейчас 19 плат выходят через интернет фермы (РФ, 5.166.179.153), где TikTok заблокирован." -ForegroundColor White
    Write-Host "В Private-режиме ВСЕ 20 плат выходят через AstroProxy Казахстан (95.56.111.109) одновременно!" -ForegroundColor White
    Write-Host ""
    $ans = Read-Host "Включить Private-режим (прокси Казахстана на ВСЕХ 20 платах)? [Y/n]"
    if ($ans -eq "" -or $ans -match "^[yYдД]") {
        Write-Host "Переключение в Private-режим..." -ForegroundColor Yellow
        try {
            $switchRes = Invoke-RestMethod -Uri "$agentUrl/proxy/mode" -Method Post -Body '{"mode":"private_parallel"}' -ContentType 'application/json' -TimeoutSec 5
            Write-Host "[OK] Режим Private успешно активирован! Все 20 плат переведены на AstroProxy Казахстан!" -ForegroundColor Green
            Write-Host "Запустите diagnose-rack.bat снова, чтобы убедиться в 100% готовности всех плат." -ForegroundColor Cyan
        } catch {
            Write-Host "[ИНФО] Запустите set-private-mode.bat для применения." -ForegroundColor Gray
        }
    }
}

Write-Host ""
Read-Host "Нажмите Enter для завершения..."
