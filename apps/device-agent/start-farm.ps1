<#
.SYNOPSIS
    KMMZAVOD - Запуск агента стойки телефонной фермы (Native ADB Device-Agent)
.DESCRIPTION
    Скрипт проверяет окружение и ADB, опрашивает подключенные платы
    и запускает bridge-сервер между фермой и оркестратором платформы.
#>

[CmdletBinding()]
param([switch]$Stop)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Phone Farm Bridge (ADB Controller)"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - АГЕНТ СТОЙКИ ТЕЛЕФОННОЙ ФЕРМЫ (NATIVE ADB)        " -ForegroundColor Cyan
Write-Host "   Бесплатный открытый контроллер (без стороннего ПО и подписок)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

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

function Initialize-FarmRoute {
    $relayUrl = Get-AgentSetting 'DEVICE_AGENT_UPSTREAM_VIA'
    $allowDirect = (Get-AgentSetting 'DEVICE_AGENT_ALLOW_DIRECT') -eq '1'
    if (-not $relayUrl -and $allowDirect) { return }
    if ((Get-AgentSetting 'DEVICE_AGENT_PROXY_ROOT_MODE') -eq 'off') {
        throw 'Маршрут через VPS требует прозрачного режима. Проверьте DEVICE_AGENT_PROXY_ROOT_MODE.'
    }
    if (-not (Get-AgentSetting 'DEVICE_AGENT_TOKEN')) {
        throw 'В .env агента не задан DEVICE_AGENT_TOKEN, необходимый для подключения с VPS.'
    }
    $privateIp = '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9.]+$'
    if ($relayUrl) {
        if ($relayUrl -notmatch '^\w+://') { $relayUrl = "http://$relayUrl" }
        $configured = $null
        if (-not [Uri]::TryCreate($relayUrl, [UriKind]::Absolute, [ref]$configured) -or
            $configured.Scheme -ne 'http' -or $configured.UserInfo -or $configured.Host -notmatch $privateIp) {
            throw 'Укажите HTTP-адрес реле VPS внутри туннеля без реквизитов.'
        }
        if ($relayUrl.TrimEnd('/') -notmatch ':\d+$' -and $configured.IsDefaultPort) {
            $relayUrl = 'http://{0}:3129' -f $configured.Host
        }
        $candidates = @($relayUrl.TrimEnd('/'))
    } else {
        $candidates = @('http://10.66.66.1:3129', 'http://10.13.13.1:3129', 'http://10.8.0.1:3129')
    }
    $configuredDns = Get-AgentSetting 'DEVICE_AGENT_DNS_VIA'
    if ($configuredDns) {
        $parsedDns = $null
        if ($configuredDns -notmatch $privateIp -or -not [ipaddress]::TryParse($configuredDns, [ref]$parsedDns) -or
            $parsedDns.ToString() -ne $configuredDns) { throw 'DEVICE_AGENT_DNS_VIA должен указывать на IPv4 DNS внутри туннеля.' }
    }
    Write-Host 'Ожидание реле и DNS главного VPS...' -ForegroundColor Yellow
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $problem = 'Реле VPS недоступно. Проверьте подключение AmneziaWG.'
    do {
        foreach ($candidate in $candidates) {
            & curl.exe -fs --noproxy '*' -m 2 -o NUL "$candidate/health" 2>$null
            if ($LASTEXITCODE -ne 0) { continue }
            $vps = ([uri]$candidate).Host
            $route = Find-NetRoute -RemoteIPAddress $vps -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress -match $privateIp } | Select-Object -First 1
            if (-not $route) { $problem = "Не найден IPv4 интерфейса к реле $vps."; continue }
            $dnsIp = if ($configuredDns) { $configuredDns } else { $vps }
            if (-not (Resolve-DnsName -Name 'api.ipify.org' -Server $dnsIp -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress })) {
                $problem = "DNS через VPS ($dnsIp) не отвечает. Проверьте farm-dns и порт 53 внутри туннеля."
                continue
            }
            $explicitHost = Get-AgentSetting 'DEVICE_AGENT_HOST'
            if ($explicitHost -and $explicitHost -ne $route.IPAddress) {
                Write-Warning "DEVICE_AGENT_HOST=$explicitHost. Для этого запуска использую адрес маршрута к VPS $($route.IPAddress)."
            }
            $env:DEVICE_AGENT_UPSTREAM_VIA = $candidate
            $env:DEVICE_AGENT_DNS_VIA = $dnsIp
            $env:DEVICE_AGENT_HOST = $route.IPAddress
            Write-Host "[OK] Реле и DNS главного VPS доступны. Адрес агента $($route.IPAddress) ($($route.InterfaceAlias))." -ForegroundColor Green
            return [pscustomobject]@{ Host = $route.IPAddress; Vps = $vps; Dns = $dnsIp }
        }
        Start-Sleep -Seconds 1
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    throw $problem
}

