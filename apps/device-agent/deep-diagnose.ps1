<#
.SYNOPSIS
    KMMZAVOD - ГЛУБОКИЙ АНАЛИЗАТОР СЕТИ И ПРИЛОЖЕНИЙ (DEEP DIAGNOSTIC & AUTO-DOCTOR)
    Полная проверка всех 12 уровней стека фермы:
    USB -> Gnirehtet -> CaptivePortal -> SIM/MCC -> DNS -> Proxy -> 
    Reverse -> Upstream -> Root -> sing-box -> iptables -> TikTok APK
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

param(
    [string]$TargetSerial = ""
)

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Глубокий анализатор сети и приложений"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - ГЛУБОКИЙ АНАЛИЗАТОР СЕТИ, ПРОКСИ И TIKTOK (DEEP DIAGNOSTIC)       " -ForegroundColor Cyan
Write-Host "   Диагностика и авто-исправление всех 12 уровней сетевого стека стойки         " -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
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

# 2. Проверка фоновых служб Windows (Gnirehtet, device-agent)
Write-Host "--- [УРОВЕНЬ 0: ФОНОВЫЕ СЛУЖБЫ ПК ФЕРМЫ] ---" -ForegroundColor Yellow

$gnirehtetProc = Get-Process gnirehtet -ErrorAction SilentlyContinue
if ($gnirehtetProc) {
    Write-Host "  [OK] Служба раздачи интернета Gnirehtet активна (PID: $($gnirehtetProc.Id))" -ForegroundColor Green
} else {
    Write-Host "  [ВНИМАНИЕ] Процесс gnirehtet.exe не найден в системе!" -ForegroundColor Red
}

$agentRunning = $false
$agentStatus = $null
$agentUrl = "http://127.0.0.1:8300"
$candidateIps = @("127.0.0.1", "10.66.66.2", "localhost")

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

if ($agentRunning) {
    $modeDesc = if ($agentStatus.mode -eq "shared_sequential") { "Shared (поочередный: 1 плата)" } else { "Private (параллельный: ВСЕ 20 плат)" }
    Write-Host "  [OK] Служба farm-agent активна ($agentUrl отвечает, режим: $modeDesc)" -ForegroundColor Green
} else {
    Write-Host "  [ВНИМАНИЕ] Служба farm-agent (start-farm.bat) не отвечает на порту 8300" -ForegroundColor Yellow
}

# 3. Прямая проверка AstroProxy Казахстан с самого ПК
Write-Host "  [ТЕСТ ASTROPROXY С ПК] Проверка связи с казахстанским шлюзом 45.81.32.208:10018..." -ForegroundColor Yellow
$pcProxyTest = ""
try {
    $pcProxyTest = (& curl.exe --noproxy "" -s -S -m 8 -x "http://LevrurisimoiY7:3f568e6f1f3ee6b3@45.81.32.208:10018" "https://api.ipify.org" 2>&1) -join " "
} catch {}

if ($pcProxyTest -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
    Write-Host "  --> [ОТЛИЧНО] AstroProxy отвечает с ПК! Внешний IP: $pcProxyTest (Казахстан)" -ForegroundColor Green
} else {
    Write-Host "  --> [ПРЕДУПРЕЖДЕНИЕ] AstroProxy с ПК вернул: $pcProxyTest" -ForegroundColor Yellow
    Write-Host "      (Возможно временная ротация IP на стороне мобильного оператора Казахстана)" -ForegroundColor Gray
}

# 4. Определение списка проверяемых плат
Write-Host ""
$rawDevices = & adb devices -l
$devices = @()
foreach ($line in $rawDevices) {
    if ($line -match '^([^\s]+)\s+device\b') {
        $serial = $matches[1]
        $model = "Unknown"
        if ($line -match 'model:([^\s]+)') { $model = $matches[1] }
        $devices += [PSCustomObject]@{ Serial = $serial; Model = $model }
    }
}

if ($devices.Count -eq 0) {
    Write-Host "[ОШИБКА] В стойке не обнаружено ни одной подключенной платы!" -ForegroundColor Red
    Read-Host "Нажмите Enter для выхода..."
    exit 1
}

