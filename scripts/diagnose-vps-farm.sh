#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — diagnose-vps-farm.sh
#  Комплексная диагностика и автоисправление телефонной фермы на VPS (Ubuntu 24.04)
#
#  Использование:
#    bash scripts/diagnose-vps-farm.sh         # Полная диагностика с автофиксами
#    bash scripts/diagnose-vps-farm.sh --dry   # Только отчёт без изменения настроек
#    bash scripts/diagnose-vps-farm.sh --fix   # Принудительно применить все сетевые фиксы
# =============================================================================

set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
RESET='\033[0m'

ok()     { echo -e "  ${GREEN}✔  $*${RESET}"; ((PASS++)) || true; }
fail()   { echo -e "  ${RED}✖  $*${RESET}"; ((FAIL++)) || true; }
warn()   { echo -e "  ${YELLOW}⚠  $*${RESET}"; ((WARN++)) || true; }
fixed()  { echo -e "  ${CYAN}⚙  ИСПРАВЛЕНО: $*${RESET}"; ((FIXED++)) || true; }
info()   { echo -e "  ${BLUE}▶  $*${RESET}"; }
header() { echo -e "\n${BOLD}${MAGENTA}══  $*  ══${RESET}"; }

PASS=0
FAIL=0
WARN=0
FIXED=0
AUTO_FIX=true

for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run) AUTO_FIX=false ;;
    --fix)           AUTO_FIX=true ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env"

env_get() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }

echo -e "\n${BOLD}${BLUE}======================================================${RESET}"
echo -e "${BOLD}${BLUE}   kmmzavod — Диагностика фермы телефонов (VPS)      ${RESET}"
echo -e "${BOLD}${BLUE}======================================================${RESET}"
echo -e "  Сервер:    $(hostname 2>/dev/null || echo 'VPS') ($(uname -r 2>/dev/null || echo 'Linux'))"
echo -e "  Корень:    $REPO_ROOT"
echo -e "  Автофикс:  $([ "$AUTO_FIX" = true ] && echo -e "${GREEN}Включен${RESET}" || echo -e "${YELLOW}Отключен (--dry)${RESET}")"
echo -e "  Время:     $(date '+%Y-%m-%d %H:%M:%S')"

# =============================================================================
# 1. Ядро Linux и форвардинг пакетов (IP Forwarding)
# =============================================================================
header "1. Ядро Linux и сетевой стек"

IS_ROOT=false
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=true
  ok "Скрипт запущен с правами root"
else
  warn "Скрипт запущен без sudo/root — автоисправление системных параметров ядра может потребовать пароль"
fi

IP_FWD=$(sysctl -n net.ipv4.ip_forward 2>/dev/null || cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo "0")
if [ "$IP_FWD" = "1" ]; then
  ok "net.ipv4.ip_forward = 1 (форвардинг включен)"
else
  fail "net.ipv4.ip_forward = $IP_FWD (пакеты из Docker не будут пересылаться в VPN к ферме)"
  if [ "$AUTO_FIX" = true ]; then
    if [ "$IS_ROOT" = true ]; then
      sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
      if ! grep -qxF 'net.ipv4.ip_forward=1' /etc/sysctl.conf 2>/dev/null; then
        echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf 2>/dev/null || true
      fi
      fixed "Включен net.ipv4.ip_forward=1 в sysctl"
    else
      warn "Для исправления выполните: sudo sysctl -w net.ipv4.ip_forward=1"
    fi
  fi
fi

# Проверка модуля AmneziaWG / WireGuard
if lsmod | grep -qE "amneziawg|wireguard"; then
  MODULE_NAME=$(lsmod | grep -oE "amneziawg|wireguard" | head -1)
  ok "Модуль ядра '$MODULE_NAME' загружен"
else
  warn "Модуль ядра amneziawg/wireguard не найден в lsmod (возможно используется userspace go-wireguard)"
fi

# =============================================================================
# 2. Состояние VPN-туннеля AmneziaWG (awg0)
# =============================================================================
header "2. Сетевой туннель AmneziaWG (awg0)"

AWG_IF_EXISTS=false
AWG_TOOL=""