# 3. Подготовка ADB до замены работающего агента
function Get-FarmPortListeners([int]$Port) {
    foreach ($line in (netstat -ano 2>$null)) {
        if ($line -match "^\s*TCP\s+(\S+):$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            [PSCustomObject]@{ Address = $matches[1]; ProcessId = [int]$matches[2] }
        }
    }
}

function Get-LocalAdbServer {
    if ($env:ADB_SERVER_SOCKET -or $env:ANDROID_ADB_SERVER_ADDRESS -or $env:ANDROID_ADB_SERVER_PORT) { return }
    $listener = Get-FarmPortListeners 5037 |
        Where-Object { $_.Address -in @('127.0.0.1', '0.0.0.0', '[::1]', '[::]') } |
        Select-Object -First 1
    if ($listener) { Get-Process -Id $listener.ProcessId -ErrorAction SilentlyContinue }
}

function Stop-FarmProcess([System.Diagnostics.Process]$Process) {
    if ($Process.HasExited) { return }
    try { Stop-Process -InputObject $Process -Force -ErrorAction Stop } catch {
        if (-not $Process.HasExited) { throw }
    }
    if (-not $Process.WaitForExit(5000)) {
        throw "Процесс PID $($Process.Id) не завершился за 5 сек."
    }
}

function Invoke-FarmAdb([string]$Arguments, [int]$TimeoutMs) {
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = $adbBin
    $process.StartInfo.Arguments = $Arguments
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            try { $process.Kill() } catch [System.InvalidOperationException] {}
            throw [System.TimeoutException]::new("Команда ADB ($Arguments) не завершилась за $($TimeoutMs / 1000) сек.")
        }
        # A daemon may keep a redirected handle open after the client has exited.
        $remainingMs = [Math]::Max(0, $TimeoutMs - [int]$timer.ElapsedMilliseconds)
        if (-not [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($stdout, $stderr), $remainingMs)) {
            $error = [System.TimeoutException]::new("ADB ($Arguments) завершилась, но поток вывода остался открытым.")
            $error.Data['ClientExited'] = $true
            throw $error
        }
        if ($process.ExitCode -ne 0) {
            $detail = $stderr.Result.Trim()
            if (-not $detail) { $detail = $stdout.Result.Trim() }
            throw "ADB ($Arguments) вернула код $($process.ExitCode). $detail"
        }
        return $stdout.Result -split '\r?\n'
    } finally {
        $process.Dispose()
    }
}

function Request-FarmStop {
    try {
        $running = [Threading.EventWaitHandle]::OpenExisting($stopEventName)
    } catch [Threading.WaitHandleCannotBeOpenedException] { return }
    try { [void]$running.Set() } finally { $running.Dispose() }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 250
        try { $running = [Threading.EventWaitHandle]::OpenExisting($stopEventName) }
        catch [Threading.WaitHandleCannotBeOpenedException] { return }
        $running.Dispose()
    } while ($timer.Elapsed.TotalSeconds -lt 5)
}

function Get-AgentHealth([string]$Address, [int]$Timeout = 2) {
    if ($Address -eq '0.0.0.0') { $Address = '127.0.0.1' }
    if ($Address -eq '[::]' -or $Address -eq '::') { $Address = '[::1]' }
    if ($Address.Contains(':') -and -not $Address.StartsWith('[')) { $Address = "[$Address]" }
    $body = & curl.exe -fs --noproxy '*' -m $Timeout "http://$($Address):$agentPort/health" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $body) { return $false }
    try { $health = $body | ConvertFrom-Json -ErrorAction Stop }
    catch { return $false }
    return $health.ok -eq $true -and $health.driver -eq 'Native ADB Controller (Open-Source, 0$)'
}

function Get-LiveFarmProcess($Record) {
    $process = Get-Process -Id $Record.ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -ne [IO.Path]::GetFileNameWithoutExtension($Record.Name)) { return }
    if ($Record.CreationDate -and [Math]::Abs(($process.StartTime - $Record.CreationDate).TotalSeconds) -gt 1) { return }
    $process
}

function Get-FarmParents($Record, [hashtable]$Processes) {
    $seen = @{}
    while ($Record) {
        $parent = $Processes[[int]$Record.ParentProcessId]
        if (-not $parent -or $seen.ContainsKey([int]$parent.ProcessId) -or $parent.CreationDate -gt $Record.CreationDate) { return }
        $seen[[int]$parent.ProcessId] = $true
        $parent
        $Record = $parent
    }
}

