#!/usr/bin/env bash
# ==============================================================================
# KMMZAVOD - НАСТРОЙКА РЕЛЕЙ-ПРОБРОСА ПРОКСИ НА ГЛАВНОМ NL ПРОД-СЕРВЕРЕ (H10)
# ==============================================================================
# Запускается на главном сервере (Нидерланды), к которому ПК фермы подключен
# через AmneziaWG (туннельный адрес 10.66.66.1 или 10.8.0.1).
#
# Скрипт пробрасывает порты 11001..11020 внутри защищенного туннеля на 20 VPS.
# Российский ТСПУ/DPI видит ТОЛЬКО зашифрованный трафик AmneziaWG к NL серверу,
# а незашифрованные SOCKS5-запросы ходят только между Нидерландами и 20 VPS.
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ОШИБКА] Запустите скрипт с правами root: sudo bash $0 <файл_с_vps.txt>${NC}"
  exit 1
fi

INPUT_FILE=${1:-"vps-list.txt"}
START_PORT=${2:-11001}
TUNNEL_IP=${3:-""}

# Автоопределение IP туннеля AmneziaWG/WireGuard на главном сервере
if [ -z "$TUNNEL_IP" ]; then
  TUNNEL_IP=$(ip -o -4 addr show | grep -E 'awg|wg|amnezia' | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)
  if [ -z "$TUNNEL_IP" ]; then
    TUNNEL_IP="10.66.66.1"
  fi
fi

# Внешний IP главного сервера (для настройки ALLOW_IP на 20 VPS)
PROD_PUBLIC_IP=$(curl -s -4 ifconfig.me || ip route get 8.8.8.8 | awk '{print $7}')

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   KMMZAVOD - НАСТРОЙКА РЕЛЕЙ-ПРОБРОСА ЧЕРЕЗ NL СЕРВЕР (DPI-SAFE)${NC}"
echo -e "${CYAN}================================================================${NC}"
echo -e "IP туннеля (AmneziaWG): ${GREEN}${TUNNEL_IP}${NC}"
echo -e "Внешний IP NL сервера:  ${GREEN}${PROD_PUBLIC_IP}${NC}"
echo ""

if [ ! -f "$INPUT_FILE" ]; then
  echo -e "${YELLOW}Файл $INPUT_FILE не найден. Создайте его со списком 20 VPS в формате:${NC}"
  echo -e "IP:PORT:USER:PASS  (или просто IP)"
  echo ""
  echo "Пример:"
  echo "185.12.34.56:1080:kmmuser:mypassword123"
  echo "185.12.34.57:1080:kmmuser:mypassword123"
  exit 1
fi

echo -e "${YELLOW}[1/3] Включение IP Forwarding...${NC}"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
if ! grep -q "^net.ipv4.ip_forward=1" /etc/sysctl.conf /etc/sysctl.d/* 2>/dev/null; then
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.d/99-kmmzavod-relay.conf
fi

echo -e "${YELLOW}[2/3] Настройка iptables правил DNAT...${NC}"

# Очистка предыдущих правил kmm-relay если были
iptables -t nat -D PREROUTING -m comment --comment "kmm-relay" -j ACCEPT 2>/dev/null || true

RELAY_OUT_FILE="vps-proxies-tunnel.txt"
> "$RELAY_OUT_FILE"

INDEX=0
while IFS= read -r line || [ -n "$line" ]; do
  # Пропуск пустых строк и комментариев
  [[ -z "$line" || "$line" =~ ^# ]] && continue

  # Парсинг строки: [SERIAL=]IP[:PORT[:USER:PASS]]
  clean_line=$(echo "$line" | sed 's/^[a-zA-Z0-9_-]*=//')
  IFS=':' read -r vIP vPORT vUSER vPASS <<< "$clean_line"

  vPORT=${vPORT:-1080}
  vUSER=${vUSER:-kmmuser}
  vPASS=${vPASS:-""}

  RELAY_PORT=$((START_PORT + INDEX))

  # Добавление DNAT правила
  iptables -t nat -A PREROUTING -d "$TUNNEL_IP" -p tcp --dport "$RELAY_PORT" \
    -m comment --comment "kmm-relay" -j DNAT --to-destination "${vIP}:${vPORT}"

  iptables -t nat -A POSTROUTING -d "$vIP" -p tcp --dport "$vPORT" \
    -m comment --comment "kmm-relay" -j MASQUERADE

  iptables -A FORWARD -d "$vIP" -p tcp --dport "$vPORT" \
    -m comment --comment "kmm-relay" -j ACCEPT

  echo "${TUNNEL_IP}:${RELAY_PORT}:${vUSER}:${vPASS}" >> "$RELAY_OUT_FILE"
  echo -e "  [${INDEX}] Проброс порта ${CYAN}${TUNNEL_IP}:${RELAY_PORT}${NC} -> ${vIP}:${vPORT}"

  INDEX=$((INDEX + 1))
done < "$INPUT_FILE"

echo -e "${YELLOW}[3/3] Сохранение правил iptables...${NC}"
if command -v netfilter-persistent &>/dev/null; then
  netfilter-persistent save >/dev/null 2>&1 || true
elif command -v iptables-save &>/dev/null; then
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}   НАСТРОЙКА УСПЕШНО ЗАВЕРШЕНА!                                 ${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "Сгенерирован файл: ${CYAN}${RELAY_OUT_FILE}${NC}"
echo -e "Скопируйте его содержимое в ${YELLOW}apps/device-agent/vps-proxies.txt${NC} на ПК фермы."
echo ""
echo -e "${YELLOW}ВАЖНО: При установке Dante на 20 VPS укажите параметр ALLOW_IP:${NC}"
echo -e "${CYAN}sudo bash vps-setup-proxy.sh 1080 kmmuser <ПАРОЛЬ> ${PROD_PUBLIC_IP}${NC}"
echo -e "Тогда прокси будут доступны ТОЛЬКО с этого NL сервера, полностью защищены от сканеров."
