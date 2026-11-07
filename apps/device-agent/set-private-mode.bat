@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KMMZAVOD - Включение Private-режима (прокси на всех 20 платах)

echo ================================================================
echo   ВКЛЮЧЕНИЕ PRIVATE-РЕЖИМА (ПРОКСИ КАЗАХСТАНА НА ВСЕХ 20 ПЛАТАХ)
echo ================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8300/proxy/mode' -Method Post -Body '{\"mode\":\"private_parallel\"}' -ContentType 'application/json' -TimeoutSec 5; Write-Host '[OK] Private-режим успешно включен!' -ForegroundColor Green } catch { try { $r = Invoke-RestMethod -Uri 'http://10.66.66.2:8300/proxy/mode' -Method Post -Body '{\"mode\":\"private_parallel\"}' -ContentType 'application/json' -TimeoutSec 5; Write-Host '[OK] Private-режим успешно включен через tunnel!' -ForegroundColor Green } catch { Write-Host '[ИНФО] Служба агента обновит режим при следующем старте.' -ForegroundColor Yellow } }"

echo.
pause