$selectedDevices = $devices
if ($TargetSerial -ne "") {
    $matched = $devices | Where-Object { $_.Serial -eq $TargetSerial }
    if ($matched) {
        $selectedDevices = @($matched)
    } else {
        Write-Host "[ПРЕДУПРЕЖДЕНИЕ] Плата $TargetSerial не найдена в стойке. Проверяем все доступные." -ForegroundColor Yellow
    }
} else {
    Write-Host "Обнаружено плат в стойке: $($devices.Count)" -ForegroundColor White
    $inputPrompt = Read-Host "Нажмите Enter для глубокой проверки ВСЕХ $($devices.Count) плат, либо введите серийник конкретной платы"
    if ($inputPrompt -and $inputPrompt.Trim() -ne "") {
        $typed = $inputPrompt.Trim()
        $matched = $devices | Where-Object { $_.Serial -match $typed }
        if ($matched) {
            $selectedDevices = @($matched)
            Write-Host "Выбрана плата: $($matched.Serial) ($($matched.Model))" -ForegroundColor Cyan
        }
    }
}

# 5. Подготовка локального бинарника curl
$tempCurl = Join-Path $env:TEMP "kmm_curl_arm64"
if (-not (Test-Path $tempCurl)) {
    try {
        $sampleDev = $devices[0].Serial
        $hasDevCurl = ("$(& adb -s $sampleDev shell 'if [ -f /system/bin/curl ]; then echo /system/bin/curl; elif [ -f /data/local/tmp/curl ]; then echo /data/local/tmp/curl; fi')").Trim()
        if ($hasDevCurl) {
            & adb -s $sampleDev pull $hasDevCurl $tempCurl 2>$null | Out-Null
        }
    } catch {}
}

# 6. Цикл глубокой диагностики плат
$allResults = @()
$idx = 0