if command -v awg &>/dev/null; then
  AWG_TOOL="awg"
elif command -v wg &>/dev/null; then
  AWG_TOOL="wg"
fi

if ip link show awg0 &>/dev/null; then
  AWG_IF_EXISTS=true
  AWG_IP=$(ip -4 addr show awg0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 || echo "не назначен")
  ok "Интерфейс awg0 поднят (IP сервера: $AWG_IP)"
else
  fail "Интерфейс awg0 не найден в системе"
  if [ "$AUTO_FIX" = true ] && [ "$IS_ROOT" = true ]; then
    info "Попытка запуска службы awg-quick@awg0..."
    if systemctl start awg-quick@awg0 2>/dev/null || wg-quick up awg0 2>/dev/null; then
      fixed "Служба awg-quick@awg0 успешно запущена"
      AWG_IF_EXISTS=true
    else
      warn "Не удалось запустить awg-quick@awg0 автоматически. Проверьте конфиг /etc/amnezia/amneziawg/awg0.conf"
    fi
  fi
fi

HANDSHAKE_OK=false
if [ "$AWG_IF_EXISTS" = true ] && [ -n "$AWG_TOOL" ]; then
  AWG_STATUS=$($AWG_TOOL show awg0 2>/dev/null || true)
  if [ -n "$AWG_STATUS" ]; then
    PEER_ENDPOINT=$(echo "$AWG_STATUS" | grep "endpoint:" | awk '{print $2}' || true)
    LATEST_HS=$(echo "$AWG_STATUS" | grep "latest handshake:" | cut -d: -f2- | xargs || true)
    TRANSFER=$(echo "$AWG_STATUS" | grep "transfer:" | cut -d: -f2- | xargs || true)

    if [ -n "$PEER_ENDPOINT" ]; then
      info "Пир ПК фермы endpoint: $PEER_ENDPOINT"
    fi

    if [ -n "$LATEST_HS" ]; then
      ok "WireGuard рукопожатие (handshake): $LATEST_HS назад (трафик: $TRANSFER)"
      HANDSHAKE_OK=true
    else
      fail "Нет установленного рукопожатия с ПК фермы! ПК с фермой не подключился к серверу."
      info "Проверьте, что в AmneziaWG клиенте на Windows туннель включен и статус 'Connected'."
    fi
  fi
fi

# =============================================================================
# 3. Маршрутизация iptables (MASQUERADE для awg0)
# =============================================================================
header "3. Правила межсетевого экрана (iptables)"

if [ "$AWG_IF_EXISTS" = true ]; then
  NAT_MASQ_EXISTS=false
  if iptables -t nat -C POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null; then
    NAT_MASQ_EXISTS=true
    ok "iptables POSTROUTING -o awg0 -j MASQUERADE активно"
  else
    fail "Правило MASQUERADE для awg0 отсутствует в таблице nat"
    if [ "$AUTO_FIX" = true ]; then
      if [ "$IS_ROOT" = true ]; then
        iptables -I FORWARD -o awg0 -j ACCEPT 2>/dev/null || true
        iptables -I FORWARD -i awg0 -j ACCEPT 2>/dev/null || true
        iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null || true
        fixed "Добавлено правило iptables MASQUERADE и ACCEPT для awg0"
        NAT_MASQ_EXISTS=true
      else
        warn "Для исправления выполните: sudo iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE"
      fi
    fi
  fi

  # Проверка правил FORWARD
  if iptables -C FORWARD -o awg0 -j ACCEPT 2>/dev/null; then
    ok "iptables FORWARD -o awg0 -j ACCEPT активно"
  else
    if [ "$AUTO_FIX" = true ] && [ "$IS_ROOT" = true ]; then
      iptables -I FORWARD -o awg0 -j ACCEPT 2>/dev/null || true
      fixed "Добавлено iptables -I FORWARD -o awg0 -j ACCEPT"
    fi
  fi
fi

# =============================================================================
# 4. Проверка доступности ПК фермы (Ping & HTTP)
# =============================================================================
header "4. Связь с ПК фермы телефонов"