function Stop-StaleFarm {
    $byId = @{}
    foreach ($record in (Get-CimInstance Win32_Process -OperationTimeoutSec 5)) { $byId[[int]$record.ProcessId] = $record }
    $agentEntry = [regex]::Escape($PSScriptRoot) + '[\\/](?:src[\\/]index\.ts|dist[\\/]index\.js)(?:["\s]|$)'
    $launcherFile = [regex]::Escape($PSCommandPath) + '(?:["\s]|$)'
    $agentNodes = @{}
    foreach ($record in $byId.Values) {
        if ($record.Name -ne 'node.exe') { continue }
        if ($record.CommandLine -match $agentEntry) {
            $agentNodes[[int]$record.ProcessId] = $record
            continue
        }
        # Older start-farm.bat used pnpm/npm dev and a tsx watch node with relative arguments.
        foreach ($parent in (Get-FarmParents $record $byId)) {
            if ($parent.ProcessId -ne $PID -and $parent.Name -match '^(powershell|pwsh)\.exe$' -and $parent.CommandLine -match $launcherFile) {
                $agentNodes[[int]$record.ProcessId] = $record
                break
            }
        }
    }

    $conflicts = @()
    foreach ($listener in (Get-FarmPortListeners $agentPort)) {
        $owner = $byId[[int]$listener.ProcessId]
        if ($agentNodes.ContainsKey([int]$listener.ProcessId)) { continue }
        if ($owner.Name -eq 'node.exe' -and (Get-AgentHealth $listener.Address 10)) {
            $agentNodes[[int]$owner.ProcessId] = $owner
            continue
        }
        # A different process can bind this port on an unrelated interface.
        if ($Stop -or -not $route -or $listener.Address -in @('0.0.0.0','[::]','127.0.0.1',$route.Host)) {
            $conflicts += "Порт $agentPort занят PID $($listener.ProcessId) на $($listener.Address)."
        }
    }
    # Find a legacy watcher above a recognized listener even if the old PowerShell has exited.
    foreach ($record in @($agentNodes.Values)) {
        foreach ($parent in (Get-FarmParents $record $byId)) {
            if ($parent.Name -eq 'node.exe' -and $parent.CommandLine -match '(?i)\btsx\b.*\bwatch\s+("?)(?:\.[\\/])?src[\\/]index\.ts\b') {
                $agentNodes[[int]$parent.ProcessId] = $parent
            }
        }
    }

    $relays = @{}
    foreach ($listener in (Get-FarmPortListeners $gnirehtetPort | Sort-Object ProcessId -Unique)) {
        $owner = $byId[[int]$listener.ProcessId]
        if ($owner.Name -eq 'gnirehtet.exe') { $relays[[int]$owner.ProcessId] = $owner }
        else { $conflicts += "Порт USB-реле $gnirehtetPort занят PID $($listener.ProcessId)." }
    }
    if ($gnirehtetExe) {
        foreach ($record in $byId.Values) {
            if ($record.ExecutablePath -eq $gnirehtetExe -and
                $record.CommandLine -match '\s(?:autorun|relay|run)(?:\s|$)' -and
                $record.CommandLine -notmatch '\s-p\s+(?!31416(?:\s|$))\d+') {
                $relays[[int]$record.ProcessId] = $record
            }
        }
    }
    if ($conflicts.Count) {
        if (-not $Stop) { throw ($conflicts -join ' ') }
        $conflicts | ForEach-Object { Write-Warning $_ }
    }
    # Parent processes must stop before their children to prevent a watcher respawn.
    foreach ($record in @($agentNodes.Values | Sort-Object CreationDate) + @($relays.Values)) {
        $process = Get-LiveFarmProcess $record
        if (-not $process) { continue }
        Write-Host "[ОЧИСТКА] $($record.Name), PID $($record.ProcessId)." -ForegroundColor Yellow
        Stop-FarmProcess $process
    }
}

