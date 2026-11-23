[CmdletBinding(DefaultParameterSetName = 'Single')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Single')]
    [ValidateNotNullOrEmpty()]
    [string[]]$Serial,
    [Parameter(Mandatory, ParameterSetName = 'All')]
    [switch]$All,
    [switch]$Check,
    [string]$ApkPath = (Join-Path $PSScriptRoot 'apks\AndroidSystemWebView-138.0.7204.181-arm.apk')
)

$ErrorActionPreference = 'Stop'
$version = [version]'138.0.7204.181'
# APKMirror 720418101, Android 8–9, standalone arm64-v8a + armeabi-v7a.
$expectedSha256 = 'ef90254b3fd31edfc8c8cd35dbfbc4d81a2a4554a278b5cad9d4acfdd85e59ca'
if (-not $Check) {
    if (-not (Test-Path -LiteralPath $ApkPath -PathType Leaf)) {
        throw "APK WebView не найден по пути $ApkPath"
    }
    $apk = (Get-Item -LiteralPath $ApkPath).FullName
    if ((Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash -ne $expectedSha256) {
        throw 'SHA-256 APK не совпадает с указанной сборкой WebView 138.0.7204.181 для Android 8–9.'
    }
}

$adbPath = Join-Path $PSScriptRoot 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adbPath -PathType Leaf)) {
    $adbPath = (Get-Command adb.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $adbPath) { throw 'Поместите adb.exe в platform-tools или добавьте его в PATH.' }
}

function Invoke-Adb {
    $ErrorActionPreference = 'Continue'
    $output = @(& $adbPath @args 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "Ошибка ADB при выполнении '$($args -join ' ')'. $($output -join ' ')" }
    $output
}

function Get-WebViewProvider([string[]]$Lines) {
    foreach ($line in $Lines) {
        if ($line -match '^\s*Current WebView package.*\(([^,\s]+),\s*([^)]+)\)') {
            return [pscustomobject]@{ Package = $Matches[1]; Version = $Matches[2].Trim() }
        }
    }
}

$targets = if ($All) {
    Invoke-Adb devices | ForEach-Object {
        if ($_ -match '^(\S+)\s+device\s*$') { $Matches[1] }
    }
} else {
    $Serial
}
if (-not $targets) { throw 'Не найдено ни одной платы для обновления.' }

foreach ($id in $targets) {
    try {
        $state = @(Invoke-Adb -s $id shell 'echo SDK=$(getprop ro.build.version.sdk); echo ABI=$(getprop ro.product.cpu.abilist); dumpsys webviewupdate')
    } catch {
        if (-not $Check) { throw }
        Write-Warning "[$id] $($_.Exception.Message)"
        continue
    }
    $sdk = ($state -cmatch '^SDK=' | Select-Object -First 1) -replace '^SDK=', ''
    $abi = ($state -cmatch '^ABI=' | Select-Object -First 1) -replace '^ABI=', ''
    $provider = Get-WebViewProvider $state
    $installed = $null
    $issues = @(
        if (-not $sdk) { 'устройство не вернуло SDK' }
        elseif ($sdk -notin '26', '27', '28') { "SDK $sdk вне диапазона 26–28 для этого APK" }
        if (-not $abi) { 'устройство не вернуло список ABI' }
        elseif ($abi -notmatch '(?:^|,)\s*(?:arm64-v8a|armeabi-v7a)\s*(?:,|$)') { "ABI $abi без поддержки ARM этой сборки" }
        if (-not $provider) { 'dumpsys не сообщает активный провайдер WebView' }
        elseif ($provider.Package -ne 'com.google.android.webview') { "активен другой провайдер $($provider.Package) $($provider.Version)" }
        elseif (-not [version]::TryParse($provider.Version, [ref]$installed)) { "не удалось разобрать версию WebView $($provider.Version)" }
    )
    if ($Check) {
        Write-Host "[$id] SDK=$sdk | ABI=$abi"
        $state | Where-Object { $_ -match 'WebView package|^\s*(?:Valid|Invalid) package' } | Write-Host
        if (-not $issues) { Write-Host "[$id] APK совместим по SDK, ABI и активному провайдеру." }
    }
    if ($issues) {
        $reason = "[$id] $($issues -join '. ')."
        if (-not $All -and -not $Check) { throw $reason }
        Write-Warning $reason
    }
    if ($Check -or $issues) { continue }
    if ($installed -ge $version) {
        Write-Host "[$id] Активный WebView $installed, обновление пропущено."
        continue
    }

    Write-Host "[$id] WebView $installed → $version"
    Invoke-Adb -s $id install -r $apk | Write-Host
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        $active = Get-WebViewProvider (Invoke-Adb -s $id shell dumpsys webviewupdate)
        if ($active.Package -eq 'com.google.android.webview' -and $active.Version -eq $version.ToString()) { break }
        Start-Sleep -Seconds 1
    }
    if ($active.Package -ne 'com.google.android.webview' -or $active.Version -ne $version.ToString()) {
        throw "[$id] Android не выбрал WebView $version. Проверьте dumpsys webviewupdate."
    }
    Write-Host "[$id] Активен WebView $version."
}
