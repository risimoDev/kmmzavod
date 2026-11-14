<#
.SYNOPSIS
    Безопасная установка TikTok Mod и TikTok Plugin на платы стойки через ADB.
.DESCRIPTION
    1. Проверяет наличие конкретных файлов TikTok_Mod.apk и TikTok_Plugin.apk (с опциональной сверкой SHA-256).
    2. Выполняет тестовую установку на первой плате для проверки совместимости подписи ключа.
    3. При несовпадении подписи (INSTALL_FAILED_UPDATE_INCOMPATIBLE) предупреждает о необходимости флага -UninstallFirst.
    4. По умолчанию сохраняет сессии аккаунтов (флаг -WipeData выключен).
    5. Пакетно устанавливает APK и выдает необходимые системные разрешения.
#>

[CmdletBinding()]
param(
    [string]$ApkFolder = "$PSScriptRoot\apks",
    [string]$ModApkName = "TikTok_Mod.apk",
    [string]$PluginApkName = "TikTok_Plugin.apk",
    [string]$ExpectedModSha256 = "",
    [switch]$WipeData = $false,
    [switch]$UninstallFirst = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - УСТАНОВКА TIKTOK MOD НА ПЛАТЫ СТОЙКИ (ADB)        " -ForegroundColor Cyan
Write-Host "   Обход блокировок РФ с сохранением сессий аккаунтов           " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $ApkFolder)) {
    New-Item -ItemType Directory -Path $ApkFolder -Force | Out-Null
}

$modPath = Join-Path $ApkFolder $ModApkName
$pluginPath = Join-Path $ApkFolder $PluginApkName

$targetApks = @()

if (Test-Path $modPath) {
    $targetApks += (Get-Item $modPath)
}
if (Test-Path $pluginPath) {
    $targetApks += (Get-Item $pluginPath)
}

if ($targetApks.Count -eq 0) {
    Write-Host "[!] В папке '$ApkFolder' не найдено целевых APK-файлов ($ModApkName / $PluginApkName)!" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "ИНСТРУКЦИЯ ПО УСТАНОВКЕ TIKTOK MOD:" -ForegroundColor Green
    Write-Host "1. Скачайте проверенный TikTok Mod и TikTok Plugin (сборки BReaaker или Дмитрия Нечипоренко)." -ForegroundColor White
    Write-Host "2. Положите файлы в папку:" -ForegroundColor Cyan
    Write-Host "   $ApkFolder\$ModApkName" -ForegroundColor DarkGray
    Write-Host "   $ApkFolder\$PluginApkName (опционально)" -ForegroundColor DarkGray
    Write-Host "3. Запустите скрипт повторно." -ForegroundColor Green
    Write-Host ""
    exit 0
}

