#!/usr/bin/env bash
# ==============================================================================
# KMMZAVOD - Phone Farm Network Routing Setup for AmneziaWG (awg0)
# Запустите на сервере: sudo bash setup-server-routing.sh
# ==============================================================================

set -e

echo "=== [1/3] Включение форвардинга пакетов в ядре Linux ==="
sysctl -w net.ipv4.ip_forward=1 >/dev/null
grep -qxF 'net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

echo "=== [2/3] Настройка iptables MASQUERADE для awg0 (Docker -> Farm PC) ==="
# Разрешаем контейнерам Docker выходить в интерфейс awg0
iptables -I FORWARD -o awg0 -j ACCEPT 2>/dev/null || true
iptables -I FORWARD -i awg0 -j ACCEPT 2>/dev/null || true

# Включаем MASQUERADE, чтобы пакеты из Docker (172.18.0.x) выходили в туннель с IP сервера (10.66.66.1)
# Это критично, иначе WireGuard на Windows отбросит пакеты как несоответствующие AllowedIPs
if ! iptables -t nat -C POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE
    echo "[OK] Правило NAT MASQUERADE для awg0 добавлено."
else
    echo "[OK] Правило NAT MASQUERADE для awg0 уже существует."
fi

echo "=== [3/3] Проверка доступности ПК с фермой телефонов (10.66.66.2:8300) ==="
if curl -s -m 5 http://10.66.66.2:8300/health >/dev/null; then
    echo "✅ [УСПЕХ] ПК с фермой отвечает на http://10.66.66.2:8300/health!"
    echo "Список плат с агента:"
    curl -s http://10.66.66.2:8300/devices | grep -o '"serial":"[^"]*"' || true
else
    echo "⚠️  ПК 10.66.66.2:8300 пока не отвечает."
    echo "Убедитесь, что:"
    echo "1. AmneziaWG подключен на Windows."
    echo "2. start-farm.bat запущен на ПК."
    echo "3. Брандмауэр Windows не блокирует порт 8300."
fi

echo ""
echo "=== Готово! Теперь перезапустите api-контейнер: ==="
echo "docker compose up -d api"
