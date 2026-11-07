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

# 2. Определение внешнего IP фермы (домашний провайдер ПК в РФ)
$farmHostIp = $null
try {
    $rawHost = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 3 -ErrorAction SilentlyContinue)
    if ($rawHost -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') { $farmHostIp = $matches[0] }
} catch {}

# 3. Проверка службы device-agent (порт 8300)
$agentRunning = $false
$agentStatus = $null
try {
    $tcp = Get-NetTCPConnection -LocalPort 8300 -ErrorAction SilentlyContinue
    if ($tcp) {
        $agentRunning = $true
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/status" -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($resp) { 
                $agentStatus = $resp 
                if (-not $farmHostIp -and $resp.hostIp) { $farmHostIp = $resp.hostIp }
            }
        } catch {}
    }
} catch {}

if ($farmHostIp) {
    Write-Host "[ИНФО] Внешний IP фермы (домашний интернет РФ): $farmHostIp" -ForegroundColor Gray
}

if ($agentRunning) {
    Write-Host "[OK] Служба farm-agent активна (порт 8300 отвечает)." -ForegroundColor Green
    if ($agentStatus) {
        $modeDesc = if ($agentStatus.mode -eq "shared_sequential") { "Shared (Поочередный: 1 активная плата)" } else { "Private (Параллельный: ВСЕ 20 плат)" }
        $activeDev = if ($agentStatus.activeDeviceId) { $agentStatus.activeDeviceId } else { "не выбрана" }
        Write-Host "  Режим прокси стойки: $modeDesc" -ForegroundColor Cyan
        Write-Host "  Активная плата с прокси: $activeDev" -ForegroundColor Cyan
        if ($agentStatus.mode -eq "shared_sequential") {
            Write-Host "  [ВАЖНО] В режиме Shared прокси Казахстана активен ТОЛЬКО на ОДНОЙ плате ($activeDev)." -ForegroundColor Yellow
            Write-Host "  Остальные 19 плат выходят через интернет фермы (РФ), где TikTok заблокирован." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "[ВНИМАНИЕ] Служба farm-agent (start-farm.bat) НЕ обнаружена на порту 8300!" -ForegroundColor Yellow
    Write-Host "  Рекомендуется запустить start-farm.bat для работы шлюза и sing-box." -ForegroundColor Yellow
}

# 4. Проверка процесса Gnirehtet
$gnirehtetProc = Get-Process gnirehtet -ErrorAction SilentlyContinue
if ($gnirehtetProc) {
    Write-Host "[OK] Служба раздачи интернета Gnirehtet активна (PID: $($gnirehtetProc.Id))." -ForegroundColor Green
} else {
    Write-Host "[ВНИМАНИЕ] Процесс gnirehtet.exe не найден в процессах Windows!" -ForegroundColor Red
    Write-Host "  Телефоны могут не иметь выхода в интернет по USB." -ForegroundColor Red
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
    Write-Host "Проверьте USB-хаб и отладку по USB." -ForegroundColor Red
    Read-Host "Нажмите Enter для выхода..."
    exit 1
}

Write-Host "Обнаружено плат: $($devices.Count)" -ForegroundColor Green
Write-Host "Начинаем диагностику и автоматическое исправление неполадок..." -ForegroundColor Cyan
Write-Host ""

# Подготовка ARM64 бинарника curl
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
    $hasCurl = ("$(& adb -s $serial shell '{ if command -v curl >/dev/null 2>&1 || [ -x /data/local/tmp/curl ]; then echo YES; else echo NO; fi; } 2>/dev/null')").Trim()
    if ($hasCurl -ne "YES" -and (Test-Path $tempCurl)) {
        & adb -s $serial push $tempCurl /data/local/tmp/curl 2>$null | Out-Null
        & adb -s $serial shell "chmod 755 /data/local/tmp/curl" 2>$null | Out-Null
        $repairedList += "Установлен curl"
        Write-Host "  [АВТО-ИСПРАВЛЕНИЕ] Скопирован curl ARM64 на плату" -ForegroundColor Yellow
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
    $dnsCheck = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 4 -o /dev/null -w '%{http_code}' http://ya.ru 2>&1") -join " "
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
    $rootCheck = (& adb -s $serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || id 2>&1 || true") -join " "
    if ($rootCheck -match "uid=0\(") {
        $rootOk = $true
        Write-Host "  [4/9] Root (Magisk): [OK] Суперпользователь АКТИВЕН (uid=0)" -ForegroundColor Green
    } else {
        $rootErr = ($rootCheck -replace "\r?\n", " ").Trim()
        Write-Host "  [4/9] Root (Magisk): [ОШИБКА] Отказ доступа: $rootErr" -ForegroundColor Red
        Write-Host "        --> ВНИМАНИЕ: Приложение TikTok игнорирует системный прокси!" -ForegroundColor Yellow
        Write-Host "        --> Без Root плата выходит через интернет РФ и TikTok НЕ РАБОТАЕТ." -ForegroundColor Yellow
        # Автоматически открываем приложение Magisk на экране этой платы
        & adb -s $serial shell "monkey -p com.topjohnwu.magisk 1 >/dev/null 2>&1; am start -n com.topjohnwu.magisk/.ui.MainActivity >/dev/null 2>&1" 2>$null | Out-Null
        Write-Host "        [ДЕЙСТВИЕ] Magisk открыт на плате $serial! Включите: Шестеренка -> Доступ суперпользователя -> 'Приложения и ADB'" -ForegroundColor Cyan
    }

    # [5] Шлюз агента и adb reverse (порт 8888)
    $gatewayOk = $false
    $gwRoute = "none"
    $reverseList = (& adb -s $serial reverse --list 2>$null) -join " "
    $hasReverse = $reverseList -match "tcp:8888"

    if (-not $hasReverse -and $agentRunning) {
        Write-Host "  [5/9] Шлюз агента: Реверс-порт 8888 отсутствует. Перепривязка через агент..." -ForegroundColor Yellow
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/apply-device" -Method Post -Body (@{ deviceId = $serial } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
            Start-Sleep -Milliseconds 500
            $reverseList = (& adb -s $serial reverse --list 2>$null) -join " "
            $hasReverse = $reverseList -match "tcp:8888"
            if ($hasReverse) { $repairedList += "Восстановлен reverse 8888" }
        } catch {}
    }

    $gwPing = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 3 http://127.0.0.1:8888/__kmm/ping 2>&1") -join " "
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
    $rawProxyIp = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 7 -x http://127.0.0.1:8888 http://api.ipify.org 2>&1") -join " "
    if ($rawProxyIp -match "\b(?:\d{1,3}\.){3}\d{1,3}\b") {
        $proxyIp = $matches[0]
        $proxyOk = $true
        $ipNote = if ($gwRoute -eq "proxy") { "(AstroProxy Казахстан)" } else { "(Интернет фермы РФ)" }
        Write-Host "  [6/9] Выход через шлюз (curl -x): [OK] IP: $proxyIp $ipNote" -ForegroundColor Green
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
                Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/apply-device" -Method Post -Body (@{ deviceId = $serial } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 10 -ErrorAction SilentlyContinue | Out-Null
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
    $rawTransIp = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 7 http://api.ipify.org 2>&1") -join " "
    if ($rawTransIp -match "\b(?:\d{1,3}\.){3}\d{1,3}\b") {
        $transIp = $matches[0]
        $transOk = $true
        if ($farmHostIp -and $transIp -eq $farmHostIp) {
            Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [ИНФО] IP: $transIp (Провайдер РФ)" -ForegroundColor Yellow
        } else {
            Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [OK] IP: $transIp (Прокси Казахстана)" -ForegroundColor Green
        }
    } else {
        $transIp = ($rawTransIp -replace "\r?\n", " ").Trim()
        Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [ОШИБКА] $transIp" -ForegroundColor Red
    }

    # [TIKTOK] Проверка связи с TikTok и сброс зависших сокетов
    $tiktokOk = $false
    $ttPing = ([string](& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 6 -k -o /dev/null -w '%{http_code}' https://api.tiktokv.com/ping/ 2>&1")).Trim()
    if ($ttPing -match "^(200|403|404|301|302)$") {
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
    $isProxyExit = ($transOk -and $farmHostIp -and $transIp -ne $farmHostIp) -or ($gwRoute -eq "proxy" -and $transIp -ne $farmHostIp -and $transOk)

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
    } elseif ($isProxyExit -and $tiktokOk) {
        $verdict = "ГОТОВ 100% (TikTok через прокси $transIp)"
        $verdictColor = "Green"
    } elseif ($agentStatus -and $agentStatus.mode -eq "shared_sequential" -and $agentStatus.activeDeviceId -ne $serial) {
        $verdict = "РЕЗЕРВ SHARED (Трафик РФ: $transIp)"
        $verdictColor = "Yellow"
    } elseif ($farmHostIp -and $transIp -eq $farmHostIp) {
        $verdict = "УТЕЧКА: Трафик идет через РФ вместо Казахстана!"
        $verdictColor = "Red"
    } elseif ($tiktokOk) {
        $verdict = "TikTok доступен"
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
        ExitIP = $transIp
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
Write-Host "  Полностью готовы к TikTok (прокси активен): $($readyDevices.Count)" -ForegroundColor Green
Write-Host "  В резерве Shared (ждут очереди, интернет РФ): $($sharedDevices.Count)" -ForegroundColor Yellow
Write-Host "  Требуют включения Root в Magisk: $($noRootDevices.Count)" -ForegroundColor $(if ($noRootDevices.Count -gt 0) { "Red" } else { "Green" })
Write-Host ""

if ($noRootDevices.Count -gt 0) {
    Write-Host "ИНСТРУКЦИЯ ДЛЯ ПЛАТ БЕЗ ROOT:" -ForegroundColor Red
    Write-Host "На платах без Root приложение TikTok НЕ МОЖЕТ ходить через прокси и блокируется!" -ForegroundColor Yellow
    Write-Host "Для каждой проблемной платы запустите open-magisk.bat <Serial> или переключите на телефоне:" -ForegroundColor White
    Write-Host "  1) В Magisk нажмите на ШЕСТЕРЕНКУ (справа вверху)" -ForegroundColor White
    Write-Host "  2) Выберите 'Доступ суперпользователя' -> 'Приложения и ADB'" -ForegroundColor White
    Write-Host ""
}

if ($agentStatus -and $agentStatus.mode -eq "shared_sequential") {
    Write-Host "--------------------------------------------------------------------------------------------------------" -ForegroundColor Cyan
    Write-Host "РЕКОМЕНДАЦИЯ ПО РЕЖИМУ ПРОКСИ:" -ForegroundColor Yellow
    Write-Host "Стойка сейчас работает в режиме Shared (прокси Казахстана включен только на ОДНОЙ плате)." -ForegroundColor White
    Write-Host "Остальные платы выходят через домашний интернет РФ, где TikTok заблокирован." -ForegroundColor White
    Write-Host "Вы можете переключить стойку в Private-режим, чтобы ВСЕ платы выходили через прокси одновременно." -ForegroundColor White
    Write-Host ""
    $ans = Read-Host "Включить Private-режим (прокси на ВСЕХ платах одновременно)? (y/N)"
    if ($ans -match "^[yYдД]") {
        Write-Host "Отправка команды переключения режима в device-agent..." -ForegroundColor Yellow
        try {
            $switchRes = Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/mode" -Method Post -Body '{"mode":"private_parallel"}' -ContentType "application/json" -TimeoutSec 5
            Write-Host "[OK] Режим Private успешно активирован! Все платы теперь подключены к прокси." -ForegroundColor Green
            Write-Host "Перезапустите диагностику, чтобы увидеть обновленный статус всех плат." -ForegroundColor Cyan
        } catch {
            Write-Host "[ОШИБКА] Не удалось переключить режим: $_" -ForegroundColor Red
        }
    }
}

Write-Host ""
Read-Host "Нажмите Enter для завершения..."