# Опциональная проверка SHA-256 для защиты от поврежденных файлов
if ($ExpectedModSha256 -and (Test-Path $modPath)) {
    Write-Host "Проверка контрольной суммы SHA-256 для $ModApkName..." -ForegroundColor Gray
    $actualHash = (Get-FileHash -Path $modPath -Algorithm SHA256).Hash
    if ($actualHash -ne $ExpectedModSha256) {
        Write-Host "[ОШИБКА] Хеш $ModApkName не совпадает с ожидаемым!" -ForegroundColor Red
        Write-Host "  Ожидался: $ExpectedModSha256" -ForegroundColor Yellow
        Write-Host "  Получен:  $actualHash" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Хеш SHA-256 проверен успешно." -ForegroundColor Green
}

# Опрос активных плат
Write-Host "Поиск активных плат через ADB..." -ForegroundColor Gray
$rawDevices = & adb devices -l 2>&1
$onlineDevices = @()
foreach ($l in $rawDevices) {
    if ($l -match '^([a-zA-Z0-9_\-.:]+)\s+device(\s|$)') {
        $onlineDevices += $matches[1]
    }
}

if ($onlineDevices.Count -eq 0) {
    Write-Host "[ОШИБКА] Ни одна Android-плата не подключена в режиме 'device'!" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Найдено подключенных плат: $($onlineDevices.Count)" -ForegroundColor Green
Write-Host ""

$PKG = "com.zhiliaoapp.musically"

# ТЕСТОВАЯ УСТАНОВКА НА ПЕРВОЙ ПЛАТЕ ДЛЯ ПРОВЕРКИ СОВМЕСТИМОСТИ ПОДПИСИ
$testDev = $onlineDevices[0]
Write-Host "[ТЕСТ] Проверка совместимости установки на плате $testDev..." -ForegroundColor Yellow

if ($UninstallFirst) {
    Write-Host "  [ВНИМАНИЕ] Флаг -UninstallFirst активен: удаление старого пакета на $testDev..." -ForegroundColor Yellow
    & adb -s $testDev uninstall $PKG 2>&1 | Out-Null
}

$testOut = & adb -s $testDev install -r -d -g $targetApks[0].FullName 2>&1 | Out-String

if ($testOut -match "INSTALL_FAILED_UPDATE_INCOMPATIBLE") {
    Write-Host ""
    Write-Host "[ОШИБКА] Несовпадение подписи APK (INSTALL_FAILED_UPDATE_INCOMPATIBLE)!" -ForegroundColor Red
    Write-Host "На платах установлен официальный TikTok с другой цифровой подписью." -ForegroundColor Red
    Write-Host "Для перехода на мод требуется сначала удалить официальную версию." -ForegroundColor Yellow
    Write-Host "Запустите скрипт с флагом удаления старой версии:" -ForegroundColor Cyan
    Write-Host "  .\install-tiktok-mod.ps1 -UninstallFirst" -ForegroundColor Green
    Write-Host "(Внимание: это потребует повторного входа в аккаунты!)" -ForegroundColor DarkGray
    exit 1
} elseif ($testOut -notmatch "Success") {
    Write-Host "[ОШИБКА] Тестовая установка на $testDev завершилась неудачей: $($testOut.Trim())" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Тестовая установка успешна! Подпись APK совместима." -ForegroundColor Green
Write-Host ""

# ОСНОВНОЙ ЦИКЛ УСТАНОВКИ НА ВСЕ ПЛАТЫ
$failedDevices = @()
$successDevices = @()

foreach ($dev in $onlineDevices) {
    Write-Host "----------------------------------------------------------------" -ForegroundColor Gray
    Write-Host "[Плата $dev] Установка..." -ForegroundColor Cyan

    & adb -s $dev shell "am force-stop $PKG 2>/dev/null" | Out-Null

    if ($WipeData) {
        Write-Host "  [!] Очистка данных приложения (флаг -WipeData)..." -ForegroundColor Yellow
        & adb -s $dev shell "pm clear $PKG 2>/dev/null" | Out-Null
    }

    if ($UninstallFirst -and $dev -ne $testDev) {
        & adb -s $dev uninstall $PKG 2>&1 | Out-Null
    }

    $devSuccess = $true
    foreach ($apk in $targetApks) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $installOut = & adb -s $dev install -r -d -g $apk.FullName 2>&1 | Out-String
        $sw.Stop()

        if ($installOut -match "Success") {
            Write-Host "  [✓] $($apk.Name) установлен ($([math]::Round($sw.Elapsed.TotalSeconds, 1))с)" -ForegroundColor Green
        } else {
            Write-Host "  [✗] Ошибка $($apk.Name): $($installOut.Trim())" -ForegroundColor Red
            $devSuccess = $false
        }
    }

    if ($devSuccess) {
        # Выдача необходимых разрешений и отключение Doze
        & adb -s $dev shell "pm grant $PKG android.permission.READ_EXTERNAL_STORAGE 2>/dev/null" | Out-Null
        & adb -s $dev shell "pm grant $PKG android.permission.WRITE_EXTERNAL_STORAGE 2>/dev/null" | Out-Null
        & adb -s $dev shell "pm grant $PKG android.permission.RECORD_AUDIO 2>/dev/null" | Out-Null
        & adb -s $dev shell "pm grant $PKG android.permission.CAMERA 2>/dev/null" | Out-Null
        & adb -s $dev shell "pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null" | Out-Null
        & adb -s $dev shell "dumpsys deviceidle whitelist +$PKG 2>/dev/null" | Out-Null
        $successDevices += $dev
    } else {
        $failedDevices += $dev
    }
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   ИТОГИ УСТАНОВКИ TIKTOK MOD:                                 " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Успешно: $($successDevices.Count) из $($onlineDevices.Count)" -ForegroundColor $(if ($successDevices.Count -eq $onlineDevices.Count) { 'Green' } else { 'Yellow' })

if ($failedDevices.Count -gt 0) {
    Write-Host "Ошибки на платах: $($failedDevices -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "   [УСПЕХ] TIKTOK MOD УСПЕШНО УСТАНОВЛЕН НА ВСЕ ПЛАТЫ!           " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