foreach ($dev in $selectedDevices) {
    $idx++
    $s = $dev.Serial
    $m = $dev.Model
    Write-Host ""
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host "[$idx/$($selectedDevices.Count)] ГЛУБОКАЯ ДИАГНОСТИКА ПЛАТЫ: $s ($m)" -ForegroundColor Cyan
    Write-Host "================================================================================" -ForegroundColor Cyan

    # [1] Свойства системы и Android
    $androidVer = ("$(& adb -s $s shell 'getprop ro.build.version.release')").Trim()
    $cpuAbi = ("$(& adb -s $s shell 'getprop ro.product.cpu.abi')").Trim()
    $battery = ("$(& adb -s $s shell 'dumpsys battery 2>/dev/null | grep level')").Trim() -replace 'level:\s*', ''
    Write-Host "  [1/12] СИСТЕМА: Android $androidVer | CPU: $cpuAbi | Батарея: $battery%" -ForegroundColor Gray

    # Доставка curl если нужно
    $curlCmd = "curl"
    $checkCurl = ("$(& adb -s $s shell 'if [ -x /data/local/tmp/curl ]; then echo /data/local/tmp/curl; elif command -v curl >/dev/null 2>&1; then echo curl; fi')").Trim()
    if ($checkCurl -match "/data/local/tmp/curl") {
        $curlCmd = "/data/local/tmp/curl"
    } elseif ($checkCurl -eq "curl") {
        $curlCmd = "curl"
    } else {
        if (Test-Path $tempCurl) {
            & adb -s $s push $tempCurl /data/local/tmp/curl 2>$null | Out-Null
            & adb -s $s shell "chmod 755 /data/local/tmp/curl" 2>$null | Out-Null
            $curlCmd = "/data/local/tmp/curl"
            Write-Host "  --> [АВТО-ПОЧИНКА] Доставлен ARM64 curl в /data/local/tmp/curl" -ForegroundColor Yellow
        }
    }

    # [2] Gnirehtet USB-интернет и tun0
    $tun0Ok = $false
    $tun0Ip = ""
    $tunInfo = (& adb -s $s shell "ip addr show tun0 2>/dev/null") -join " "
    if ($tunInfo -match "inet\s+(\d+\.\d+\.\d+\.\d+)") {
        $tun0Ip = $matches[1]
        $tun0Ok = $true
        Write-Host "  [2/12] USB-СЕТЬ (tun0): [OK] Интерфейс активен ($tun0Ip)" -ForegroundColor Green
    } else {
        Write-Host "  [2/12] USB-СЕТЬ (tun0): [ОШИБКА] Интерфейс tun0 не поднят!" -ForegroundColor Red
        Write-Host "         Перезапуск службы Gnirehtet на плате..." -ForegroundColor Yellow
        & adb -s $s shell "am force-stop com.genymobile.gnirehtet; am start -n com.genymobile.gnirehtet/.GnirehtetActivity" 2>$null | Out-Null
        Start-Sleep -Milliseconds 1500
    }

    # [3] Captive Portal Detection (Скрытая блокировка WebView / TikTok в Android)
    $cpMode = ("$(& adb -s $s shell 'settings get global captive_portal_mode 2>/dev/null')").Trim()
    $cpEnabled = ("$(& adb -s $s shell 'settings get global captive_portal_detection_enabled 2>/dev/null')").Trim()
    
    if ($cpMode -eq "0" -and $cpEnabled -eq "0") {
        Write-Host "  [3/12] CAPTIVE PORTAL: [OK] Отключен (Android не блокирует трафик)" -ForegroundColor Green
    } else {
        Write-Host "  [3/12] CAPTIVE PORTAL: [АКТИВЕН] Android может блокировать приложения при задержке проверки!" -ForegroundColor Yellow
        Write-Host "         Отключение проверки Captive Portal..." -ForegroundColor Yellow
        & adb -s $s shell "settings put global captive_portal_mode 0; settings put global captive_portal_detection_enabled 0; settings put global captive_portal_check_interval 0; settings put global captive_portal_use_https 0" 2>$null | Out-Null
        Write-Host "         --> [ИСПРАВЛЕНО] Captive Portal отключен на плате!" -ForegroundColor Green
    }

    # [4] SIM-карта, оператор и региональная блокировка TikTok (MCC 250 РФ)
    $simState = ("$(& adb -s $s shell 'getprop gsm.sim.state 2>/dev/null')").Trim()
    $simOp = ("$(& adb -s $s shell 'getprop gsm.sim.operator.numeric 2>/dev/null')").Trim()
    $netOp = ("$(& adb -s $s shell 'getprop gsm.operator.numeric 2>/dev/null')").Trim()
    $sysCountry = ("$(& adb -s $s shell 'getprop persist.sys.country 2>/dev/null')").Trim()
    $airplane = ("$(& adb -s $s shell 'settings get global airplane_mode_on 2>/dev/null')").Trim()

    $simWarning = $false
    if ($simOp -match '^250' -or $netOp -match '^250') {
        $simWarning = $true
        Write-Host "  [4/12] SIM / РЕГИОН: [ВНИМАНИЕ] Обнаружена SIM-карта РФ (MCC: $simOp)!" -ForegroundColor Red
        Write-Host "         Официальный TikTok полностью отключает ленту при наличии российской SIM," -ForegroundColor Yellow
        Write-Host "         даже если включен прокси или VPN!" -ForegroundColor Yellow
        Write-Host "         --> Решение: включите режим 'В самолете', либо используйте TikTok Mod с выбором региона!" -ForegroundColor Cyan
    } elseif ($simState -match "READY") {
        Write-Host "  [4/12] SIM / РЕГИОН: [ИНФО] SIM активна (Оператор: $simOp, Страна: $sysCountry)" -ForegroundColor White
    } else {
        Write-Host "  [4/12] SIM / РЕГИОН: [OK] SIM-карта РФ не обнаружена (нет регионального конфликта)" -ForegroundColor Green
    }

    # [5] DNS-резолверы на плате
    $dns1 = ("$(& adb -s $s shell 'getprop net.dns1 2>/dev/null')").Trim()
    $dns2 = ("$(& adb -s $s shell 'getprop net.dns2 2>/dev/null')").Trim()
    $dnsNslookup = (& adb -s $s shell "toybox nslookup ya.ru 2>/dev/null || nslookup ya.ru 2>/dev/null") -join " "
    $dnsTtResolve = (& adb -s $s shell "toybox nslookup api.tiktokv.com 2>/dev/null || nslookup api.tiktokv.com 2>/dev/null") -join " "
    
    if ($dnsNslookup -match '\b(?:\d{1,3}\.){3}\d{1,3}\b' -or $dnsTtResolve -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        Write-Host "  [5/12] DNS-РЕЗОЛВЕР: [OK] Домены ya.ru и api.tiktokv.com разрешаются (DNS: $dns1, $dns2)" -ForegroundColor Green
    } else {
        Write-Host "  [5/12] DNS-РЕЗОЛВЕР: [ОШИБКА] DNS не разрешает домены! (net.dns1: $dns1)" -ForegroundColor Red
    }

    # [6] Системный HTTP-прокси Android (global http_proxy)
    $sysProxy = ("$(& adb -s $s shell 'settings get global http_proxy 2>/dev/null')").Trim()
    if ($sysProxy -match "127\.0\.0\.1:8888") {
        Write-Host "  [6/12] СИСТЕМНЫЙ ПРОКСИ: [OK] Установлен (127.0.0.1:8888)" -ForegroundColor Green
    } else {
        Write-Host "  [6/12] СИСТЕМНЫЙ ПРОКСИ: [ИНФО] Значение: '$sysProxy'" -ForegroundColor Yellow
        & adb -s $s shell "settings put global http_proxy 127.0.0.1:8888; settings put global global_http_proxy_host 127.0.0.1; settings put global global_http_proxy_port 8888" 2>$null | Out-Null
        Write-Host "         --> [ИСПРАВЛЕНО] Выставлен системный прокси 127.0.0.1:8888" -ForegroundColor Green
    }

    # [7] adb reverse и связь со шлюзом ПК (127.0.0.1:8888)
    $revList = (& adb -s $s reverse --list 2>$null) -join " "
    $gwPing = ("$(& adb -s $s shell "$curlCmd -s -m 4 http://127.0.0.1:8888/__kmm/ping 2>&1")").Trim()
    
    if ($gwPing -match "KMM_GATEWAY_OK") {
        Write-Host "  [7/12] ШЛЮЗ АГЕНТА: [OK] 127.0.0.1:8888 отвечает (KMM_GATEWAY_OK)" -ForegroundColor Green
    } else {
        Write-Host "  [7/12] ШЛЮЗ АГЕНТА: [ОШИБКА] Шлюз не ответил: '$gwPing'" -ForegroundColor Red
        Write-Host "         Восстановление adb reverse..." -ForegroundColor Yellow
        & adb -s $s reverse tcp:8888 tcp:8888 2>$null | Out-Null
        try {
            Invoke-RestMethod -Uri "$agentUrl/proxy/reapply" -Method Post -TimeoutSec 3 -ErrorAction SilentlyContinue | Out-Null
        } catch {}
    }

    # [8] Права Root (Magisk su)
    $rootOut = (& adb -s $s shell "su -c 'id' 2>&1 || su 0 id 2>&1 || id 2>&1 || true") -join " "
    $rootOk = $false
    if ($rootOut -match "uid=0\(") {
        $rootOk = $true
        $selinux = ("$(& adb -s $s shell 'su -c getenforce 2>/dev/null || getenforce 2>/dev/null')").Trim()
        Write-Host "  [8/12] ROOT (Magisk): [OK] Суперпользователь АКТИВЕН (uid=0, SELinux: $selinux)" -ForegroundColor Green
    } else {
        Write-Host "  [8/12] ROOT (Magisk): [ОШИБКА] Нет прав Root для Shell! ($rootOut)" -ForegroundColor Red
    }

    # [9] Движок sing-box и анализ логов
    $sbPid = ("$(& adb -s $s shell 'pidof sing-box 2>/dev/null')").Trim()
    $sbListen = (& adb -s $s shell "cat /proc/net/tcp 2>/dev/null | grep -i '0100007F:3039'") -join " "
    $sbLog = (& adb -s $s shell "tail -n 8 /data/local/tmp/kmm-singbox.log 2>/dev/null") -join "`n"

    if ($sbPid -and $sbListen) {
        Write-Host "  [9/12] ДВИЖОК SING-BOX: [OK] Активен (PID: $sbPid, порт 12345 слушает)" -ForegroundColor Green
    } else {
        Write-Host "  [9/12] ДВИЖОК SING-BOX: [ОШИБКА] sing-box не активен (PID: '$sbPid')" -ForegroundColor Red
        if ($rootOk) {
            Write-Host "         Перезапуск sing-box через скрипт kmm-proxy.sh..." -ForegroundColor Yellow
            & adb -s $s shell "su -c '/data/local/tmp/kmm-proxy.sh start' 2>&1" 2>$null | Out-Null
            Start-Sleep -Milliseconds 1000
        }
    }
    if ($sbLog -and $sbLog.Trim() -ne "") {
        Write-Host "         --- Последние записи лога sing-box ---" -ForegroundColor Gray
        foreach ($l in ($sbLog -split "`n")) {
            if ($l.Trim()) { Write-Host "           | $l" -ForegroundColor Gray }
        }
    }

    # [10] Таблица iptables и счетчики перехваченного трафика
    $iptablesRules = (& adb -s $s shell "su -c 'iptables -w 3 -t nat -L KMM_PROXY -v -n 2>/dev/null'") -join "`n"
    if ($iptablesRules -match "REDIRECT\s+tcp\s+--\s+.*\s+redir ports 12345") {
        Write-Host "  [10/12] IPTABLES ПЕРЕХВАТ: [OK] Цепочка KMM_PROXY активна в nat OUTPUT" -ForegroundColor Green
        # Выделяем строку со счетчиками пакетов
        foreach ($rLine in ($iptablesRules -split "`n")) {
            if ($rLine -match "redir ports 12345") {
                Write-Host "          Счетчик трафика: $($rLine.Trim())" -ForegroundColor Cyan
            }
        }
    } else {
        Write-Host "  [10/12] IPTABLES ПЕРЕХВАТ: [ОШИБКА] Правила REDIRECT не найдены!" -ForegroundColor Red
    }

    # [11] Сквозные тесты соединений с платы (curl)
    Write-Host "  [11/12] СКВОЗНЫЕ ТЕСТЫ ВЫХОДА В СЕТЬ:" -ForegroundColor Yellow

    # Тест A: Явный HTTP прокси (-x)
    $ipExplHttp = ("$(& adb -s $s shell "$curlCmd -s -S -m 12 -x http://127.0.0.1:8888 http://api.ipify.org 2>&1")").Trim()
    if ($ipExplHttp -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        Write-Host "    [A] Явный HTTP (-x 127.0.0.1:8888): [OK] IP: $ipExplHttp" -ForegroundColor Green
    } else {
        Write-Host "    [A] Явный HTTP (-x 127.0.0.1:8888): [ОШИБКА] $ipExplHttp" -ForegroundColor Red
    }

    # Тест B: Явный HTTPS CONNECT прокси (-x)
    $ipExplHttps = ("$(& adb -s $s shell "$curlCmd -s -S -m 12 -x http://127.0.0.1:8888 https://api.ipify.org 2>&1")").Trim()
    if ($ipExplHttps -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        Write-Host "    [B] Явный HTTPS CONNECT (-x):       [OK] IP: $ipExplHttps" -ForegroundColor Green
    } else {
        Write-Host "    [B] Явный HTTPS CONNECT (-x):       [ОШИБКА] $ipExplHttps" -ForegroundColor Red
    }

    # Тест C: Прозрачный HTTP без -x (как ходят приложения)
    $ipTransHttp = ("$(& adb -s $s shell "$curlCmd -s -S -m 12 http://api.ipify.org 2>&1")").Trim()
    if ($ipTransHttp -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        Write-Host "    [C] Прозрачный HTTP (БЕЗ -x):        [OK] IP: $ipTransHttp" -ForegroundColor Green
    } else {
        Write-Host "    [C] Прозрачный HTTP (БЕЗ -x):        [ОШИБКА] $ipTransHttp" -ForegroundColor Red
    }

    # Тест D: Прозрачный HTTPS без -x (как ходит TikTok и Chrome)
    $ipTransHttps = ("$(& adb -s $s shell "$curlCmd -s -S -m 12 https://api.ipify.org 2>&1")").Trim()
    if ($ipTransHttps -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        Write-Host "    [D] Прозрачный HTTPS (БЕЗ -x):       [OK] IP: $ipTransHttps" -ForegroundColor Green
    } else {
        Write-Host "    [D] Прозрачный HTTPS (БЕЗ -x):       [ОШИБКА] $ipTransHttps" -ForegroundColor Red
    }

    # Тест E: Серверы TikTok API
    $ttCode = ("$(& adb -s $s shell "$curlCmd -s -S -m 15 -k -o /dev/null -w '%{http_code}' https://api.tiktokv.com/ping/ 2>&1")").Trim()
    if ($ttCode -match "(200|403|404|301|302)") {
        Write-Host "    [E] Серверы TikTok (api.tiktokv.com):[OK] HTTP $ttCode" -ForegroundColor Green
    } else {
        Write-Host "    [E] Серверы TikTok (api.tiktokv.com):[ОШИБКА] Код: '$ttCode'" -ForegroundColor Red
    }

    # [12] Состояние приложения TikTok (APK, кэш, версия)
    $ttPkg = ("$(& adb -s $s shell 'pm list packages 2>/dev/null | grep -E \"musically|trill\"')").Trim() -replace 'package:', ''
    if ($ttPkg) {
        $ttVer = ("$(& adb -s $s shell "dumpsys package $ttPkg 2>/dev/null | grep versionName")").Trim() -replace 'versionName=', ''
        Write-Host "  [12/12] TIKTOK ПРИЛОЖЕНИЕ: Установлен пакет $ttPkg (v$ttVer)" -ForegroundColor White
        # Сброс зависших сессий
        & adb -s $s shell "am force-stop $ttPkg" 2>$null | Out-Null
    } else {
        Write-Host "  [12/12] TIKTOK ПРИЛОЖЕНИЕ: [ВНИМАНИЕ] Пакет TikTok не установлен на этой плате!" -ForegroundColor Yellow
    }

    # Формирование вердикта для платы
    $verdict = "ГОТОВ 100%"
    if ($simWarning) {
        $verdict = "БЛОКИРОВКА SIM РФ (Включите Самолет)"
    } elseif (-not $tun0Ok) {
        $verdict = "НЕТ USB СЕТИ (Gnirehtet)"
    } elseif (-not $rootOk) {
        $verdict = "НЕТ ROOT (Magisk Shell)"
    } elseif ($ipTransHttps -notmatch '\b(?:\d{1,3}\.){3}\d{1,3}\b') {
        $verdict = "ОШИБКА ТРАНСПОРТА HTTPS"
    } elseif ($ttCode -notmatch "(200|403|404|301|302)") {
        $verdict = "TIKTOK НЕ ОТВЕЧАЕТ"
    }

    $allResults += [PSCustomObject]@{
        Num = $idx
        Serial = $s
        Model = $m
        Tun0 = if ($tun0Ok) { "OK" } else { "FAIL" }
        Root = if ($rootOk) { "OK" } else { "FAIL" }
        ExitIP = if ($ipTransHttps -match '\b(?:\d{1,3}\.){3}\d{1,3}\b') { $ipTransHttps } else { "FAIL" }
        TikTok = $ttCode
        Verdict = $verdict
    }
}

# 7. Итоговая сводная таблица
Write-Host ""
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "ИТОГОВЫЙ ОТЧЕТ ГЛУБОКОГО АНАЛИЗА ВСЕХ ПЛАТ:" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan

$allResults | Format-Table -Property Num, Serial, Model, Tun0, Root, ExitIP, TikTok, Verdict -AutoSize

Write-Host "--------------------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "РЕЗЮМЕ И ПРАКТИЧЕСКИЕ РЕШЕНИЯ:" -ForegroundColor Yellow

$simIssues = $allResults | Where-Object { $_.Verdict -match "БЛОКИРОВКА SIM" }
if ($simIssues.Count -gt 0) {
    Write-Host "[!] ПРИЧИНА 'Нет подключения к интернету' В TIKTOK:" -ForegroundColor Red
    Write-Host "    На платах обнаружена активная российская SIM-карта (MCC 250)." -ForegroundColor White
    Write-Host "    Официальный клиент TikTok блокирует показ ленты при считывании кода +7/РФ." -ForegroundColor White
    Write-Host "    ЧТО ДЕЛАТЬ:" -ForegroundColor Yellow
    Write-Host "    1) Включите режим 'В самолете' (Airplane Mode) в шторке Android (сеть идет через USB Gnirehtet)." -ForegroundColor Green
    Write-Host "    2) Либо очистите кэш и данные приложения: adb shell pm clear com.zhiliaoapp.musically" -ForegroundColor Green
    Write-Host "    3) Либо используйте TikTok Mod с плагином переключения региона." -ForegroundColor Green
    Write-Host ""
}

Write-Host ""
Read-Host "Нажмите Enter для выхода..."
