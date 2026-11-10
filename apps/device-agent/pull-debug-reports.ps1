<#
.SYNOPSIS
    KMMZAVOD - Сбор и автоматический анализ отчётов и скриншотов с плат стойки
.DESCRIPTION
    Скрипт скачивает со всех 20 плат папку /sdcard/kmm-debug/ (где сохранены скриншоты
    и дампы экранов, на которых застряла публикация), анализирует причину сбоя на каждой
    плате и открывает папку с картинками.
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Анализатор снимков экрана и ошибок публикации"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - СБОР И АНАЛИЗ СНИМКОВ ЭКРАНА С ПЛАТ СТОЙКИ        " -ForegroundColor Cyan
Write-Host "   Автоматическая расшифровка причин зависания публикации        " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Поиск ADB
$adb = "adb"
if (Test-Path "$PSScriptRoot\platform-tools\adb.exe") {
    $adb = "$PSScriptRoot\platform-tools\adb.exe"
} elseif (Test-Path "$PSScriptRoot\..\..\platform-tools\adb.exe") {
    $adb = "$PSScriptRoot\..\..\platform-tools\adb.exe"
} elseif ($env:LOCALAPPDATA -and (Test-Path "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe")) {
    $adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
}

# 2. Опрос подключенных устройств
$devicesRaw = & $adb devices
$onlineDevices = @()
foreach ($line in ($devicesRaw -split "`r?`n")) {
    if ($line -match "^([^\s]+)\s+device\b") {
        $onlineDevices += $matches[1]
    }
}

if ($onlineDevices.Count -eq 0) {
    Write-Host "[ОШИБКА] Ни одна плата не подключена к ADB!" -ForegroundColor Red
    Write-Host "Проверьте USB-подключение и запустите start-farm.bat." -ForegroundColor Yellow
    pause
    exit 1
}

Write-Host "Обнаружено подключенных плат: $($onlineDevices.Count)" -ForegroundColor Green
Write-Host ""

$targetDir = Join-Path $PSScriptRoot "debug-reports"
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

$summary = @()

$idx = 0
foreach ($serial in $onlineDevices) {
    $idx++
    Write-Host "[$idx/$($onlineDevices.Count)] Опрос платы $serial..." -ForegroundColor Cyan

    $devDir = Join-Path $targetDir $serial
    if (-not (Test-Path $devDir)) {
        New-Item -ItemType Directory -Path $devDir -Force | Out-Null
    }

    # Проверка наличия снимков в /sdcard/kmm-debug/
    $remoteFilesRaw = & $adb -s $serial shell "ls -1 /sdcard/kmm-debug/ 2>/dev/null"
    $remoteFiles = ($remoteFilesRaw -split "`r?`n") | Where-Object { $_.Trim() -and $_ -notmatch "No such file" }

    $pulledCount = 0
    if ($remoteFiles.Count -gt 0) {
        Write-Host "   -> Найдено снимков на плате: $($remoteFiles.Count). Скачивание..." -ForegroundColor Yellow
        & $adb -s $serial pull /sdcard/kmm-debug/ "$devDir\" 2>$null | Out-Null
        $pulledCount = $remoteFiles.Count
    } else {
        Write-Host "   -> Старых аварийных снимков нет. Делаю текущий снимок экрана..." -ForegroundColor Gray
        # Захват текущего состояния экрана платы
        $nowStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $curPng = Join-Path $devDir "current_screen_${nowStamp}.png"
        $curXml = Join-Path $devDir "current_screen_${nowStamp}.xml"
        & $adb -s $serial exec-out screencap -p > $curPng 2>$null
        & $adb -s $serial shell "uiautomator dump /data/local/tmp/cur.xml >/dev/null 2>&1; cat /data/local/tmp/cur.xml" > $curXml 2>$null
    }

    # Анализ самого свежего XML
    $xmlFiles = Get-ChildItem -Path $devDir -Filter "*.xml" | Sort-Object LastWriteTime -Descending
    $diagnosis = "Экран неизвестен"
    $statusColor = "Yellow"
    $actionNeeded = "Посмотреть скриншот"

    if ($xmlFiles.Count -gt 0) {
        $newestXml = $xmlFiles[0]
        $xmlContent = Get-Content $newestXml.FullName -Raw -ErrorAction SilentlyContinue

        if ($xmlContent) {
            # Проверка ключевых маркеров
            if ($xmlContent -match "(network error|check your network|no internet|нет подключения|ошибка сети)") {
                $diagnosis = "НЕТ СЕТИ («Network error») — плата не имела выхода в интернет"
                $statusColor = "Red"
                $actionNeeded = "Запустить save-traffic.bat для разблокировки tun0"
            } elseif ($xmlContent -match "(log in|sign up|войти|зарегистрироваться|create account)") {
                $diagnosis = "АККАУНТ РАЗЛОГИНИЛСЯ — на экране окно входа в TikTok"
                $statusColor = "Red"
                $actionNeeded = "Войти в аккаунт на этой плате вручную или через софт"
            } elseif ($xmlContent -match "(allow|разрешить|доступ к фото|permission)") {
                $diagnosis = "СИСТЕМНЫЙ ЗАПРОС ПРАВ — Android ждал нажатия «Разрешить»"
                $statusColor = "Yellow"
                $actionNeeded = "Обновленный скрипт теперь нажимает «Разрешить» автоматически"
            } elseif ($xmlContent -match "(drafts?|черновик)" -and $xmlContent -match "(post|опубликовать|поделиться)") {
                $diagnosis = "ЭКРАН ПУБЛИКАЦИИ — был виден экран публикации, но не нажалась кнопка"
                $statusColor = "Magenta"
                $actionNeeded = "Обновлен publish-flow (координаты кнопки рядом с Черновиками)"
            } elseif ($xmlContent -match "(your story|в историю)" -and $xmlContent -match "(next|далее)") {
                $diagnosis = "РЕДАКТОР TIKTOK — экран выбора «В историю / Далее»"
                $statusColor = "Yellow"
                $actionNeeded = "Обновлен переход из редактора (клик Далее справа)"
            } elseif ($xmlContent -match "(galaxyfinder|launcher|com\.sec\.android\.app\.launcher)") {
                $diagnosis = "РАБОЧИЙ СТОЛ — TikTok свернулся или не запустился"
                $statusColor = "Red"
                $actionNeeded = "Проверить, установлен ли TikTok на плате"
            } elseif ($xmlContent -match "(account suspended|account banned|temporarily locked|заблокирован)") {
                $diagnosis = "БЛОКИРОВКА АККАУНТА TIKTOK — аккаунт заблокирован или ограничен"
                $statusColor = "Red"
                $actionNeeded = "Заменить аккаунт на плате"
            } else {
                $diagnosis = "Кастомный экран TikTok или диалог"
                $statusColor = "Cyan"
                $actionNeeded = "Открыть файл $($newestXml.Name.Replace('.xml','.png'))"
            }
        }
    }

    $summary += [PSCustomObject]@{
        Board     = $serial
        Files     = $pulledCount
        Diagnosis = $diagnosis
        Action    = $actionNeeded
    }

    Write-Host "   -> Диагноз: $diagnosis" -ForegroundColor $statusColor
    Write-Host ""
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "                      СВОДКА ПО ПЛАТАМ                          " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$summary | Format-Table -Property Board, Files, Diagnosis, Action -AutoSize

Write-Host ""
Write-Host "Все скриншоты сохранены в папку: $targetDir" -ForegroundColor Green
Write-Host "Открываю папку со снимками экранов..." -ForegroundColor Green

Invoke-Item $targetDir