CANDIDATES=("10.66.66.2" "10.13.13.2")
ACTIVE_IP=""
ACTIVE_URL=""

for ip in "${CANDIDATES[@]}"; do
  info "Проверка адреса $ip..."
  
  # Пинг
  if ping -c 1 -W 2 "$ip" &>/dev/null; then
    ok "Ping до $ip успешен"
  else
    warn "Ping до $ip не прошел (ICMP может быть заблокирован брандмауэром Windows)"
  fi

  # HTTP /health
  HEALTH_RESP=$(curl -sf --connect-timeout 2 --max-time 3 "http://$ip:8300/health" 2>/dev/null || true)
  if [ -n "$HEALTH_RESP" ]; then
    ok "HTTP /health на http://$ip:8300 отвечает: $HEALTH_RESP"
    ACTIVE_IP="$ip"
    ACTIVE_URL="http://$ip:8300"
    break
  fi
done

if [ -z "$ACTIVE_URL" ]; then
  fail "device-agent не отвечает ни по 10.66.66.2:8300, ни по 10.13.13.2:8300"
  echo ""
  info "Возможные причины:"
  info "  1. На ПК с фермой не запущен start-farm.bat."
  info "  2. AmneziaWG на ПК выключен или не подключен к этому серверу."
  info "  3. Брандмауэр Windows блокирует входящий порт 8300."
  info "     (На ПК выполните в PowerShell от админа: New-NetFirewallRule -DisplayName 'PhoneFarmAgent' -Direction Inbound -LocalPort 8300 -Protocol TCP -Action Allow)"
fi

# =============================================================================
# 5. Проверка доступа изнутри контейнеров Docker
# =============================================================================
header "5. Доступность фермы из Docker контейнеров (api & orchestrator)"

if [ -n "$ACTIVE_URL" ]; then
  CONTAINERS=("orchestrator" "api")
  for c in "${CONTAINERS[@]}"; do
    if docker compose ps -q "$c" 2>/dev/null | grep -q .; then
      DOCKER_CURL=$(docker compose exec -T "$c" curl -sf --connect-timeout 3 "$ACTIVE_URL/health" 2>/dev/null || true)
      if [ -n "$DOCKER_CURL" ]; then
        ok "Контейнер '$c' успешно связывается с $ACTIVE_URL/health"
      else
        fail "Контейнер '$c' НЕ может достучаться до $ACTIVE_URL/health!"
        warn "Это означает, что Docker bridge сеть не маскарадится в awg0."
        if [ "$AUTO_FIX" = true ] && [ "$IS_ROOT" = true ]; then
          iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null || true
          fixed "Принудительно обновлено правило NAT MASQUERADE для awg0"
        fi
      fi
    else
      warn "Контейнер '$c' не запущен в docker compose"
    fi
  done
else
  warn "Пропуск проверки Docker-контейнеров, так как хост не видит ПК фермы"
fi

# =============================================================================
# 6. Список подключенных плат Android (USB Phone Boards)
# =============================================================================
header "6. Статус USB-плат телефонов на ферме"

