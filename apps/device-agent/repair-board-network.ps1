[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9_.:%\[\]-]+$')]
    [string]$Serial,
    [ValidatePattern('^\d{1,3}(?:\.\d{1,3}){3}$')]
    [string]$VpsDns = '10.66.66.1'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-auth.ps1')
$toolsDir = Join-Path $PSScriptRoot 'platform-tools'
$adbPath = Join-Path $toolsDir 'adb.exe'
$gnirehtet = Join-Path $toolsDir 'gnirehtet.exe'
if (-not (Test-Path -LiteralPath $gnirehtet -PathType Leaf)) {
    $gnirehtet = Join-Path $PSScriptRoot '..\..\platform-tools\gnirehtet.exe'
}
if (-not (Test-Path -LiteralPath $adbPath -PathType Leaf)) { throw 'Локальный adb.exe не найден.' }
if (-not (Test-Path -LiteralPath $gnirehtet -PathType Leaf)) { throw 'gnirehtet.exe не найден.' }
$dns = $null
if (-not [ipaddress]::TryParse($VpsDns, [ref]$dns) -or $dns.ToString() -ne $VpsDns) {
    throw 'Укажи действующий IPv4-адрес DNS главного VPS внутри туннеля.'
}

function Invoke-BoardAdb {
    $output = & $adbPath -s $Serial @args
    if ($LASTEXITCODE -ne 0) { throw "ADB вернул код $LASTEXITCODE на плате $Serial. $($output -join ' ')" }
    $output
}

