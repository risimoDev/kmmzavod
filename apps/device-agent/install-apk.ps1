<#
.SYNOPSIS
    Пакетная установка APK-приложения на все подключенные устройства телефонной фермы (Android USB-стойка).
.DESCRIPTION
    Скрипт автоматически находит утилиту adb.exe, опрашивает все активные Android-платы,
    и устанавливает указанный APK-файл одновременно или по очереди с авто-выдачей разрешений (-g).
.PARAMETER ApkPath
    Путь к .apk файлу (если не передан, скрипт предложит ввести путь или перетащить файл мышкой).
.PARAMETER Parallel
    Параллельная установка на все устройства сразу (по умолчанию $true).
.PARAMETER LaunchPackage
    Опционально: имя пакета приложения для автоматического запуска на всех платах после установки (напр. com.wildberries.work).
.EXAMPLE
    .\install-apk.ps1 -ApkPath "C:\Downloads\wildberries.apk"
    .\install-apk.ps1 -ApkPath "C:\Downloads\app.apk" -Parallel:$false
    .\install-apk.ps1 -ApkPath "C:\Downloads\tiktok.apk" -LaunchPackage "com.zhiliaoapp.musically"
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ApkPath,

    [switch]$Parallel = $true,
    [switch]$GrantPermissions = $true,
    [switch]$Downgrade = $true,
    [switch]$Reinstall = $true,
    [string]$LaunchPackage = ""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - УСТАНОВКА APK НА СТОЙКУ ТЕЛЕФОННОЙ ФЕРМЫ (ADB)"   -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Поиск adb.exe
$adb = $null
if (Get-Command adb -ErrorAction SilentlyContinue) {
    $adb = "adb"
} else {
    $candidates = @(
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        "$PSScriptRoot\platform-tools\adb.exe",
        "$PSScriptRoot\..\..\platform-tools\adb.exe",
        "C:\platform-tools\adb.exe"
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) {
            $adb = $cand
            break
        }
    }
}

if (-not $adb) {
    Write-Host "[ОШИБКА] Утилита adb.exe не найдена ни в PATH, ни в стандартных каталогах!" -ForegroundColor Red
    Write-Host "Скачайте Google platform-tools: https://developer.android.com/tools/releases/platform-tools" -ForegroundColor Yellow
    Write-Host "и положите папку platform-tools рядом с этим скриптом." -ForegroundColor Yellow
    exit 1
}

# 2. Определение пути к APK
if (-not $ApkPath -or -not (Test-Path $ApkPath)) {
    if ($ApkPath) {
        Write-Host "[ПРЕДУПРЕЖДЕНИЕ] Файл не найден: $ApkPath" -ForegroundColor Yellow
    }
    Write-Host "Перетащите мышкой файл .apk в это окно PowerShell (или вставьте путь) и нажмите Enter:" -ForegroundColor Green
    $inputPath = Read-Host "Путь к APK"
    $ApkPath = $inputPath.Trim('"').Trim("'").Trim()
}

if (-not $ApkPath -or -not (Test-Path $ApkPath)) {
    Write-Host "[ОШИБКА] APK файл не существует: '$ApkPath'" -ForegroundColor Red
    exit 1
}

$apkFileInfo = Get-Item $ApkPath
$apkSizeMb = [math]::Round($apkFileInfo.Length / 1MB, 2)
Write-Host "[OK] Выбран файл: $($apkFileInfo.Name) ($apkSizeMb МБ)" -ForegroundColor Green
Write-Host ""

# 3. Запуск ADB-сервера и опрос активных устройств
Write-Host "Опрос подключенных плат в стойке..." -ForegroundColor Gray
& $adb start-server | Out-Null
$rawDevices = & $adb devices -l
$onlineDevices = @()

foreach ($line in $rawDevices) {
    if ($line -match '^([a-zA-Z0-9_\-.:]+)\s+device(\s|$)') {
        $devId = $matches[1]
        $onlineDevices += $devId
    }
}

