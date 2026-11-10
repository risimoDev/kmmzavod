<#
.SYNOPSIS
    KMMZAVOD - Сбор и автоматический анализ отчётов и скриншотов с плат стойки
.DESCRIPTION
    Скрипт скачивает со всех 20 плат папку /sdcard/kmm-debug/ (где сохранены скриншоты
    и дампы экранов, на которых застряла публикация), анализирует причину сбоя на каждой
    плате и открывает папку со всеми снимками экранов.
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

$targetDir = (Join-Path $PSScriptRoot "debug-reports").TrimEnd('\')
$latestScreensDir = (Join-Path $targetDir "_latest_screens").TrimEnd('\')

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}
if (-not (Test-Path $latestScreensDir)) {
    New-Item -ItemType Directory -Path $latestScreensDir -Force | Out-Null
}

$summary = @()

$idx = 0
foreach ($serial in $onlineDevices) {
    $idx++
    Write-Host "[$idx/$($onlineDevices.Count)] Опрос платы $serial..." -ForegroundColor Cyan

    $devDir = (Join-Path $targetDir $serial).TrimEnd('\')
    if (-not (Test-Path $devDir)) {
        New-Item -ItemType Directory -Path $devDir -Force | Out-Null
    }

    # 1. Проверяем текущее активное приложение (Foreground App)
    $focusRaw = & $adb -s $serial shell "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' 2>/dev/null"
    $currentPkg = "неизвестно"
    if ($focusRaw -match "([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.]+)") {
        $currentPkg = "$($matches[1]) ($($matches[2]))"
    }

    # 2. Скачивание всех аварийных снимков из /sdcard/kmm-debug/
    $remoteCheck = & $adb -s $serial shell "ls /sdcard/kmm-debug/ 2>/dev/null"
    $hasRemoteFiles = $remoteCheck -and ($remoteCheck -notmatch "No such file")

    if ($hasRemoteFiles) {
        Write-Host "   -> Скачивание снимков и дампов..." -ForegroundColor Yellow
        # Тянем всё содержимое без экранирования слэшей
        & $adb -s $serial pull /sdcard/kmm-debug/. $devDir 2>$null | Out-Null
    }

    # 3. Делаем свежий снимок текущего экрана без искажения бинарного потока PowerShell
    $freshStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    & $adb -s $serial shell "screencap -p /sdcard/cur_${freshStamp}.png 2>/dev/null; uiautomator dump /sdcard/cur_${freshStamp}.xml 2>/dev/null" 2>$null | Out-Null
    & $adb -s $serial pull "/sdcard/cur_${freshStamp}.png" "$devDir\current_screen.png" 2>$null | Out-Null
    & $adb -s $serial pull "/sdcard/cur_${freshStamp}.xml" "$devDir\current_screen.xml" 2>$null | Out-Null
    & $adb -s $serial shell "rm -f /sdcard/cur_${freshStamp}.* 2>/dev/null" 2>$null | Out-Null

    # 4. Анализируем все XML-файлы платы (самый свежий аварийный или текущий)
    $xmlFiles = Get-ChildItem -Path $devDir -Filter "*.xml" | Sort-Object LastWriteTime -Descending
    $diagnosis = "Экран неизвестен"
    $statusColor = "Yellow"
    $actionNeeded = "Открыть скриншот"
    $extractedTexts = @()

    if ($xmlFiles.Count -gt 0) {
        $targetXml = $xmlFiles[0]
        # Если есть pub_tiktok_timeout или pub_tiktok_unknown, берем именно его для анализа сбоя
        $crashXmls = $xmlFiles | Where-Object { $_.Name -match "pub_tiktok_(timeout|unknown|error|offline)" }
        if ($crashXmls) {
            $targetXml = $crashXmls[0]
        }

        $xmlContent = Get-Content $targetXml.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue

        if ($xmlContent) {
            # Извлекаем все видимые надписи на экране
            $matchesText = [regex]::Matches($xmlContent, 'text="([^"]+)"')
            foreach ($m in $matchesText) {
                $t = $m.Groups[1].Value.Trim()
                if ($t -and $t.Length -gt 1 -and $extractedTexts -notcontains $t) {
                    $extractedTexts += $t
                }
            }
            $matchesDesc = [regex]::Matches($xmlContent, 'content-desc="([^"]+)"')
            foreach ($m in $matchesDesc) {
                $d = $m.Groups[1].Value.Trim()
                if ($d -and $d.Length -gt 1 -and $extractedTexts -notcontains $d) {
                    $extractedTexts += $d
                }
            }

            # Анализируем по ключевым словам
            $allTextStr = ($extractedTexts -join " ").ToLower()

            if ($allTextStr -match "network error|check your network|нет подключения|ошибка сети|you're offline") {
                $diagnosis = "НЕТ СЕТИ («Network error») — плата была без интернета"
                $statusColor = "Red"
                $actionNeeded = "Запустить save-traffic.bat для разблокировки tun0"
            } elseif ($allTextStr -match "log in|sign up|войти|зарегистрироваться|create account|вход в tiktok") {
                $diagnosis = "СЛЕТЕЛ ВХОД В АККАУНТ — открыт экран авторизации TikTok"
                $statusColor = "Red"
                $actionNeeded = "Войти в аккаунт на плате"
            } elseif ($allTextStr -match "разрешить|allow|доступ к фото|permission") {
                $diagnosis = "СИСТЕМНЫЙ ЗАПРОС ПРАВ — Android ожидал клика «Разрешить»"
                $statusColor = "Yellow"
                $actionNeeded = "Уже исправлено в коде (автокликер прав)"
            } elseif ($allTextStr -match "черновик|draft" -and $allTextStr -match "опубликовать|поделиться|post|share") {
                $diagnosis = "ЭКРАН ПУБЛИКАЦИИ — кнопка Опубликовать рядом с Черновиками"
                $statusColor = "Magenta"
                $actionNeeded = "Уже исправлено в коде (структурный клик)"
            } elseif ($allTextStr -match "в историю|your story" -and $allTextStr -match "далее|next") {
                $diagnosis = "РЕДАКТОР TIKTOK — экран выбора «В историю / Далее»"
                $statusColor = "Yellow"
                $actionNeeded = "Уже исправлено в коде (клик Далее справа)"
            } elseif ($allTextStr -match "не сейчас|позже|not now|later|dismiss|отклонить") {
                $diagnosis = "ВСПЛЫВАЮЩИЙ ДИАЛОГ TIKTOK — подсказка или предложение"
                $statusColor = "Cyan"
                $actionNeeded = "Уже исправлено в коде (авто-закрытие)"
            } elseif ($currentPkg -match "launcher|galaxyfinder") {
                $diagnosis = "РАБОЧИЙ СТОЛ — TikTok свернут"
                $statusColor = "Gray"
                $actionNeeded = "TikTok запустится автоматически"
            } else {
                $preview = ($extractedTexts | Select-Object -First 4) -join " | "
                if ($preview) {
                    $diagnosis = "Экран: $preview"
                } else {
                    $diagnosis = "Кастомный экран (пакет: $currentPkg)"
                }
                $statusColor = "White"
                $actionNeeded = "См. скриншот платы"
            }
        }
    }

    # 5. Копируем лучший скриншот в общую папку _latest_screens для удобного просмотра
    $pngFiles = Get-ChildItem -Path $devDir -Filter "*.png" | Sort-Object LastWriteTime -Descending
    if ($pngFiles.Count -gt 0) {
        $bestPng = $pngFiles[0]
        # Если есть файл сбоя, копируем его
        $crashPngs = $pngFiles | Where-Object { $_.Name -match "pub_tiktok" }
        if ($crashPngs) { $bestPng = $crashPngs[0] }
        Copy-Item -Path $bestPng.FullName -Destination "$latestScreensDir\${serial}_screen.png" -Force
    }

    $allFilesCount = (Get-ChildItem -Path $devDir).Count
    $summary += [PSCustomObject]@{
        Board     = $serial
        App       = ($currentPkg -split "/")[0]
        Diagnosis = $diagnosis
        Action    = $actionNeeded
    }

    Write-Host "   -> Активно: $currentPkg" -ForegroundColor Gray
    Write-Host "   -> Диагноз: $diagnosis" -ForegroundColor $statusColor
    if ($extractedTexts.Count -gt 0) {
        $previewTxt = ($extractedTexts | Select-Object -First 6) -join " • "
        Write-Host "   -> Текст на экране: $previewTxt" -ForegroundColor DarkGray
    }
    Write-Host ""
}

Write-Host "==========================================================================================" -ForegroundColor Cyan
Write-Host "                                   СВОДКА ПО ПЛАТАМ                                       " -ForegroundColor Cyan
Write-Host "==========================================================================================" -ForegroundColor Cyan
Write-Host ""

$summary | Format-Table -Property Board, App, Diagnosis, Action -AutoSize

Write-Host ""
Write-Host "Все скриншоты в высоком разрешении скопированы в:" -ForegroundColor Green
Write-Host "  $latestScreensDir" -ForegroundColor White
Write-Host "Открываю папку с картинками экранов плат..." -ForegroundColor Green

Invoke-Item $latestScreensDir
