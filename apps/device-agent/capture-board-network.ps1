[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9_.:%\[\]-]+$')]
    [string]$Serial,
    [ValidateRange(15, 120)]
    [int]$Seconds = 45
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-auth.ps1')
$adbPath = Join-Path $PSScriptRoot 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adbPath -PathType Leaf)) {
    $adbPath = (Get-Command adb.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $adbPath) { throw 'ADB не найден.' }
}
$reportPath = Join-Path $env:TEMP ('kmm-network-{0}-{1}.txt' -f ($Serial -replace '[^\w.-]', '_'), (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))

function Add-Report([string]$Line) {
    $safe = [regex]::Replace($Line, '(?i)https?://[^\s"<>]+', {
        param($match)
        $uri = $null
        if ([uri]::TryCreate($match.Value, [UriKind]::Absolute, [ref]$uri)) { return $uri.DnsSafeHost }
        return '[URL]'
    })
    $safe = $safe -replace '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[EMAIL]'
    $safe = $safe -replace '(?i)\b(?:authorization|cookie|password|access_token|refresh_token|verification.?code|otp)\b\s*["'']?\s*[:=].*$', '[REDACTED]'
    Add-Content -LiteralPath $reportPath -Value $safe -Encoding UTF8
}

function Read-Adb {
    $ErrorActionPreference = 'Continue'
    $output = @(& $adbPath -s $Serial @args 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "Ошибка ADB. $($output -join ' ')" }
    $output
}

function Read-Gateway {
    try {
        $status = Invoke-RestMethod 'http://127.0.0.1:8300/proxy/status' -Headers $AgentHeaders -TimeoutSec 2
        $board = $status.devices.PSObject.Properties[$Serial].Value
        if (-not $board) { return 'У агента нет статуса этой платы.' }
        $gw = $board.gateway
        return ('mode={0} route={1} method={2} protocol={3} saver={4} standby={5} connections={6} failed={7} bytesUp={8} bytesDown={9} lastActivity={10} lastErrorAt={11} code={12} error={13} applyError={14} transparentError={15}' -f
            $status.mode, $board.route, $board.method, $board.protocol, $status.trafficSaver, $status.trafficStandby,
            $gw.totalConnections, $gw.failedConnections, $gw.bytesUp, $gw.bytesDown, $gw.lastActivityAt,
            $gw.lastErrorAt, $gw.lastErrorCode, $gw.lastError, $board.applyError, $board.transparentError)
    } catch {
        return "Ошибка чтения статуса агента. $($_.Exception.Message)"
    }
}

if ((Read-Adb get-state) -notcontains 'device') { throw "Плата $Serial недоступна по ADB." }
Add-Report "Плата $Serial. Время ПК $((Get-Date).ToString('o'))"
Add-Report 'Android, модель, место на диске, настройки DNS и системного прокси'
try {
    Read-Adb shell 'getprop ro.build.version.release; getprop ro.product.model; df -h /data /sdcard; echo PrivateDNS; settings get global private_dns_mode; settings get global private_dns_specifier; echo HTTPProxy; settings get global http_proxy' |
        ForEach-Object { Add-Report $_ }
} catch {
    Add-Report $_.Exception.Message
}
Add-Report 'Сетевые интерфейсы и состояние Android'
try {
    Read-Adb shell dumpsys -t 5 connectivity |
        Where-Object { $_ -match 'Active default network|NetworkAgentInfo|InterfaceName:\s*tun|VALIDATED|CAPTIVE_PORTAL|PARTIAL_CONNECTIVITY' } |
        Select-Object -First 30 | ForEach-Object { Add-Report $_ }
} catch {
    Add-Report $_.Exception.Message
}
Add-Report 'Начальное состояние шлюза'
Add-Report (Read-Gateway)

$stamp = $null
try {
    $stamp = Read-Adb shell "date '+%m-%d %H:%M:%S'" |
        Where-Object { $_ -match '^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' } | Select-Object -First 1
} catch {
    Add-Report $_.Exception.Message
}
Write-Host "Сбор запущен на $Seconds сек. Сейчас воспроизведите одну ошибку на плате $Serial."
$timer = [Diagnostics.Stopwatch]::StartNew()
$last = $null
while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
    $current = Read-Gateway
    if ($current -ne $last) {
        Add-Report "$((Get-Date).ToString('o')) $current"
        $last = $current
    }
    Start-Sleep -Seconds 1
}
Add-Report "$((Get-Date).ToString('o')) $(Read-Gateway)"
Add-Report 'Сетевые ошибки и ошибки загрузки из logcat'
$filter = 'net::ERR_|UnknownHostException|SSLHandshakeException|CertPathValidatorException|SSLPeerUnverifiedException|ConnectException|SocketTimeoutException|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOSPC|EACCES|CLEARTEXT|Network connection error|No internet connection|(?:DownloadManager|DownloadProvider|DownloadThread|Cronet|ttnet|apkpure).*(?:error|failed|timeout|status[=: ]+[45]\d{2})'
try {
    $logArgs = @('-b', 'main', '-b', 'system', '-b', 'crash', '-v', 'threadtime')
    if ($stamp) { $logArgs += '-d', '-T', "$stamp.000" }
    else { $logArgs += '-t', '800' }
    Read-Adb logcat @logArgs |
        Where-Object { $_ -match $filter } | Select-Object -Last 180 | ForEach-Object { Add-Report $_ }
} catch {
    Add-Report $_.Exception.Message
}
Write-Host "Отчёт сохранён в $reportPath"
