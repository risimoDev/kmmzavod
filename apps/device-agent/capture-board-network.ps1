[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9_.:%\[\]-]+$')]
    [string]$Serial,
    [ValidateRange(15, 120)]
    [int]$Seconds = 45,
    [switch]$Trace,
    [switch]$TikTokLogin,
    [ValidatePattern('^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$')]
    [string]$TikTokPackage = 'com.zhiliaoapp.musically'
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

function Read-TikTokProcesses([string]$AppUid) {
    try {
        Read-Adb shell 'ps -A -n -o UID,PID' | ForEach-Object {
            if ($_ -match "^\s*$AppUid\s+(\d+)\s*$") { $Matches[1] }
        }
    } catch {
        Add-Report 'Не удалось прочитать список процессов TikTok.'
    }
}

function New-LoginCounter([string]$AppUid) {
    $prefix = 'KMM_AUTH_' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    foreach ($family in 'iptables', 'ip6tables') {
        $protocols = [ordered]@{
            tcp = '-p tcp'
            syn = '-p tcp --syn'
            udp443 = '-p udp --dport 443'
        }
        foreach ($key in $protocols.Keys) {
            $tag = "${prefix}_${family}_$key"
            [pscustomobject]@{
                Base = "$family -w 3 -t mangle"
                Match = "$($protocols[$key]) -m owner --uid-owner $AppUid -m comment --comment $tag"
                Prefix = $prefix
            }
        }
    }
}

function Invoke-LoginCounters([object[]]$Counters, [ValidateSet('Start','Read','Stop')][string]$Operation) {
    if (-not $Counters.Count) { return }
    $commands = switch ($Operation) {
        Start { $Counters | ForEach-Object { "$($_.Base) -I OUTPUT 1 $($_.Match)" } }
        Read {
            foreach ($group in ($Counters | Group-Object Base)) {
                "$($group.Name) -L OUTPUT -nvx | grep $($group.Group[0].Prefix) || true"
            }
        }
        Stop { $Counters | ForEach-Object { "$($_.Base) -D OUTPUT $($_.Match) 2>/dev/null" } }
    }
    $joiner = if ($Operation -eq 'Stop') { '; ' } else { ' && ' }
    $scriptText = $commands -join $joiner
    if ($Operation -eq 'Stop') { $scriptText += '; true' }
    Read-Adb shell "su -c '$scriptText'"
}