function Initialize-FarmAdb {
    Write-Host 'Проверка ADB и обнаружение USB-плат...' -ForegroundColor Yellow
    try {
        $devices = Invoke-FarmAdb -Arguments 'devices -l' -TimeoutMs 20000
    } catch [System.TimeoutException] {
        # On cold startup the daemon may inherit the first client's output handles.
        if (-not $_.Exception.Data['ClientExited']) {
            $server = Get-LocalAdbServer
            if ($server.ProcessName -ne 'adb') { throw }
            Write-Host "[ADB] Сервер PID $($server.Id) не отвечает. Перезапуск ADB." -ForegroundColor Yellow
            Stop-FarmProcess $server
        }
        $devices = Invoke-FarmAdb -Arguments 'devices -l' -TimeoutMs 20000
    }
    if (-not ($devices -match '^\S+\s+device(?:\s|$)')) {
        Start-Sleep -Seconds 2
        $devices = Invoke-FarmAdb -Arguments 'devices -l' -TimeoutMs 20000
    }
    $ready = 0
    foreach ($line in $devices) {
        if ($line -notmatch '^([a-zA-Z0-9_.:%\[\]-]+)\s+(device|offline|unauthorized)(?:\s|$)') { continue }
        $serial = $Matches[1]
        $state = $Matches[2]
        Write-Host "  $line"
        if ($state -ne 'device') { continue }
        $ready++
        try {
            $settings = '-s "{0}" shell "cmd netpolicy set restrict-background false && settings put global data_saver 0 && settings put global data_saver_enabled 0"' -f $serial
            Invoke-FarmAdb -Arguments $settings -TimeoutMs 5000 | Out-Null
        } catch { Write-Warning "$($serial): $($_.Exception.Message)" }
    }
    if ($ready -eq 0) { Write-Warning 'ADB не видит готовых плат. Агент продолжит ждать подключения.' }
}

function Set-FarmFirewallRule {
    if (-not $route) {
        # Preserve the existing inbound behavior for explicitly configured direct installations.
        $directName = "DeviceAgent $agentPort"
        if (-not (Get-NetFirewallRule -DisplayName $directName -ErrorAction SilentlyContinue)) {
            try {
                New-NetFirewallRule -DisplayName $directName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $agentPort -ErrorAction Stop | Out-Null
            } catch { Write-Warning "Не удалось добавить входящее правило TCP $agentPort." }
        }
        return
    }
    $name = "KMMZavod-DeviceAgent-$agentPort"
    try {
        $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
        if ($rule) {
            $rule | Set-NetFirewallRule -Enabled True -LocalAddress $route.Host -RemoteAddress $route.Vps -ErrorAction Stop | Out-Null
        } else {
            New-NetFirewallRule -Name $name -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $agentPort -LocalAddress $route.Host -RemoteAddress $route.Vps -Profile Any -ErrorAction Stop | Out-Null
        }
    } catch {
        Write-Warning "Не удалось настроить входящий TCP $agentPort от $($route.Vps). При недоступности с VPS проверьте правило Windows или запустите скрипт от администратора."
    }
}

