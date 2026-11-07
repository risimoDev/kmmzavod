<#
.SYNOPSIS
    KMMZAVOD - Диагностика и авто-помощник Magisk Root на платах стойки
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Проверка Root и Magisk на платах"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - ДИАГНОСТИКА ROOT И MAGISK НА ПЛАТАХ СТОЙКИ        " -ForegroundColor Cyan
Write-Host "   Проверка и открытие интерфейса Magisk для настройки Root     " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$localPlatformTools = Join-Path $PSScriptRoot "platform-tools"
$rootPlatformTools = Join-Path $PSScriptRoot "..\..\platform-tools"

if (Test-Path (Join-Path $localPlatformTools "adb.exe")) {
    $env:PATH = "$localPlatformTools;$env:PATH"
} elseif (Test-Path (Join-Path $rootPlatformTools "adb.exe")) {
    $env:PATH = "$rootPlatformTools;$env:PATH"
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Write-Host "[ОШИБКА] adb.exe не найден!" -ForegroundColor Red
    Read-Host "Нажмите Enter для выхода..."
    exit 1
}

Write-Host "Поиск подключенных плат в стойке..." -ForegroundColor Yellow
$rawDevices = & adb devices -l
$total = 0
$rooted = 0
$noroot = 0
$problemSerials = @()

foreach ($line in $rawDevices) {
    if ($line -match "^([^\s]+)\s+device\b") {
        $serial = $matches[1]
        $total++
        Write-Host "----------------------------------------------------" -ForegroundColor DarkGray
        Write-Host "[$total] Плата: $serial" -ForegroundColor White

        # Безопасная проверка su (БЕЗ adb root, чтобы не ронять Samsung adbd)
        $rootCheck = (& adb -s $serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || id 2>&1 || true") -join " "
        
        if ($rootCheck -match "uid=0\(") {
            $rooted++
            Write-Host "  [OK - ROOT] Суперпользователь АКТИВЕН (uid=0). TikTok будет работать через прокси!" -ForegroundColor Green
        } else {
            $noroot++
            $problemSerials += $serial
            Write-Host "  [ВНИМАНИЕ - НЕТ ROOT] Shell получил отказ: $rootCheck" -ForegroundColor Red
            Write-Host "  ==> Открываем Magisk на экране этой платы..." -ForegroundColor Yellow
            & adb -s $serial shell "monkey -p com.topjohnwu.magisk 1 >/dev/null 2>&1; am start -n com.topjohnwu.magisk/.ui.MainActivity >/dev/null 2>&1" 2>$null | Out-Null
            Write-Host "  ==> В Magisk на телефоне: Шестеренка (вверху справа) > 'Доступ суперпользователя'" -ForegroundColor Yellow
            Write-Host "  ==> Выберите: 'Приложения и ADB'" -ForegroundColor Yellow
        }

        # Проверка sing-box
        $sbPid = ("$(& adb -s $serial shell 'pidof sing-box 2>/dev/null')").Trim()
        if ($sbPid) {
            Write-Host "  [OK - ДВИЖОК] sing-box активен (PID: $sbPid)" -ForegroundColor Green
        } else {
            Write-Host "  [ИНФО] sing-box ожидает назначения прокси или прав root" -ForegroundColor Gray
        }
        Write-Host ""
    }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "ИТОГИ ДИАГНОСТИКИ ROOT:" -ForegroundColor Cyan
Write-Host "  Всего плат в стойке:  $total" -ForegroundColor White
Write-Host "  С активным Root (OK): $rooted (готовность к TikTok: 100%)" -ForegroundColor Green
Write-Host "  Без прав Root:        $noroot (требуется включить в Magisk)" -ForegroundColor $(if ($noroot -gt 0) { "Red" } else { "Green" })
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

if ($problemSerials.Count -gt 0) {
    Write-Host "Платы без Root: $($problemSerials -join ', ')" -ForegroundColor Yellow
    Write-Host "На каждой из этих плат на экране УЖЕ открыто приложение Magisk." -ForegroundColor White
    Write-Host "Вам нужно лишь зайти в Настройки Magisk (шестеренка) и выбрать 'Приложения и ADB'." -ForegroundColor White
}

Read-Host "Нажмите Enter для завершения..."