function Write-LoginLog([string[]]$Log, [string[]]$TikTokPids) {
    $header = '^\d{2}-\d{2} (?<time>\d{2}:\d{2}:\d{2}\.\d+)\s+(?<pid>\d+)\s+\d+\s+(?<level>[VDIWEFA])\s+(?<tag>[^:\s]+)\s*:\s*(?<message>.*)$'
    $signal = '(?i)\b(?:No internet connection|UnknownHostException|(?:SSL|TLS)HandshakeException|SSLPeerUnverifiedException|CertPathValidatorException|ConnectException|SocketTimeoutException|SSLProtocolException|ERR_[A-Z0-9_]+|E(?:CONNRESET|TIMEDOUT|NETUNREACH|HOSTUNREACH)|(?:http(?:[_ ]?status)?|status[_ ]?code|error[_ ]?code|net_error|err_no)["'']?\s*[:= ]\s*-?\d{1,6}(?!\d))\b'
    $count = 0
    foreach ($line in $Log) {
        $parts = [regex]::Match($line, $header)
        if (-not $parts.Success) { continue }
        $tag = $parts.Groups['tag'].Value
        $message = $parts.Groups['message'].Value
        $signals = @([regex]::Matches($message, $signal) | ForEach-Object { $_.Value } | Select-Object -Unique)
        if ($TikTokPids -notcontains $parts.Groups['pid'].Value -and $message -notmatch 'No internet connection') { continue }
        if (-not $signals.Count -and $tag -notmatch 'passport|ttnet|cronet|captcha|^AndroidRuntime$') { continue }
        Add-Report ('{0} {1} {2} {3}' -f $parts.Groups['time'].Value, $parts.Groups['level'].Value, $tag, ($signals -join ', '))
        $count++
    }
    if (-not $count) { Add-Report 'Коды ошибок авторизации в logcat не найдены.' }
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

$loginProcesses = @()
$counters = @()
if ($TikTokLogin) {
    $Trace = $true
    $loginUid = Read-Adb shell dumpsys package $TikTokPackage | ForEach-Object {
        if ($_ -match '^\s*userId=(\d+)(?:\s|$)') { $Matches[1] }
    } | Select-Object -First 1
    if (-not $loginUid) {
        throw "Не удалось определить UID пакета $TikTokPackage. Укажи установленный пакет через -TikTokPackage."
    }
    Add-Report "TikTok package=$TikTokPackage uid=$loginUid"
    Read-Host 'Open TikTok at the Send code screen. Press Enter here when ready' | Out-Null
    $loginProcesses = @(Read-TikTokProcesses $loginUid)
}
$stamp = $null
try {
    $clock = @(Read-Adb shell "date '+%m-%d %H:%M:%S'; date '+%Y-%m-%dT%H:%M:%S%z'; date +%s")
    $stamp = $clock | Where-Object { $_ -match '^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' } | Select-Object -First 1
    $androidTime = $clock | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}T' } | Select-Object -First 1
    $androidEpoch = $clock | Where-Object { $_ -match '^\d{10,}$' } | Select-Object -First 1
    $pcTime = [DateTimeOffset]::Now
    Add-Report "Начало попытки. ПК $($pcTime.ToString('o')), Android $androidTime."
    if ($androidEpoch) {
        $offset = [long]$androidEpoch - $pcTime.ToUnixTimeSeconds()
        Add-Report "Расхождение часов Android и ПК (сек) $offset."
    }
} catch {
    Add-Report $_.Exception.Message
}
if ($Trace) {
    $traceUri = 'http://127.0.0.1:8300/proxy/trace/' + [uri]::EscapeDataString($Serial)
    try {
        Invoke-RestMethod $traceUri -Method Post -Headers $AgentHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
    } catch {
        throw "Не удалось включить трассировку платы. $($_.Exception.Message)"
    }
}
try {
    if ($TikTokLogin) {
        try {
            $counters = @(New-LoginCounter $loginUid)
            Invoke-LoginCounters $counters Start | Out-Null
        } catch {
            Add-Report 'Не все счётчики исходящих пакетов TikTok удалось включить.'
        }
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
    if ($counters.Count) {
        Add-Report 'Исходящие пакеты процессов TikTok на Android'
        try {
            Invoke-LoginCounters $counters Read | ForEach-Object { Add-Report $_ }
        } catch {
            Add-Report 'Счётчики пакетов собраны не полностью.'
        }
    }
} finally {
    if ($counters.Count) {
        try { Invoke-LoginCounters $counters Stop | Out-Null }
        catch { Add-Report 'Не удалось снять временные счётчики пакетов.' }
    }
}
Add-Report "$((Get-Date).ToString('o')) $(Read-Gateway)"
if ($Trace) {
    Add-Report 'События шлюза по адресам назначения'
    try {
        $traceResult = Invoke-RestMethod $traceUri -Headers $AgentHeaders -TimeoutSec 5
        if (-not $traceResult.events) { Add-Report 'За время записи событий не зафиксировано.' }
        $traceResult.events | ForEach-Object { Add-Report ($_ | ConvertTo-Json -Compress) }
    } catch {
        Add-Report "Ошибка чтения трассировки. $($_.Exception.Message)"
    }
}
Add-Report 'Сетевые ошибки и ошибки загрузки из logcat'
$filter = 'net::ERR_|UnknownHostException|SSLHandshakeException|CertPathValidatorException|SSLPeerUnverifiedException|ConnectException|SocketTimeoutException|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOSPC|EACCES|CLEARTEXT|Network connection error|No internet connection|(?:DownloadManager|DownloadProvider|DownloadThread|Cronet|ttnet|apkpure).*(?:error|failed|timeout|status[=: ]+[45]\d{2})'
try {
    $logArgs = @('-b', 'main', '-b', 'system', '-b', 'crash', '-v', 'threadtime')
    if ($stamp) { $logArgs += '-d', '-T', "$stamp.000" }
    else { $logArgs += '-t', '800' }
    if ($TikTokLogin) {
        $loginProcesses += @(Read-TikTokProcesses $loginUid)
        Write-LoginLog -Log @(Read-Adb logcat @logArgs) -TikTokPids $loginProcesses
    } else {
        Read-Adb logcat @logArgs |
            Where-Object { $_ -match $filter } | Select-Object -Last 180 | ForEach-Object { Add-Report $_ }
    }
} catch {
    if ($TikTokLogin) { Add-Report 'Не удалось прочитать logcat для попытки авторизации.' }
    else { Add-Report $_.Exception.Message }
}
Write-Host "Отчёт сохранён в $reportPath"
