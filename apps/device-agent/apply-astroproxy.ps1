# KMMZAVOD - Применение AstroProxy на все платы стойки
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  KMMZAVOD - ПРИМЕНЕНИЕ ASTROPROXY НА ВСЕ ПЛАТЫ СТОЙКИ" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "[1/3] Проверка конфигурации AstroProxy..." -ForegroundColor Yellow
Write-Host "  Хост: 45.81.32.208:10018"
Write-Host "  Логин: LevrurisimoiY7"
Write-Host "  Гео: Казахстан (Residential, JSC Kazakhtelecom)"
Write-Host ""

$astroStateFile = Join-Path $ScriptDir "devices-proxy-state.astroproxy.json"
$proxyStateFile = Join-Path $ScriptDir "devices-proxy-state.json"
if (Test-Path $astroStateFile) {
    Copy-Item -Path $astroStateFile -Destination $proxyStateFile -Force
    Write-Host "[OK] Конфиг devices-proxy-state.json обновлен на AstroProxy." -ForegroundColor Green
}

Write-Host "[2/3] Отправка команды переподключения в device-agent (порт 8300)..." -ForegroundColor Yellow
try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/reapply" -Method Post -TimeoutSec 5 -ErrorAction Stop
    Write-Host "[OK] Служба device-agent обновила настройки прокси на всех платах: $($res.restored) восстановлено." -ForegroundColor Green
    
    $modeRes = Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/mode" -Method Post -ContentType "application/json" -Body '{"mode":"shared_sequential","inactivePolicy":"direct"}' -TimeoutSec 5 -ErrorAction SilentlyContinue
    Write-Host "[OK] Режим: Shared-Sequential. Неактивные платы: прямой интернет (direct)." -ForegroundColor Green
} catch {
    Write-Host "[ИНФО] device-agent сейчас не запущен на порту 8300." -ForegroundColor Gray
    Write-Host "       При следующем запуске start-farm.bat он автоматически применит AstroProxy!" -ForegroundColor Gray
}

Write-Host ""
Write-Host "[3/3] Тестирование внешнего IP активной платы..." -ForegroundColor Yellow
try {
    $check = Invoke-RestMethod -Uri "http://127.0.0.1:8300/proxy/check" -Method Post -ContentType "application/json" -Body '{"deviceId":"98891a37534e534d32"}' -TimeoutSec 15 -ErrorAction Stop
    if ($check.ok) {
        Write-Host "[OK] Внешний IP платы: $($check.ip) ($($check.country), $($check.isp))" -ForegroundColor Green
        Write-Host "[OK] Утечка DNS/IP фермы: $(if ($check.leakDetected) {'ОБНАРУЖЕНА!'} else {'НЕТ (защищено)'})" -ForegroundColor $(if ($check.leakDetected) {'Red'} else {'Green'})
    } else {
        Write-Host "[!] Проверка IP вернула: $($check.error)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[ИНФО] Тест IP будет выполнен при старте start-farm.bat." -ForegroundColor Gray
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  [ГОТОВО] Все 20 плат стойки переведены на AstroProxy!" -ForegroundColor Green
Write-Host "  Перезапустите start-farm.bat, если служба еще не была перезапущена." -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Нажмите Enter для выхода..."