function Invoke-Agent([string]$Path) {
    Invoke-RestMethod "http://127.0.0.1:8300$Path" -Method Post -Headers $AgentHeaders `
        -ContentType 'application/json' -Body (@{ deviceId = $Serial } | ConvertTo-Json -Compress) -TimeoutSec 120
}

function Assert-VpsGuard {
    $state = Invoke-BoardAdb shell "su -c 'sh /data/local/tmp/kmm-proxy.sh status && iptables -w 3 -t nat -S KMM_DNS'"
    $dnsPattern = [regex]::Escape($VpsDns)
    if ($state -notcontains 'KMM_RUNNING' -or @($state -match "DNAT --to-destination ${dnsPattern}:53$").Count -ne 2) {
        throw 'Защита прямого выхода или правила DNS через VPS не подтверждены.'
    }
}

function Read-UsbVpn {
    $row = Invoke-BoardAdb shell dumpsys -t 5 connectivity |
        Where-Object { $_ -match 'NetworkAgentInfo.*type: VPN\[\].*state: CONNECTED/CONNECTED.*InterfaceName: tun\d+\b' } |
        Select-Object -First 1
    if ($row -match '\bnetwork\{(?<id>\d+)\}.*\bInterfaceName: (?<link>tun\d+)\b.*\bDnsAddresses: \[(?<dns>[^\]]*)\]') {
        [pscustomobject]@{
            Id = $Matches['id']
            Interface = $Matches['link']
            Dns = @($Matches['dns'] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
    }
}

function Wait-UsbVpn([scriptblock]$Ready, [int]$Seconds) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        $vpn = Read-UsbVpn
        if (& $Ready $vpn) { return @{ Ready = $true; Vpn = $vpn } }
        Start-Sleep -Milliseconds 750
    } while ($clock.Elapsed.TotalSeconds -lt $Seconds)
    return @{ Ready = $false; Vpn = $vpn }
}

if ((Invoke-BoardAdb get-state) -notcontains 'device') { throw "Плата $Serial недоступна по ADB." }
$status = Invoke-RestMethod 'http://127.0.0.1:8300/proxy/status' -Headers $AgentHeaders -TimeoutSec 5
$board = $status.devices.PSObject.Properties[$Serial].Value
if (-not $board.configured -or $board.method -ne 'transparent' -or $board.route -ne 'proxy') {
    throw 'Требуется назначенный прокси и активный прозрачный режим на выбранной плате.'
}
Assert-VpsGuard
$oldVpn = Read-UsbVpn
$oldNetworkId = if ($oldVpn) { $oldVpn.Id } else { 'отключён' }
$reverse = Invoke-BoardAdb reverse --list | Select-String 'localabstract:gnirehtet\s+tcp:(\d+)\s*$' | Select-Object -First 1
$relayPort = if ($reverse) { [int]$reverse.Matches[0].Groups[1].Value } else { 31416 }
$loopbackRelay = Test-NetConnection -ComputerName '127.0.0.1' -Port $relayPort -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $loopbackRelay) { throw "Локальное реле Gnirehtet на порту $relayPort недоступно." }

$restrictBefore = Invoke-BoardAdb shell cmd netpolicy get restrict-background
$blacklist = Invoke-BoardAdb shell cmd netpolicy list restrict-background-blacklist
Write-Host "[$Serial] Data Saver до восстановления. $restrictBefore"
Write-Host "[$Serial] Ограничения фонового трафика до восстановления. $blacklist"
if ($restrictBefore -notmatch '\bdisabled\b') {
    Invoke-BoardAdb shell cmd netpolicy set restrict-background false | Out-Null
    $restrictAfter = Invoke-BoardAdb shell cmd netpolicy get restrict-background
    if ($restrictAfter -notmatch '\bdisabled\b') { throw "Android не подтвердил отключение Data Saver. $restrictAfter" }
}
$installed = @(Invoke-BoardAdb shell pm list packages)
$removedUids = @(
    foreach ($package in 'com.zhiliaoapp.musically', 'com.zhiliaoapp.musically.go', 'com.ss.android.ugc.tiktok.lite', 'com.tiktok.lite.go') {
        if ($installed -notcontains "package:$package") { continue }
        $row = Invoke-BoardAdb shell dumpsys package $package | Select-String '^\s*userId=(\d+)(?:\s|$)' | Select-Object -First 1
        if (-not $row) { continue }
        $appUid = $row.Matches[0].Groups[1].Value
        if ($blacklist -match "(?<!\d)$appUid(?!\d)") {
            Invoke-BoardAdb shell cmd netpolicy remove restrict-background-blacklist $appUid | Out-Null
            $appUid
        }
    }
)
if ($removedUids.Count) { Write-Host "[$Serial] Снято ограничение для UID TikTok. $($removedUids -join ', ')" }

$previousAdb = $env:ADB
try {
    $env:ADB = $adbPath
    if ($oldVpn) {
        Write-Host "[$Serial] Останавливаю USB-VPN $($oldVpn.Interface) ($oldNetworkId)..."
        & $gnirehtet stop $Serial
        if ($LASTEXITCODE -ne 0) { throw "Gnirehtet stop завершился с кодом $LASTEXITCODE." }
        $stopped = Wait-UsbVpn { param($state) -not $state } 8
        if (-not $stopped.Ready) {
            Invoke-BoardAdb shell am force-stop com.genymobile.gnirehtet | Out-Null
            $stopped = Wait-UsbVpn { param($state) -not $state } 8
            if (-not $stopped.Ready) { throw 'Android продолжает показывать старый USB-VPN после остановки Gnirehtet.' }
        }
    }
    Write-Host "[$Serial] Запускаю USB-VPN с DNS $VpsDns..."
    & $gnirehtet start $Serial -d $VpsDns -p $relayPort
    if ($LASTEXITCODE -ne 0) { throw "Gnirehtet завершился с кодом $LASTEXITCODE." }
} finally {
    $env:ADB = $previousAdb
}

$started = Wait-UsbVpn { param($state) $state -and $state.Dns.Count -eq 1 -and $state.Dns[0] -eq $VpsDns } 20
if (-not $started.Ready) {
    if ($started.Vpn) {
        throw "USB-VPN $($started.Vpn.Interface) поднялся с DNS $($started.Vpn.Dns -join ', '), ожидался $VpsDns."
    }
    Invoke-BoardAdb logcat -d -t 200 -s GnirehtetActivity GnirehtetService | Write-Host
    throw 'Android не поднял USB-VPN. Если на плате открыт запрос разрешения VPN, подтверди его.'
}
$newNetworkId = $started.Vpn.Id

$applied = Invoke-Agent '/proxy/apply-device'
if (-not $applied.ok -or $applied.status.method -ne 'transparent' -or $applied.status.route -ne 'proxy') {
    throw 'Агент не подтвердил прозрачный маршрут через назначенный прокси.'
}
Assert-VpsGuard
$check = Invoke-Agent '/proxy/check'
if (-not $check.ok -or -not $check.ip -or -not $check.hostIp -or $check.leakDetected -or
    $check.exposesHostIp -or $check.route -ne 'proxy' -or $check.method -ne 'transparent') {
    throw "Проверка интернета с платы через прокси не прошла. $($check.error)"
}
Write-Host "[$Serial] USB-VPN $oldNetworkId -> $newNetworkId. DNS VPS и выход через назначенный прокси подтверждены."
