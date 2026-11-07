<#
.SYNOPSIS
    KMMZAVOD - Помощник быстрой разблокировки Root в Magisk для проблемных плат
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "KMMZAVOD - Разблокировка Root в Magisk"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - РАЗБЛОКИРОВКА ROOT В MAGISK ДЛЯ 5 ПЛАТ           " -ForegroundColor Cyan
Write-Host "   Решение ошибки 'Shell was denied superuser rights'           " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$localPlatformTools = Join-Path $PSScriptRoot "platform-tools"
$rootPlatformTools = Join-Path $PSScriptRoot "..\..\platform-tools"

if (Test-Path (Join-Path $localPlatformTools "adb.exe")) {
    $env:PATH = "$localPlatformTools;$env:PATH"
} elseif (Test-Path (Join-Path $rootPlatformTools "adb.exe")) {
    $env:PATH = "$rootPlatformTools;$env:PATH"
}

# 5 проблемных серийников
$problemSerials = @(
    "9889543657374c5a44",
    "98895444505a4a5945",
    "98895a36533756304e",
    "98899a344f4331584c",
    "988a1b335850334a52"
)

Write-Host "ПОЧЕМУ ВОЗНИКЛА ОШИБКА 'Shell was denied superuser rights':" -ForegroundColor Yellow
Write-Host "В настройках Magisk включен пункт 'Приложения и ADB', НО во вкладке" -ForegroundColor White
Write-Host "СУПЕРПОЛЬЗОВАТЕЛЬ (иконка ЩИТА внизу экрана) для компонента Shell" -ForegroundColor White
Write-Host "сохранился индивидуальный запрет (тумблер выключен)!" -ForegroundColor White
Write-Host ""
Write-Host "ИНСТРУКЦИЯ ПО ИСПРАВЛЕНИЮ (2 клика):" -ForegroundColor Cyan
Write-Host "  Способ 1: Внизу Magisk нажмите на ЩИТ -> найдите Shell -> включите тумблер (ВКЛ)." -ForegroundColor Green
Write-Host "  Способ 2: В Настройках Magisk (шестеренка) -> 'Автоматический ответ' -> 'Предоставить'." -ForegroundColor Green
Write-Host ""

foreach ($serial in $problemSerials) {
    Write-Host "----------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "Проверка платы: $serial" -ForegroundColor White

    # Проверка текущего root
    $rootCheck = (& adb -s $serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || true") -join " "
    if ($rootCheck -match "uid=0\(") {
        Write-Host "  [OK] Root УЖЕ активен на этой плате!" -ForegroundColor Green
        continue
    }

    Write-Host "  [ОТКАЗ] $rootCheck" -ForegroundColor Red
    Write-Host "  Открываем Magisk на экране платы $serial..." -ForegroundColor Yellow
    & adb -s $serial shell "monkey -p com.topjohnwu.magisk 1 >/dev/null 2>&1; am start -n com.topjohnwu.magisk/.ui.MainActivity >/dev/null 2>&1" 2>$null | Out-Null

    # Запуск scrcpy если есть
    $scrcpy = Get-Command scrcpy -ErrorAction SilentlyContinue
    if (-not $scrcpy -and (Test-Path "$localPlatformTools\scrcpy.exe")) { $scrcpy = "$localPlatformTools\scrcpy.exe" }
    if ($scrcpy) {
        Write-Host "  Запуск окна управления scrcpy..." -ForegroundColor Cyan
        Start-Process $scrcpy -ArgumentList "-s $serial" -ErrorAction SilentlyContinue | Out-Null
    }

    Write-Host "  Ожидание включения Root в Magisk (включите тумблер Shell на экране)..." -ForegroundColor Yellow
    $fixed = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        $recheck = (& adb -s $serial shell "su -c 'id' 2>&1 || su 0 id 2>&1 || true") -join " "
        if ($recheck -match "uid=0\(") {
            $fixed = $true
            Write-Host "  [УСПЕХ] Root успешно активирован на плате $serial!" -ForegroundColor Green
            # Активация sing-box через агент
            try {
                Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/apply-device" -Method Post -Body (@{ deviceId = $serial } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
            } catch {}
            break
        }
    }

    if (-not $fixed) {
        Write-Host "  [ПРОПУСК] Root еще не включен. Вы сможете включить его позже." -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Завершено. Запустите diagnose-rack.bat для полной проверки." -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Read-Host "Нажмите Enter для завершения..."
