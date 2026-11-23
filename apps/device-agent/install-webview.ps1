[CmdletBinding(DefaultParameterSetName = 'Single')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Single')]
    [ValidateNotNullOrEmpty()]
    [string]$Serial,
    [Parameter(Mandatory, ParameterSetName = 'All')]
    [switch]$All,
    [string]$ApkPath = (Join-Path $PSScriptRoot 'apks\AndroidSystemWebView-138.0.7204.181-arm.apk')
)

$ErrorActionPreference = 'Stop'
$version = [version]'138.0.7204.181'
# APKMirror 720418101, Android 8–9, standalone arm64-v8a + armeabi-v7a.
$expectedSha256 = 'ef90254b3fd31edfc8c8cd35dbfbc4d81a2a4554a278b5cad9d4acfdd85e59ca'
if (-not (Test-Path -LiteralPath $ApkPath -PathType Leaf)) {
    throw "APK WebView не найден по пути $ApkPath"
}
$apk = (Get-Item -LiteralPath $ApkPath).FullName
if ((Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash -ne $expectedSha256) {
    throw 'SHA-256 APK не совпадает с указанной сборкой WebView 138.0.7204.181 для Android 8–9.'
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

function Get-WebViewVersion([string[]]$Lines) {
    foreach ($line in $Lines) {
        if ($line -match '^\s*Current WebView package.*\(com\.google\.android\.webview,\s*(\d+(?:\.\d+){3})\)') {
            return [version]$Matches[1]
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
    $state = @(Invoke-Adb -s $id shell 'getprop ro.build.version.sdk; getprop ro.product.cpu.abilist; dumpsys webviewupdate')
    $installed = Get-WebViewVersion $state
    if ($state.Count -lt 3 -or $state[0].Trim() -notin '26', '27', '28' -or
        $state[1].Trim() -notmatch '(?:^|,)(?:arm64-v8a|armeabi-v7a)(?:,|$)' -or -not $installed) {
        $reason = "[$id] Сборка рассчитана на ARM-устройства с Android 8–9 и активным com.google.android.webview."
        if (-not $All) { throw $reason }
        Write-Warning $reason
        continue
    }
    if ($installed -ge $version) {
        Write-Host "[$id] Активный WebView $installed, обновление пропущено."
        continue
    }

    Write-Host "[$id] WebView $installed → $version"
    Invoke-Adb -s $id install -r $apk | Write-Host
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        $active = Get-WebViewVersion (Invoke-Adb -s $id shell dumpsys webviewupdate)
        if ($active -eq $version) { break }
        Start-Sleep -Seconds 1
    }
    if ($active -ne $version) { throw "[$id] Android не выбрал WebView $version. Проверьте dumpsys webviewupdate." }
    Write-Host "[$id] Активен WebView $active."
}