if ($onlineDevices.Count -eq 0) {
    Write-Host "[ОШИБКА] Ни одна Android-плата не обнаружена в статусе 'device'!" -ForegroundColor Red
    Write-Host "Проверьте:" -ForegroundColor Yellow
    Write-Host " 1. Подключены ли USB-кабели от USB-хаба к ПК." -ForegroundColor Yellow
    Write-Host " 2. Включена ли 'Отладка по USB' (USB Debugging) на платах." -ForegroundColor Yellow
    Write-Host " 3. Выполните 'adb devices' для проверки текущего статуса." -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Обнаружено активных плат: $($onlineDevices.Count)" -ForegroundColor Green
for ($i = 0; $i -lt $onlineDevices.Count; $i++) {
    Write-Host "  $($i + 1). $($onlineDevices[$i])" -ForegroundColor Cyan
}
Write-Host ""

# 4. Формирование флагов установки
$installArgs = @("install")
if ($Reinstall) { $installArgs += "-r" }
if ($Downgrade) { $installArgs += "-d" }
if ($GrantPermissions) { $installArgs += "-g" }
$installArgs += $ApkPath

Write-Host "Флаги установки: $($installArgs -join ' ')" -ForegroundColor DarkGray
Write-Host "Начинаем установку на $($onlineDevices.Count) устройств..." -ForegroundColor Yellow
Write-Host ""

$results = [System.Collections.Concurrent.ConcurrentBag[PSCustomObject]]::new()
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# 5. Процесс установки (Параллельно или последовательно)
if ($Parallel -and $PSVersionTable.PSVersion.Major -ge 7) {
    # PowerShell 7+ с поддержкой ForEach-Object -Parallel
    Write-Host "[РЕЖИМ] Параллельная установка (PowerShell 7+ Multi-Threading)..." -ForegroundColor Magenta
    $onlineDevices | ForEach-Object -Parallel {
        $dev = $_
        $adbExe = $using:adb
        $argsList = @("-s", $dev) + $using:installArgs
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        
        $output = & $adbExe $argsList 2>&1 | Out-String
        $sw.Stop()
        $isOk = $output -match "Success"
        
        $using:results.Add([PSCustomObject]@{
            Device   = $dev
            Success  = $isOk
            Duration = "$([math]::Round($sw.Elapsed.TotalSeconds, 1))с"
            Output   = $output.Trim()
        })
        
        if ($isOk) {
            Write-Host " [✓] [$dev] Успешно установлено за $([math]::Round($sw.Elapsed.TotalSeconds, 1))с" -ForegroundColor Green
        } else {
            Write-Host " [✗] [$dev] Ошибка: $($output.Trim())" -ForegroundColor Red
        }
    } -ThrottleLimit 40
} else {
    # Последовательный режим (PowerShell 5.1 или флаг -Parallel:$false)
    Write-Host "[РЕЖИМ] Последовательная установка (по очереди на каждую плату)..." -ForegroundColor Gray
    $idx = 0
    foreach ($dev in $onlineDevices) {
        $idx++
        Write-Host "[$idx/$($onlineDevices.Count)] Установка на $dev..." -ForegroundColor Cyan
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $argsList = @("-s", $dev) + $installArgs
        $output = & $adb $argsList 2>&1 | Out-String
        $sw.Stop()
        $isOk = $output -match "Success"
        
        $results.Add([PSCustomObject]@{
            Device   = $dev
            Success  = $isOk
            Duration = "$([math]::Round($sw.Elapsed.TotalSeconds, 1))с"
            Output   = $output.Trim()
        })
        
        if ($isOk) {
            Write-Host "  -> [✓] Успешно ($([math]::Round($sw.Elapsed.TotalSeconds, 1))с)" -ForegroundColor Green
        } else {
            Write-Host "  -> [✗] Ошибка: $($output.Trim())" -ForegroundColor Red
        }
    }
}

$stopwatch.Stop()
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   ИТОГ УСТАНОВКИ (Затрачено: $([math]::Round($stopwatch.Elapsed.TotalSeconds, 1)) сек)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

$successCount = ($results | Where-Object { $_.Success }).Count
$failCount = $onlineDevices.Count - $successCount

Write-Host "Всего плат:    $($onlineDevices.Count)" -ForegroundColor White
Write-Host "Успешно:       $successCount" -ForegroundColor Green
if ($failCount -gt 0) {
    Write-Host "С ошибкой:     $failCount" -ForegroundColor Red
}

Write-Host ""
$results | Format-Table -Property Device, Success, Duration, Output -AutoSize

# 6. Опциональный запуск приложения на всех устройствах
if ($LaunchPackage.Trim()) {
    $pkg = $LaunchPackage.Trim()
    Write-Host ""
    Write-Host "Запуск пакета '$pkg' на всех устройствах..." -ForegroundColor Cyan
    foreach ($dev in $onlineDevices) {
        & $adb -s $dev shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 | Out-Null
    }
    Write-Host "[OK] Приложение запущено на всех платах." -ForegroundColor Green
}

Write-Host ""
Write-Host "Готово." -ForegroundColor Cyan
