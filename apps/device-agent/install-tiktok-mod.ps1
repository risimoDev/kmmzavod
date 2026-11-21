<#
.SYNOPSIS
    Устанавливает TikTok Mod и плагин через ADB. По умолчанию сохраняет данные и сессии.
.DESCRIPTION
    Проверяет APK в apps/device-agent/apks до установки. Продолжает установку
    на остальных платах после успешной первой. Пустой -PluginApkName
    позволяет установить только основной APK.
#>

[CmdletBinding()]
param(
    [string]$ApkFolder,
    [string]$ModApkName = 'TikTok_MC_1.0.3-Beta(47.5.3)_Fix.apk',
    [AllowEmptyString()]
    [string]$PluginApkName = '2.46a1_plugin.apk',
    [string]$ExpectedModSha256 = '',
    [switch]$WipeData,
    [switch]$UninstallFirst
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ApkFolder) { $ApkFolder = Join-Path $PSScriptRoot 'apks' }
$apkFiles = @(Join-Path $ApkFolder $ModApkName)
if ($PluginApkName) {
    $apkFiles += (Join-Path $ApkFolder $PluginApkName)
}
foreach ($apkPath in $apkFiles) {
    if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
        Write-Host "[ОШИБКА] APK не найден: $apkPath" -ForegroundColor Red
        exit 1
    }
}
$apkFiles = @($apkFiles | ForEach-Object { (Get-Item -LiteralPath $_).FullName })
if ($ExpectedModSha256 -and (Get-FileHash -LiteralPath $apkFiles[0] -Algorithm SHA256).Hash -ne $ExpectedModSha256) {
    Write-Host "[ОШИБКА] SHA-256 файла $ModApkName не совпадает с ожидаемым." -ForegroundColor Red
    exit 1
}

$adbPath = Join-Path $PSScriptRoot 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adbPath -PathType Leaf)) {
    $adb = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $adb) {
        Write-Host '[ОШИБКА] ADB не найден в platform-tools рядом со скриптом или в PATH.' -ForegroundColor Red
        exit 1
    }
    $adbPath = $adb.Source
}

function Invoke-Adb {
    # ADB uses stderr for diagnostics, including successful native commands.
    $ErrorActionPreference = 'Continue'
    $output = & $adbPath @args 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join [Environment]::NewLine) }
}

$devices = Invoke-Adb devices -l
if ($devices.ExitCode -ne 0) {
    Write-Host "[ОШИБКА] Не удалось получить список плат: $($devices.Output)" -ForegroundColor Red
    exit 1
}
$onlineDevices = @(
    foreach ($line in $devices.Output -split '\r?\n') {
        if ($line -match '^(\S+)\s+device(?:\s|$)') { $matches[1] }
    }
)
if ($onlineDevices.Count -eq 0) {
    Write-Host "[ОШИБКА] Нет подключённых плат в состоянии 'device'." -ForegroundColor Red
    exit 1
}

$package = 'com.zhiliaoapp.musically'
function Install-ForDevice([string]$Serial) {
    Write-Host "[$Serial] Установка TikTok..." -ForegroundColor Cyan
    if ($UninstallFirst) {
        $installed = Invoke-Adb -s $Serial shell pm list packages $package
        if ($installed.ExitCode -ne 0) {
            Write-Host "[ОШИБКА] $($Serial): не удалось проверить установленное приложение. $($installed.Output)" -ForegroundColor Red
            return $false
        }
        if (($installed.Output -split '\r?\n') -contains "package:$package") {
            $uninstalled = Invoke-Adb -s $Serial uninstall $package
            if ($uninstalled.ExitCode -ne 0 -or $uninstalled.Output -notmatch '(?m)^\s*Success\s*$') {
                Write-Host "[ОШИБКА] $($Serial): не удалось удалить старый пакет. $($uninstalled.Output)" -ForegroundColor Red
                return $false
            }
        }
    }

    foreach ($apkPath in $apkFiles) {
        $name = Split-Path -Leaf $apkPath
        $install = Invoke-Adb -s $Serial install -r -d -g $apkPath
        if ($install.ExitCode -ne 0 -or $install.Output -notmatch '(?m)^\s*Success\s*$') {
            Write-Host "[ОШИБКА] $($Serial): $name. $($install.Output)" -ForegroundColor Red
            if ($install.Output -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' -and $apkPath -eq $apkFiles[0] -and -not $UninstallFirst) {
                Write-Host 'Подписи TikTok различаются. -UninstallFirst удалит старый TikTok вместе с данными и сессиями.' -ForegroundColor Yellow
            }
            return $false
        }
        Write-Host "[OK] $($Serial): $name установлен." -ForegroundColor Green
    }

    if ($WipeData) {
        $cleared = Invoke-Adb -s $Serial shell pm clear $package
        if ($cleared.ExitCode -ne 0 -or $cleared.Output -notmatch '(?m)^\s*Success\s*$') {
            Write-Host "[ОШИБКА] $($Serial): APK установлены, но данные не очищены. $($cleared.Output)" -ForegroundColor Red
            return $false
        }
    }
    foreach ($permission in @('READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'RECORD_AUDIO', 'CAMERA', 'POST_NOTIFICATIONS')) {
        Invoke-Adb -s $Serial shell pm grant $package "android.permission.$permission" | Out-Null
    }
    Invoke-Adb -s $Serial shell dumpsys deviceidle whitelist "+$package" | Out-Null
    return $true
}

$failed = @()
$completed = 0
foreach ($serial in $onlineDevices) {
    if (Install-ForDevice $serial) {
        $completed++
    } else {
        $failed += $serial
        if ($serial -eq $onlineDevices[0]) {
            Write-Host 'Установка на остальных платах остановлена после ошибки на первой.' -ForegroundColor Yellow
            break
        }
    }
}
Write-Host "Установка завершена на $completed из $($onlineDevices.Count) плат."
if ($failed.Count) {
    Write-Host "Ошибки на платах: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
