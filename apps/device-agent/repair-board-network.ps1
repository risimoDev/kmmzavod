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
    Invoke-BoardAdb shell dumpsys -t 5 connectivity |
        Where-Object { $_ -match 'NetworkAgentInfo.*type: VPN\[\].*state: CONNECTED/CONNECTED.*InterfaceName: tun0\b' } |
        Select-Object -First 1
}

if ((Invoke-BoardAdb get-state) -notcontains 'device') { throw "Плата $Serial недоступна по ADB." }
$status = Invoke-RestMethod 'http://127.0.0.1:8300/proxy/status' -Headers $AgentHeaders -TimeoutSec 5
$board = $status.devices.PSObject.Properties[$Serial].Value
if (-not $board.configured -or $board.method -ne 'transparent' -or $board.route -ne 'proxy') {
    throw 'Требуется назначенный прокси и активный прозрачный режим на выбранной плате.'
}
Assert-VpsGuard
$oldVpn = Read-UsbVpn
if ($oldVpn -notmatch '\bnetwork\{(?<id>\d+)\}') { throw 'Не найден действующий USB-VPN для сравнения до и после перезапуска.' }
$oldNetworkId = $Matches['id']
$reverse = Invoke-BoardAdb reverse --list | Select-String 'localabstract:gnirehtet\s+tcp:(\d+)\s*$' | Select-Object -First 1
if (-not $reverse) { throw 'Не найден ADB reverse Gnirehtet на этой плате.' }
$relayPort = [int]$reverse.Matches[0].Groups[1].Value
$loopbackRelay = Test-NetConnection -ComputerName '127.0.0.1' -Port $relayPort -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $loopbackRelay) { throw "Локальное реле Gnirehtet на порту $relayPort недоступно." }

$restrictBefore = Invoke-BoardAdb shell cmd netpolicy get restrict-background
$blacklist = Invoke-BoardAdb shell cmd netpolicy list restrict-background-blacklist
Write-Host "[$Serial] Data Saver до восстановления. $restrictBefore"
Write-Host "[$Serial] Ограничения фонового трафика до восстановления. $blacklist"
Invoke-BoardAdb shell cmd netpolicy set restrict-background false | Out-Null
$restrictAfter = Invoke-BoardAdb shell cmd netpolicy get restrict-background
if ($restrictAfter -notmatch '\bdisabled\b') { throw "Android не подтвердил отключение Data Saver. $restrictAfter" }
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

Write-Host "[$Serial] Перезапуск USB-VPN с DNS $VpsDns..."
$previousAdb = $env:ADB
try {
    $env:ADB = $adbPath
    & $gnirehtet restart $Serial -d $VpsDns -p $relayPort
    if ($LASTEXITCODE -ne 0) { throw "Gnirehtet завершился с кодом $LASTEXITCODE." }
} finally {
    $env:ADB = $previousAdb
}

$wait = [Diagnostics.Stopwatch]::StartNew()
$newNetworkId = $null
$dnsPattern = [regex]::Escape($VpsDns)
do {
    $vpn = Read-UsbVpn
    if ($vpn -match "\bDnsAddresses: \[\s*${dnsPattern},?\s*\]" -and
        $vpn -match '\bnetwork\{(?<id>\d+)\}' -and $Matches['id'] -ne $oldNetworkId) {
        $newNetworkId = $Matches['id']
        break
    }
    Start-Sleep -Milliseconds 750
} while ($wait.Elapsed.TotalSeconds -lt 20)
if (-not $newNetworkId) { throw 'Android не подтвердил новый USB-VPN с DNS VPS. Проверь системный запрос разрешения VPN на этой плате.' }

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