if [ -n "$ACTIVE_URL" ]; then
  DEVICES_JSON=$(curl -sf --connect-timeout 4 --max-time 8 "$ACTIVE_URL/devices" 2>/dev/null || true)
  if [ -n "$DEVICES_JSON" ]; then
    COUNT=$(echo "$DEVICES_JSON" | grep -o '"serial":"[^"]*"' | wc -l | tr -d ' ' || echo "0")
    if [ "$COUNT" -gt 0 ]; then
      ok "ПК фермы сообщает о $COUNT подключенных Android-платах:"
      echo ""
      # Выводим форматированный список устройств
      if command -v node &>/dev/null; then
        node -e '
          const data = JSON.parse(process.argv[1]);
          const devices = data.raw?.devices || [];
          const proxies = data.proxies || {};
          const apps = data.apps || {};
          console.log("  " + "ID / SERIAL".padEnd(20) + "МОДЕЛЬ".padEnd(16) + "АКБ / ТЕМП".padEnd(14) + "ПРОКСИ".padEnd(14) + "TIKTOK");
          console.log("  " + "-".repeat(70));
          devices.forEach(d => {
            const sid = (d.serial || d.id || "").padEnd(20);
            const model = (d.model || "board").slice(0, 14).padEnd(16);
            const bat = (d.batteryLevel ? d.batteryLevel + "%" : "N/A") + (d.batteryTemp ? " " + d.batteryTemp + "C" : "");
            const prx = proxies[d.serial] ? proxies[d.serial].type || "configured" : "none";
            const tt = apps[d.serial]?.tiktok?.installed ? "✔ да" : "- нет";
            console.log("  " + sid + model + bat.padEnd(14) + prx.padEnd(14) + tt);
          });
        ' "$DEVICES_JSON" 2>/dev/null || echo "$DEVICES_JSON" | grep -o '"serial":"[^"]*"'
      else
        echo "$DEVICES_JSON" | grep -o '"serial":"[^"]*"' | sed 's/"serial":/    Плата: /'
      fi
      echo ""
    else
      warn "device-agent активен, но список устройств пуст (adb devices = 0)."
      info "Убедитесь, что USB-хабы включены и платы запитаны."
    fi
  else
    fail "Не удалось получить ответ от $ACTIVE_URL/devices"
  fi
fi

# =============================================================================
# 7. Конфигурация AstroProxy и прокси
# =============================================================================
header "7. Конфигурация прокси (AstroProxy)"

ASTRO_TOKEN="$(env_get ASTROPROXY_API_TOKEN 2>/dev/null || true)"
if [ -n "$ASTRO_TOKEN" ]; then
  ok "ASTROPROXY_API_TOKEN задан в .env"
  # Быстрая проверка токена
  ASTRO_CHECK=$(curl -sf --connect-timeout 4 "https://api.astroproxy.com/v1/user?token=$ASTRO_TOKEN" 2>/dev/null || true)
  if [ -n "$ASTRO_CHECK" ] && ! echo "$ASTRO_CHECK" | grep -qi "error"; then
    ok "AstroProxy API токен валиден и отвечает"
  else
    warn "AstroProxy API вернул ошибку или недоступен"
  fi
else
  info "ASTROPROXY_API_TOKEN не настроен в .env (используется локальный или статический прокси)"
fi

# =============================================================================
# Итоги и рекомендации
# =============================================================================
header "Итоги диагностики"

echo -e "  Успешно проверок:     ${GREEN}$PASS${RESET}"
echo -e "  Ошибок (FAIL):        ${RED}$FAIL${RESET}"
echo -e "  Предупреждений (WARN): ${YELLOW}$WARN${RESET}"
echo -e "  Автоисправлений:      ${CYAN}$FIXED${RESET}"
echo ""

if [ "$FAIL" -eq 0 ] && [ -n "$ACTIVE_URL" ]; then
  echo -e "${GREEN}${BOLD}✔ Ферма телефонов полностью доступна и готова к работе!${RESET}"
  echo -e "  Активный эндпоинт фермы: ${CYAN}$ACTIVE_URL${RESET}"
elif [ -n "$ACTIVE_URL" ]; then
  echo -e "${YELLOW}${BOLD}⚠ Связь с фермой есть, но обнаружены замечания (см. предупреждения выше).${RESET}"
else
  echo -e "${RED}${BOLD}✖ Ферма телефонов недоступна. Выполните шаги ниже:${RESET}"
  echo ""
  echo -e "  1. На ПК с фермой (Windows):"
  echo -e "     - Убедитесь, что AmneziaWG подключен к этому серверу."
  echo -e "     - Запустите двойным кликом: ${BOLD}apps\\device-agent\\start-farm.bat${RESET}"
  echo -e "     - Запустите PowerShell скрипт диагностики: ${BOLD}powershell -File apps\\device-agent\\diagnose-rack.ps1${RESET}"
  echo ""
  echo -e "  2. На сервере (VPS):"
  echo -e "     - Перезапустите сетевую маршрутизацию: ${BOLD}sudo bash infra/amneziawg/setup-server-routing.sh${RESET}"
  echo -e "     - Перезапустите контейнеры: ${BOLD}docker compose up -d api orchestrator${RESET}"
fi

echo ""
exit $FAIL