$agentPort = 8300
$configuredPort = Get-AgentSetting 'DEVICE_AGENT_PORT'
if ($configuredPort -and (-not [int]::TryParse($configuredPort, [ref]$agentPort) -or $agentPort -lt 1 -or $agentPort -gt 65535)) {
    Write-Host '[ОШИБКА] DEVICE_AGENT_PORT должен быть числом от 1 до 65535.' -ForegroundColor Red
    exit 1
}
$gnirehtetPort = 31416
$gnirehtetExe = @($localPlatformTools, $rootPlatformTools) |
    ForEach-Object { Join-Path $_ 'gnirehtet.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    ForEach-Object { (Get-Item -LiteralPath $_).FullName } |
    Select-Object -First 1
if (-not $gnirehtetExe) {
    $gnirehtetExe = (Get-Command gnirehtet.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
$stopEventName = "Local\KMMZavod-FarmStop-$agentPort"
$mutex = [Threading.Mutex]::new($false, "Local\KMMZavod-FarmStart-$agentPort")
$locked = $false
$stopEvent = $null
$agent = $null
$usbRelay = $null
$route = $null
$exitCode = 0

try {
    try { $locked = $mutex.WaitOne(1000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Другой запуск или остановка фермы уже выполняется.' }

    if ($Stop) {
        Request-FarmStop
        Stop-StaleFarm
        Write-Host '[OK] Агент и USB-реле фермы остановлены.' -ForegroundColor Green
    } else {
        $node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $node) { throw 'Node.js не найден в PATH.' }
        if (-not $adbBin) { throw 'ADB не найден. Поместите platform-tools рядом со скриптом.' }
        $adbBin = (Get-Command $adbBin -CommandType Application | Select-Object -First 1).Source
        $route = Initialize-FarmRoute
        Set-FarmFirewallRule

        Push-Location $PSScriptRoot
        try {
            & $node -e "try { require.resolve('tsx') } catch { process.exit(1) }"
            if ($LASTEXITCODE -ne 0) {
                $pkgManager = if (Get-Command pnpm -ErrorAction SilentlyContinue) { 'pnpm' } else { 'npm' }
                & $pkgManager install
                if ($LASTEXITCODE -ne 0) { throw "Установка зависимостей завершилась с кодом $LASTEXITCODE." }
            }
        } finally { Pop-Location }

        Request-FarmStop
        Stop-StaleFarm
        Initialize-FarmAdb

        $stopEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $stopEventName)
        [void]$stopEvent.Reset()
        if ($gnirehtetExe) {
            $env:ADB = $adbBin
            $localApk = Join-Path (Split-Path -Parent $gnirehtetExe) 'gnirehtet.apk'
            if (-not $env:GNIREHTET_APK -and (Test-Path -LiteralPath $localApk -PathType Leaf)) { $env:GNIREHTET_APK = $localApk }
            $gnirehtetDns = if ($route) { $route.Dns } else { '77.88.8.8,1.1.1.1' }
            $usbRelay = Start-Process -FilePath $gnirehtetExe -ArgumentList 'autorun','-d',$gnirehtetDns -WindowStyle Hidden -PassThru
            $timer = [Diagnostics.Stopwatch]::StartNew()
            do {
                if ($usbRelay.HasExited) { throw "Gnirehtet завершился с кодом $($usbRelay.ExitCode)." }
                $listening = Get-FarmPortListeners $gnirehtetPort | Where-Object { $_.ProcessId -eq $usbRelay.Id }
                if ($listening) { break }
                Start-Sleep -Milliseconds 250
            } while ($timer.Elapsed.TotalSeconds -lt 8)
            if (-not $listening) { throw "Gnirehtet не начал слушать порт $gnirehtetPort." }
            Write-Host "[OK] Gnirehtet готов, PID $($usbRelay.Id), DNS $gnirehtetDns." -ForegroundColor Green
        } else { Write-Warning "Поместите gnirehtet.exe и gnirehtet.apk в $localPlatformTools для USB-интернета." }

        $env:ADB_PATH = $adbBin
        $agent = New-Object System.Diagnostics.Process
        $agent.StartInfo.FileName = $node
        $agent.StartInfo.WorkingDirectory = $PSScriptRoot
        $agent.StartInfo.Arguments = '--import tsx "' + (Join-Path $PSScriptRoot 'src\index.ts') + '"'
        $agent.StartInfo.UseShellExecute = $false
        $agent.StartInfo.RedirectStandardInput = $true
        $agent.StartInfo.EnvironmentVariables['KMMZAVOD_FARM_MANAGED'] = '1'
        [void]$agent.Start()

        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            if ($agent.HasExited) { throw "Агент завершился с кодом $($agent.ExitCode)." }
            $owned = @(Get-FarmPortListeners $agentPort | Where-Object { $_.ProcessId -eq $agent.Id })
            $ready = $owned.Count -gt 0 -and (Get-AgentHealth '127.0.0.1') -and
                (-not $route -or ($owned.Address -contains $route.Host -and (Get-AgentHealth $route.Host)))
            if ($ready) { break }
            Start-Sleep -Milliseconds 500
        } while ($timer.Elapsed.TotalSeconds -lt 20)
        if (-not $ready) { throw "Агент PID $($agent.Id) не подтвердил готовность на TCP $agentPort. Проверьте строки device-agent в выводе запуска." }
        if ($route) { Write-Host "[OK] Агент слушает $($route.Host):$agentPort. Остановка: Ctrl+C или start-farm.bat -Stop." -ForegroundColor Green }
        else { Write-Host "[OK] Агент готов. Остановка: Ctrl+C или start-farm.bat -Stop." -ForegroundColor Green }
        $mutex.ReleaseMutex()
        $locked = $false
        while (-not $agent.HasExited -and -not $stopEvent.WaitOne(500)) {
            if ($usbRelay -and $usbRelay.HasExited) { throw "USB-реле Gnirehtet остановилось с кодом $($usbRelay.ExitCode)." }
        }
        if ($agent.HasExited -and $agent.ExitCode -notin @(0,130,-1073741510)) { $exitCode = $agent.ExitCode }
    }
} catch {
    Write-Host "[ОШИБКА] $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($agent) {
        try {
            if (-not $agent.HasExited) {
                $agent.StandardInput.Close()
                if (-not $agent.WaitForExit(4000)) { Stop-FarmProcess $agent }
            }
        } catch { Write-Warning "Остановка агента: $($_.Exception.Message)" }
        finally { $agent.Dispose() }
    }
    if ($usbRelay) {
        try { Stop-FarmProcess $usbRelay }
        catch { Write-Warning "Остановка Gnirehtet: $($_.Exception.Message)" }
        finally { $usbRelay.Dispose() }
    }
    if ($stopEvent) { $stopEvent.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
