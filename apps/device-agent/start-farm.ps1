<#
.SYNOPSIS
    KMMZAVOD - Запуск агента стойки телефонной фермы (Native ADB Device-Agent)
.DESCRIPTION
    Скрипт проверяет окружение, очищает зависшие процессы ADB, опрашивает подключенные платы
    и запускает bridge-сервер между фермой и оркестратором платформы.
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Phone Farm Bridge (ADB Controller)"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - АГЕНТ СТОЙКИ ТЕЛЕФОННОЙ ФЕРМЫ (NATIVE ADB)        " -ForegroundColor Cyan
Write-Host "   Бесплатный открытый контроллер (без стороннего ПО и подписок)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Проверка Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ОШИБКА] Node.js не найден в PATH!" -ForegroundColor Red
    Write-Host "Установите Node.js 20+: https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "Нажмите Enter для выхода..."
    exit 1
}

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
} else {
    Write-Host "[ВНИМАНИЕ] adb.exe не найден! Поместите папку platform-tools рядом со скриптом." -ForegroundColor Yellow
}

# 3. Очистка старых зависших процессов ADB и запуск сервера
Write-Host ""
Write-Host "Проверка и перезапуск службы ADB..." -ForegroundColor Yellow
Get-Process -Name adb -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

if ($adbBin) {
    & $adbBin start-server
    Start-Sleep -Milliseconds 500

    Write-Host ""
    Write-Host "Подключенные платы в стойке:" -ForegroundColor Cyan
    $rawDevices = & $adbBin devices -l
    $deviceCount = 0
    foreach ($line in $rawDevices) {
        if ($line -match "^([^\s]+)\s+(device|offline|unauthorized)(.*)$") {
            $deviceCount++
            $serial = $matches[1]
            $state = $matches[2]
            $info = $matches[3].Trim()
            $color = if ($state -eq "device") { "Green" } else { "Red" }
            Write-Host "  [$deviceCount] $serial - $state ($info)" -ForegroundColor $color
        }
    }

    if ($deviceCount -eq 0) {
        Write-Host "  [ВНИМАНИЕ] Ни одна плата не обнаружена в статусе 'device'!" -ForegroundColor Yellow
        Write-Host "  Проверьте USB-подключение хаба и отладку по USB на телефонах." -ForegroundColor Yellow
    } else {
        Write-Host "  Всего активно плат: $deviceCount" -ForegroundColor Green
    }
}

# 4. Проверка VPN-туннеля AmneziaWG
Write-Host ""
Write-Host "Проверка туннеля с сервером платформы:" -ForegroundColor Cyan
$ipconfig = ipconfig
if ($ipconfig -match "10\.66\.66\.2" -or $ipconfig -match "10\.13\.13\.2") {
    Write-Host "[OK] Интерфейс AmneziaWG активен (10.66.66.2 / 10.13.13.2)" -ForegroundColor Green
} else {
    Write-Host "[ВНИМАНИЕ] Туннельный IP 10.66.66.2 не найден в ipconfig!" -ForegroundColor Yellow
    Write-Host "Убедитесь, что клиент AmneziaWG запущен и подключен." -ForegroundColor Yellow
}

# 5. Определение пакетного менеджера (pnpm / npm)
$pkgManager = if (Get-Command pnpm -ErrorAction SilentlyContinue) { "pnpm" } else { "npm" }

# 6. Установка зависимостей, если нет node_modules
Set-Location $PSScriptRoot
if (-not (Test-Path "node_modules")) {
    Write-Host "Папка node_modules не найдена. Установка через $pkgManager..." -ForegroundColor Yellow
    if ($pkgManager -eq "pnpm") { & pnpm install } else { & npm install }
}

# 7. Запуск приложения
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   ЗАПУСК NATIVE DEVICE-AGENT (порт 8300)...                    " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

if ($pkgManager -eq "pnpm") {
    & pnpm dev
} else {
    & npm run dev
}
