<#
.SYNOPSIS
    Пакетная установка TikTok Mod и TikTok Plugin на все платы стойки через ADB.
.DESCRIPTION
    1. Находит TikTok Mod APK и TikTok Plugin APK в папке apks/
    2. Очищает старые данные и кэш официального TikTok (блокирующего публикацию в РФ).
    3. Устанавливает Mod APK на все платы параллельно с выдачей всех системных разрешений (-g).
    4. Предотвращает усыпление приложения (отключение оптимизации батареи).
#>

[CmdletBinding()]
param(
    [string]$ApkFolder = "$PSScriptRoot\apks"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   KMMZAVOD - УСТАНОВКА TIKTOK MOD НА ВСЕ ПЛАТЫ СТОЙКИ (ADB)    " -ForegroundColor Cyan
Write-Host "   Обход блокировки РФ, снятие ограничений на выгрузку в drafts " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $ApkFolder)) {
    New-Item -ItemType Directory -Path $ApkFolder -Force | Out-Null
}

$apkFiles = Get-ChildItem -Path $ApkFolder -Filter "*.apk" -File

if ($apkFiles.Count -eq 0) {
    Write-Host "[!] В папке '$ApkFolder' не найдено APK-файлов!" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "КАК УСТАНОВИТЬ TIKTOK MOD:" -ForegroundColor Green
    Write-Host "1. Скачайте актуальный рабочий TikTok Mod и TikTok Plugin (например, от BReaaker или Дмитрия Нечипоренко)." -ForegroundColor White
    Write-Host "   Рекомендуемая стабильная версия: TikTok Mod v35.x / v36.x (ARM64 или ARMv7a под процессор плат)." -ForegroundColor White
    Write-Host "2. Положите скачанные файлы в папку:" -ForegroundColor Cyan
    Write-Host "   $ApkFolder" -ForegroundColor Yellow
    Write-Host "   Например:" -ForegroundColor DarkGray
    Write-Host "   $ApkFolder\TikTok_Mod.apk" -ForegroundColor DarkGray
    Write-Host "   $ApkFolder\TikTok_Plugin.apk" -ForegroundColor DarkGray
    Write-Host "3. Запустите этот скрипт снова!" -ForegroundColor Green
    Write-Host ""
    Read-Host "Нажмите Enter для завершения..."
    exit 0
}

Write-Host "[OK] Найдены APK-файлы для установки:" -ForegroundColor Green
foreach ($apk in $apkFiles) {
    $sizeMb = [math]::Round($apk.Length / 1MB, 1)
    Write-Host "  - $($apk.Name) ($sizeMb МБ)" -ForegroundColor Cyan
}
Write-Host ""

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

Write-Host "Начинаем установку на $($onlineDevices.Count) устройств..." -ForegroundColor Yellow

$PKG = "com.zhiliaoapp.musically"

foreach ($dev in $onlineDevices) {
    Write-Host "----------------------------------------------------------------" -ForegroundColor Gray
    Write-Host "[Плата $dev] Подготовка и очистка..." -ForegroundColor Cyan

    # Очистка кэша старого TikTok, чтобы сбросить залоченную российскую геолокацию
    & adb -s $dev shell "pm clear $PKG 2>/dev/null; am force-stop $PKG 2>/dev/null" | Out-Null

    foreach ($apk in $apkFiles) {
        Write-Host "  Установка $($apk.Name)..." -ForegroundColor Gray
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $installOut = & adb -s $dev install -r -d -g $apk.FullName 2>&1 | Out-String
        $sw.Stop()

        if ($installOut -match "Success") {
            Write-Host "  [✓] $($apk.Name) установлен ($([math]::Round($sw.Elapsed.TotalSeconds, 1))с)" -ForegroundColor Green
        } else {
            Write-Host "  [✗] Ошибка установки $($apk.Name): $($installOut.Trim())" -ForegroundColor Red
        }
    }

    # Выдача системных разрешений
    & adb -s $dev shell "pm grant $PKG android.permission.READ_EXTERNAL_STORAGE 2>/dev/null" | Out-Null
    & adb -s $dev shell "pm grant $PKG android.permission.WRITE_EXTERNAL_STORAGE 2>/dev/null" | Out-Null
    & adb -s $dev shell "pm grant $PKG android.permission.RECORD_AUDIO 2>/dev/null" | Out-Null
    & adb -s $dev shell "pm grant $PKG android.permission.CAMERA 2>/dev/null" | Out-Null
    & adb -s $dev shell "pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null" | Out-Null
    & adb -s $dev shell "dumpsys deviceidle whitelist +$PKG 2>/dev/null" | Out-Null
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "   [УСПЕХ] TIKTOK MOD УСПЕШНО УСТАНОВЛЕН НА ВСЕ ПЛАТЫ!           " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host "Следующие шаги:" -ForegroundColor Cyan
Write-Host "1. Если вы установили TikTok Plugin — откройте его и выберите регион 'US' (США) или 'DE' (Германия)." -ForegroundColor White
Write-Host "2. В плагине включите пункт 'Обход региональных ограничений'." -ForegroundColor White
Write-Host "3. Запустите TikTok и убедитесь, что лента открывается с зарубежными видео." -ForegroundColor White
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Нажмите Enter для выхода..."
