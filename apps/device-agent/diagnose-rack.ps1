<#
.SYNOPSIS
    KMMZAVOD - Полная диагностика всех плат стойки (Все уровни: USB, DNS, Root, Шлюз, Sing-box, TikTok)
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Глубокая диагностика всех плат стойки"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - ПОЛНАЯ ДИАГНОСТИКА СЕТИ ВСЕХ ПЛАТ В СТОЙКЕ        " -ForegroundColor Cyan
Write-Host "   Проверка всех уровней: USB -> DNS -> Root -> Шлюз -> TikTok " -ForegroundColor Cyan
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

# 2. Проверка запущен ли start-farm.bat / device-agent
$agentRunning = $false
$agentStatus = $null
try {
    $tcp = Get-NetTCPConnection -LocalPort 8300 -ErrorAction SilentlyContinue
    if ($tcp) {
        $agentRunning = $true
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/status" -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($resp) { $agentStatus = $resp }
        } catch {}
    }
} catch {}

if ($agentRunning) {
    Write-Host "[OK] Служба farm-agent активна (порт 8300 отвечает)." -ForegroundColor Green
    if ($agentStatus) {
        $modeDesc = if ($agentStatus.mode -eq "shared_sequential") { "Shared (Поочередный: 1 активная плата)" } else { "Private (Параллельный: все платы)" }
        $activeDev = if ($agentStatus.activeDeviceId) { $agentStatus.activeDeviceId } else { "не выбрана" }
        Write-Host "  Режим прокси стойки: $modeDesc" -ForegroundColor Cyan
        Write-Host "  Текущая активная плата с прокси: $activeDev" -ForegroundColor Cyan
        if ($agentStatus.mode -eq "shared_sequential") {
            Write-Host "  [ВАЖНО] В режиме Shared прокси работает только на ОДНОЙ активной плате ($activeDev)." -ForegroundColor Yellow
            Write-Host "  Остальные 19 плат выходят с IP фермы или заблокированы от утечек." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "[ВНИМАНИЕ] Служба farm-agent (start-farm.bat) НЕ обнаружена на порту 8300!" -ForegroundColor Yellow
    Write-Host "  Для полноценной проверки шлюза, прокси и перехвата sing-box" -ForegroundColor Yellow
    Write-Host "  рекомендуется запустить start-farm.bat в отдельном окне." -ForegroundColor Yellow
}

# 3. Проверка процесса Gnirehtet
$gnirehtetProc = Get-Process gnirehtet -ErrorAction SilentlyContinue
if ($gnirehtetProc) {
    Write-Host "[OK] Служба раздачи интернета Gnirehtet активна (PID: $($gnirehtetProc.Id))." -ForegroundColor Green
} else {
    Write-Host "[ВНИМАНИЕ] Процесс gnirehtet.exe не найден в процессах Windows!" -ForegroundColor Red
    Write-Host "  Телефоны могут не иметь выхода в интернет по USB." -ForegroundColor Red
}
Write-Host ""

# 4. Получение списка плат
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
Write-Host "Начинаем глубокую проверку каждой платы..." -ForegroundColor Cyan
Write-Host ""

$results = @()
$counter = 0

foreach ($dev in $devices) {
    $counter++
    $serial = $dev.Serial
    $model = $dev.Model

    Write-Host "================================================================" -ForegroundColor DarkCyan
    Write-Host "[$counter/$($devices.Count)] Плата: $serial ($model)" -ForegroundColor White
    Write-Host "================================================================" -ForegroundColor DarkCyan

    # [1] Информация об Android
    $androidVer = ([string](& adb -s $serial shell "getprop ro.build.version.release 2>/dev/null")).Trim()
    if (-not $androidVer) { $androidVer = "9" }
    Write-Host "  [1/9] Система: Android $androidVer, модель $model" -ForegroundColor Gray

    # Авто-подготовка curl для плат без встроенного curl (например, корейские SM-G955N)
    $hasCurl = ("$(& adb -s $serial shell '{ if command -v curl >/dev/null 2>&1 || [ -x /data/local/tmp/curl ]; then echo YES; else echo NO; fi; } 2>/dev/null')").Trim()
    if ($hasCurl -ne "YES") {
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
        if (Test-Path $tempCurl) {
            & adb -s $serial push $tempCurl /data/local/tmp/curl 2>$null | Out-Null
            & adb -s $serial shell "chmod 755 /data/local/tmp/curl" 2>$null | Out-Null
        }
    }


    # [2] Проверка интерфейса tun0 и выхода в сеть по USB (Gnirehtet)
    # Gnirehtet туннелирует TCP и UDP (не ICMP-пинг). Проверяем наличие интерфейса и TCP-доступ.
    $hasTun0 = $false
    $tunCheck = (& adb -s $serial shell "ip addr show tun0 2>/dev/null") -join " "
    if ($tunCheck -match "10\.0\.0\.2") { $hasTun0 = $true }

    $usbNetOk = $false
    $tcpCheck = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then curl -s -m 4 -o /dev/null -w '%{http_code}' http://77.88.8.8; else (printf 'HEAD / HTTP/1.0
Host: 77.88.8.8

'; sleep 1) | toybox nc 77.88.8.8 80; fi; } 2>&1") -join " "
    if ($hasTun0) {
        $usbNetOk = $true
        Write-Host "  [2/9] USB-сеть (Gnirehtet): [OK] Туннель tun0 поднят (10.0.0.2)" -ForegroundColor Green
    } else {
        Write-Host "  [2/9] USB-сеть (Gnirehtet): [ОШИБКА] Интерфейс tun0 не найден (Gnirehtet не подключен)" -ForegroundColor Red
    }

    # [3] Проверка DNS (резолвинг доменов)
    $dnsOk = $false
    $dnsCheck = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then { if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 4 -o /dev/null -w '%{http_code}' http://ya.ru; else (printf 'HEAD / HTTP/1.0
Host: ya.ru

'; sleep 1) | toybox nc ya.ru 80; fi; } 2>&1") -join " "
    if ($dnsCheck -match "(200|301|302|400|403|404|HTTP)" -or $dnsCheck -match "^[1-5]\d\d$") {
        $dnsOk = $true
        Write-Host "  [3/9] DNS-резолвер: [OK] Домен ya.ru успешно разрешен" -ForegroundColor Green
    } else {
        # Резервный тест через nslookup
        $nsCheck = (& adb -s $serial shell "nslookup ya.ru 2>/dev/null || toybox nslookup ya.ru 2>/dev/null") -join " "
        if ($nsCheck -match "Address") {
            $dnsOk = $true
            Write-Host "  [3/9] DNS-резолвер: [OK] Домен ya.ru разрешен через nslookup" -ForegroundColor Green
        } else {
            Write-Host "  [3/9] DNS-резолвер: [ОШИБКА] Домен ya.ru не разрешается" -ForegroundColor Red
        }
    }

    # [4] Проверка Root (Magisk su — без вызова adb root, чтобы не ронять adbd на Samsung)
    $rootOk = $false
    $rootCheck = (& adb -s $serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || id 2>&1 || true") -join " "
    if ($rootCheck -match "uid=0\(") {
        $rootOk = $true
        Write-Host "  [4/9] Root (Magisk): [OK] Суперпользователь АКТИВЕН (uid=0)" -ForegroundColor Green
    } else {
        $rootErr = ($rootCheck -replace "\r?\n", " ").Trim()
        Write-Host "  [4/9] Root (Magisk): [ОШИБКА] Отказ суперпользователя: $rootErr" -ForegroundColor Red
        Write-Host "        --> В Magisk на телефоне: Настройки (шестеренка) > Доступ суперпользователя > 'Приложения и ADB'" -ForegroundColor Yellow
    }

    # [5] Проверка adb reverse и шлюза агента на порту 8888
    $gatewayOk = $false
    $gwRoute = "none"
    $reverseList = (& adb -s $serial reverse --list 2>$null) -join " "
    $hasReverse = $reverseList -match "tcp:8888"

    $gwPing = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then { if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 3 http://127.0.0.1:8888/__kmm/ping; else echo NOCURL; fi; } 2>&1") -join " "
    if ($gwPing -match "KMM_GATEWAY_OK") {
        $gatewayOk = $true
        if ($gwPing -match "proxy") { $gwRoute = "proxy" }
        elseif ($gwPing -match "direct") { $gwRoute = "direct" }
        elseif ($gwPing -match "block") { $gwRoute = "block" }
        Write-Host "  [5/9] Шлюз агента (127.0.0.1:8888): [OK] Маршрут: $gwRoute (reverse: $(if ($hasReverse) {'OK'} else {'нет'}))" -ForegroundColor Green
    } else {
        Write-Host "  [5/9] Шлюз агента (127.0.0.1:8888): [ОШИБКА] Нет ответа шлюза: $gwPing (reverse: $(if ($hasReverse) {'OK'} else {'нет'}))" -ForegroundColor Red
    }

    # [6] Проверка выхода через шлюз (curl -x 127.0.0.1:8888)
    $proxyIp = "Нет ответа"
    $proxyOk = $false
    $rawProxyIp = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then { if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 7 -x http://127.0.0.1:8888 http://api.ipify.org; else (printf 'GET http://api.ipify.org/ HTTP/1.0
Host: api.ipify.org

'; sleep 3) | toybox nc 127.0.0.1 8888; fi; } 2>&1") -join " "
    if ($rawProxyIp -match "\b(?:\d{1,3}\.){3}\d{1,3}\b") {
        $proxyIp = $matches[0]
        $proxyOk = $true
        $ipNote = if ($gwRoute -eq "proxy") { "(AstroProxy)" } else { "(IP фермы: не активна в Shared)" }
        Write-Host "  [6/9] Выход через шлюз (curl -x): [OK] IP: $proxyIp $ipNote" -ForegroundColor Green
    } else {
        $proxyIp = ($rawProxyIp -replace "\r?\n", " ").Trim()
        Write-Host "  [6/9] Выход через шлюз (curl -x): [ОШИБКА] $proxyIp" -ForegroundColor Red
    }

    # [7] Проверка sing-box на плате
    $singboxOk = $false
    $sbPid = ("$(& adb -s $serial shell 'pidof sing-box 2>/dev/null')").Trim()
    $sbTcp = (& adb -s $serial shell "grep '0100007F:3039' /proc/net/tcp 2>/dev/null") -join " "
    if ($sbPid -and $sbTcp) {
        $singboxOk = $true
        Write-Host "  [7/9] Движок sing-box: [OK] Активен (PID: $sbPid, порт 12345 слушает)" -ForegroundColor Green
    } elseif ($sbPid) {
        $singboxOk = $true
        Write-Host "  [7/9] Движок sing-box: [OK] Процесс активен (PID: $sbPid)" -ForegroundColor Green
    } else {
        Write-Host "  [7/9] Движок sing-box: [ИНФО] sing-box запускается автоматически при наличии Root" -ForegroundColor Gray
    }

    # [8] Проверка iptables (прозрачный перехват TCP)
    $iptablesOk = $false
    $iptCheck = (& adb -s $serial shell "su -c 'iptables -t nat -C OUTPUT -p tcp -j KMM_PROXY 2>/dev/null && echo IPT_OK || echo IPT_FAIL' 2>/dev/null") -join " "
    if ($iptCheck -match "IPT_OK") {
        $iptablesOk = $true
        Write-Host "  [8/9] Правила iptables: [OK] Цепочка KMM_PROXY активна в OUTPUT" -ForegroundColor Green
    } else {
        Write-Host "  [8/9] Правила iptables: [ИНФО] Активируется агентом при наличии прав Root" -ForegroundColor Gray
    }

    # [9] Прозрачный выход в интернет БЕЗ -x (как ходят приложения TikTok и Chrome)
    $transIp = "Нет ответа"
    $transOk = $false
    $rawTransIp = (& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then { if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 7 http://api.ipify.org; else (printf 'GET / HTTP/1.0
Host: api.ipify.org

'; sleep 3) | toybox nc api.ipify.org 80; fi; } 2>&1") -join " "
    if ($rawTransIp -match "\b(?:\d{1,3}\.){3}\d{1,3}\b") {
        $transIp = $matches[0]
        $transOk = $true
        Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [OK] IP: $transIp" -ForegroundColor Green
    } else {
        $transIp = ($rawTransIp -replace "\r?\n", " ").Trim()
        Write-Host "  [9/9] Прозрачный выход (БЕЗ -x): [ИНФО] $transIp" -ForegroundColor Gray
    }

    # Проверка доступности серверов TikTok
    $tiktokOk = $false
    $ttPing = ([string](& adb -s $serial shell "{ if command -v curl >/dev/null 2>&1; then curl; else /data/local/tmp/curl; fi; } -s -m 6 -k -o /dev/null -w '%{http_code}' https://api.tiktokv.com/ping/ 2>&1")).Trim()
    if ($ttPing -match "^(200|403|404|301|302)$") {
        $tiktokOk = $true
        Write-Host "  [TIKTOK] Связь с серверами TikTok: [OK] HTTP $ttPing" -ForegroundColor Green
    } else {
        Write-Host "  [TIKTOK] Связь с серверами TikTok: [ОШИБКА] Код: $ttPing (TikTok не отвечает)" -ForegroundColor Red
    }

    # Итоговый вердикт по плате
    $verdict = "НЕИЗВЕСТНО"
    $verdictColor = "Red"
    if ($tiktokOk -and ($transOk -or $proxyOk)) {
        $verdict = "ГОТОВ 100% (TikTok работает)"
        $verdictColor = "Green"
    } elseif ($tiktokOk) {
        $verdict = "TikTok доступен (прокси готов)"
        $verdictColor = "Green"
    } elseif (-not $usbNetOk) {
        $verdict = "ОШИБКА: Нет USB-интернета (Gnirehtet)"
        $verdictColor = "Red"
    } elseif (-not $dnsOk) {
        $verdict = "ОШИБКА: DNS не отвечает"
        $verdictColor = "Red"
    } elseif (-not $rootOk) {
        $verdict = "Включить Root в Magisk (Apps and ADB)"
        $verdictColor = "Yellow"
    } else {
        $verdict = "ОШИБКА соединения"
        $verdictColor = "Red"
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
        Gateway = if ($gatewayOk) { $gwRoute } else { "FAIL" }
        ProxyIP = $proxyIp
        TikTok = if ($tiktokOk) { "OK" } else { "FAIL" }
        Verdict = $verdict
    }
}

Write-Host "========================================================================================================" -ForegroundColor Cyan
Write-Host "                         СВОДНАЯ ТАБЛИЦА ДИАГНОСТИКИ СТОЙКИ (ВСЕ 20 ПЛАТ)                               " -ForegroundColor Cyan
Write-Host "========================================================================================================" -ForegroundColor Cyan

$results | Format-Table -Property Num, Serial, Model, UsbNet, DNS, Root, Gateway, ProxyIP, TikTok, Verdict -AutoSize

Write-Host "========================================================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "ИНСТРУКЦИЯ ПО РЕЗУЛЬТАТАМ:" -ForegroundColor Yellow
Write-Host "1. Если 'Root = FAIL': запустите open-magisk.bat <Serial> и включите 'Приложения и ADB' в Magisk." -ForegroundColor White
Write-Host "2. Если 'Gateway = direct': плата в режиме Shared выходит с IP фермы. Нажмите 'Взять прокси' на сайте." -ForegroundColor White
Write-Host "3. Если 'TikTok = OK': плата полностью готова к публикации и прогреву аккаунтов!" -ForegroundColor White
Write-Host ""

Read-Host "Нажмите Enter для завершения..."
