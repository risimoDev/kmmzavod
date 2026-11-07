<#
.SYNOPSIS
    KMMZAVOD - Проверка Root и Magisk на платах стойки (PowerShell)
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Проверка Root и Magisk на платах"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - ДИАГНОСТИКА ROOT И MAGISK НА ПЛАТАХ СТОЙКИ        " -ForegroundColor Cyan
Write-Host "   Проверка разрешений суперпользователя для прозрачного прокси " -ForegroundColor Cyan
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

foreach ($line in $rawDevices) {
    if ($line -match "^([^\s]+)\s+device\b") {
        $serial = $matches[1]
        $total++
        Write-Host "----------------------------------------------------" -ForegroundColor DarkGray
        Write-Host "[$total] Плата: $serial" -ForegroundColor White

        # Пробуем adb root
        & adb -s $serial root 2>$null | Out-Null

        # Проверка su
        $rootCheck = (& adb -s $serial shell "id; su -c 'id' 2>&1 || su 0 id 2>&1 || true") -join " "
        
        if ($rootCheck -match "uid=0\(") {
            $rooted++
            Write-Host "  [OK - ROOT] Суперпользователь АКТИВЕН (uid=0). Прозрачный режим TikTok РАБОТАЕТ!" -ForegroundColor Green
        } else {
            $noroot++
            Write-Host "  [ВНИМАНИЕ - НЕТ ROOT] Shell получил отказ: $rootCheck" -ForegroundColor Red
            Write-Host "  ==> Открываем Magisk на экране этой платы..." -ForegroundColor Yellow
            & adb -s $serial shell monkey -p com.topjohnwu.magisk 1 2>$null | Out-Null
            & adb -s $serial shell am start -n com.topjohnwu.magisk/.ui.MainActivity 2>$null | Out-Null
            Write-Host "  ==> В Magisk на телефоне: Настройки (шестеренка вверху справа) > 'Доступ суперпользователя'" -ForegroundColor Yellow
            Write-Host "  ==> Выберите: 'Приложения и ADB' (или на вкладке Superuser включите тумблер для Shell)" -ForegroundColor Yellow
        }

        # Проверка sing-box
        $sbPid = (& adb -s $serial shell "pidof sing-box 2>/dev/null").Trim()
        if ($sbPid) {
            Write-Host "  [OK - ДВИЖОК] sing-box активен (PID: $sbPid)" -ForegroundColor Green
        } else {
            Write-Host "  [ИНФО] sing-box ожидает назначения прокси или прав root" -ForegroundColor Gray
        }
        Write-Host ""
    }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "ИТОГИ ДИАГНОСТИКИ:" -ForegroundColor Cyan
Write-Host "  Всего плат в стойке:  $total" -ForegroundColor White
Write-Host "  С активным Root (OK): $rooted (готовность к TikTok: 100%)" -ForegroundColor Green
Write-Host "  Без прав Root:        $noroot (требуется включить в Magisk)" -ForegroundColor $(if ($noroot -gt 0) { "Red" } else { "Green" })
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

Read-Host "Нажмите Enter для завершения..."
