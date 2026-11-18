#!/usr/bin/env bash
# ==============================================================================
# KMMZAVOD - НАСТРОЙКА РЕЛЕЙ-ПРОБРОСА ПРОКСИ НА ГЛАВНОМ NL ПРОД-СЕРВЕРЕ (H10)
# ==============================================================================
# Запускается на главном сервере (Нидерланды), к которому ПК фермы подключен
# через AmneziaWG (туннельный адрес 10.66.66.1 или 10.8.0.1).
#
# Скрипт пробрасывает порты 11001..110NN внутри защищенного туннеля на VPS.
# Российский ТСПУ/DPI видит ТОЛЬКО зашифрованный трафик AmneziaWG к NL серверу,
# а незашифрованные SOCKS5-запросы ходят только между Нидерландами и VPS.
#
# Все правила живут в собственных цепочках KMM_RELAY_*, которые при каждом
# запуске очищаются и заполняются заново — повторный запуск и смена списка VPS
# не оставляют старых правил.
#
# Использование:
#   sudo bash prod-setup-proxy-relay.sh <файл_с_vps> [начальный_порт] [IP_туннеля]
#   sudo bash prod-setup-proxy-relay.sh --remove        # снять все правила релея
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

NAT_PRE="KMM_RELAY_PRE"     # nat: DNAT туннель -> VPS
NAT_POST="KMM_RELAY_POST"   # nat: MASQUERADE в сторону VPS
FWD="KMM_RELAY_FWD"         # filter: разрешение транзита в обе стороны
RULES_FILE="/etc/kmmzavod/relay.rules"
UNIT_FILE="/etc/systemd/system/kmm-proxy-relay.service"

# Цепочка FORWARD, в которую вешаем переход. На хосте с Docker политика FORWARD = DROP,
# а пользовательские правила должны идти через DOCKER-USER (она проверяется первой).
forward_hook_chain() {
  if iptables -nL DOCKER-USER >/dev/null 2>&1; then echo "DOCKER-USER"; else echo "FORWARD"; fi
}

# Создать (если нет) и очистить цепочку; добавить переход на неё ровно один раз.
ensure_chain() { # table chain parent
  local table=$1 chain=$2 parent=$3
  iptables -t "$table" -N "$chain" 2>/dev/null || true
  iptables -t "$table" -F "$chain"
  iptables -t "$table" -C "$parent" -j "$chain" 2>/dev/null || iptables -t "$table" -I "$parent" 1 -j "$chain"
}

remove_chain() { # table chain parent
  local table=$1 chain=$2 parent=$3
  while iptables -t "$table" -D "$parent" -j "$chain" 2>/dev/null; do :; done
  iptables -t "$table" -F "$chain" 2>/dev/null || true
  iptables -t "$table" -X "$chain" 2>/dev/null || true
}

remove_all() {
  remove_chain nat "$NAT_PRE" PREROUTING
  remove_chain nat "$NAT_POST" POSTROUTING
  remove_chain filter "$FWD" FORWARD
  remove_chain filter "$FWD" DOCKER-USER
}

if [ "${1:-}" = "--remove" ]; then
  remove_all
  systemctl disable --now kmm-proxy-relay.service >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE" "$RULES_FILE"
  systemctl daemon-reload >/dev/null 2>&1 || true
  echo -e "${GREEN}Правила релея сняты.${NC}"
  exit 0
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

# Внешний IP главного сервера (для настройки ALLOW_IP на VPS)
PROD_PUBLIC_IP=$(curl -s -4 --max-time 8 ifconfig.me || ip route get 8.8.8.8 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   KMMZAVOD - НАСТРОЙКА РЕЛЕЙ-ПРОБРОСА ЧЕРЕЗ NL СЕРВЕР (DPI-SAFE)${NC}"
echo -e "${CYAN}================================================================${NC}"
echo -e "IP туннеля (AmneziaWG): ${GREEN}${TUNNEL_IP}${NC}"
echo -e "Внешний IP NL сервера:  ${GREEN}${PROD_PUBLIC_IP}${NC}"
echo ""

if [ ! -f "$INPUT_FILE" ]; then
  echo -e "${YELLOW}Файл $INPUT_FILE не найден. Создайте его со списком VPS в формате:${NC}"
  echo -e "IP:PORT:USER:PASS  (или просто IP)"
  echo ""
  echo "Пример:"
  echo "185.12.34.56:1080:kmmuser:mypassword123"
  echo "185.12.34.57:1080:kmmuser:mypassword123"
  exit 1
fi

echo -e "${YELLOW}[1/3] Включение IP Forwarding...${NC}"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-kmmzavod-relay.conf

echo -e "${YELLOW}[2/3] Настройка правил iptables (цепочки ${NAT_PRE}, ${NAT_POST}, ${FWD})...${NC}"

FWD_PARENT=$(forward_hook_chain)
# Переход мог остаться в другой родительской цепочке от прошлого запуска (до/после установки Docker).
remove_chain filter "$FWD" FORWARD
remove_chain filter "$FWD" DOCKER-USER
ensure_chain nat "$NAT_PRE" PREROUTING
ensure_chain nat "$NAT_POST" POSTROUTING
ensure_chain filter "$FWD" "$FWD_PARENT"

# Ответные пакеты от VPS обратно в туннель.
iptables -A "$FWD" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# Файл с паролями прокси: только для root.
umask 077
RELAY_OUT_FILE="vps-proxies-tunnel.txt"
: > "$RELAY_OUT_FILE"

INDEX=0
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  # Пропуск пустых строк и комментариев
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

  # Разбор строки: [SERIAL=][http://|socks5://]IP[:PORT[:USER[:PASS]]]
  serial_prefix=""
  if [[ "$line" =~ ^([a-zA-Z0-9_-]+)=(.*)$ ]]; then
    serial_prefix="${BASH_REMATCH[1]}="
    line="${BASH_REMATCH[2]}"
  fi
  protocol_prefix=""
  if [[ "$line" =~ ^(http|socks5)://(.*)$ ]]; then
    protocol_prefix="${BASH_REMATCH[1]}://"
    line="${BASH_REMATCH[2]}"
  fi
  IFS=':' read -r vIP vPORT vUSER vPASS <<< "$line"

  vPORT=${vPORT:-1080}
  vUSER=${vUSER:-kmmuser}
  vPASS=${vPASS:-""}

  if ! [[ "$vIP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ && "$vPORT" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}  Пропущена некорректная строка: ${vIP}:${vPORT}${NC}"
    continue
  fi

  RELAY_PORT=$((START_PORT + INDEX))

  iptables -t nat -A "$NAT_PRE" -d "$TUNNEL_IP" -p tcp --dport "$RELAY_PORT" \
    -j DNAT --to-destination "${vIP}:${vPORT}"
  iptables -t nat -A "$NAT_POST" -d "$vIP" -p tcp --dport "$vPORT" -j MASQUERADE
  iptables -A "$FWD" -d "$vIP" -p tcp --dport "$vPORT" -j ACCEPT

  echo "${serial_prefix}${protocol_prefix}${TUNNEL_IP}:${RELAY_PORT}:${vUSER}:${vPASS}" >> "$RELAY_OUT_FILE"
  echo -e "  [${INDEX}] Проброс порта ${CYAN}${TUNNEL_IP}:${RELAY_PORT}${NC} -> ${vIP}:${vPORT}"

  INDEX=$((INDEX + 1))
done < "$INPUT_FILE"

if [ "$INDEX" -eq 0 ]; then
  echo -e "${RED}[ОШИБКА] В $INPUT_FILE нет ни одной корректной строки — правила не созданы.${NC}"
  remove_all
  exit 1
fi

echo -e "${YELLOW}[3/3] Сохранение правил релея для автозапуска...${NC}"
# Сохраняем ТОЛЬКО свои цепочки (не весь iptables-save: в нём лежат правила Docker,
# восстановление которых при загрузке ломает сеть контейнеров).
# В unit-файле ниже "$$P" — это литеральный $P для sh: одиночный $ systemd раскрыл бы сам.
mkdir -p "$(dirname "$RULES_FILE")"
{
  echo "*nat"
  echo ":${NAT_PRE} - [0:0]"
  echo ":${NAT_POST} - [0:0]"
  iptables -t nat -S "$NAT_PRE" | grep '^-A' || true
  iptables -t nat -S "$NAT_POST" | grep '^-A' || true
  echo "COMMIT"
  echo "*filter"
  echo ":${FWD} - [0:0]"
  iptables -S "$FWD" | grep '^-A' || true
  echo "COMMIT"
} > "$RULES_FILE"
chmod 600 "$RULES_FILE"

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=KMMZAVOD proxy relay (iptables DNAT tunnel -> VPS)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'sysctl -w net.ipv4.ip_forward=1 >/dev/null; \\
  iptables-restore --noflush < ${RULES_FILE}; \\
  iptables -t nat -C PREROUTING -j ${NAT_PRE} 2>/dev/null || iptables -t nat -I PREROUTING 1 -j ${NAT_PRE}; \\
  iptables -t nat -C POSTROUTING -j ${NAT_POST} 2>/dev/null || iptables -t nat -I POSTROUTING 1 -j ${NAT_POST}; \\
  P=FORWARD; iptables -nL DOCKER-USER >/dev/null 2>&1 && P=DOCKER-USER; \\
  iptables -C \$\$P -j ${FWD} 2>/dev/null || iptables -I \$\$P 1 -j ${FWD}'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kmm-proxy-relay.service >/dev/null 2>&1 || true

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}   НАСТРОЙКА ЗАВЕРШЕНА: проброшено портов — ${INDEX}             ${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "Сгенерирован файл: ${CYAN}$(pwd)/${RELAY_OUT_FILE}${NC} (права 600, содержит пароли)"
echo -e "Перенесите его содержимое в ${YELLOW}apps/device-agent/vps-proxies.txt${NC} на ПК фермы и удалите с сервера."
echo -e "Не оставляйте этот файл в каталоге репозитория."
echo ""
echo -e "${YELLOW}ВАЖНО: При установке Dante на VPS укажите параметр ALLOW_IP:${NC}"
echo -e "${CYAN}sudo PROXY_PASS=<ПАРОЛЬ> bash vps-setup-proxy.sh 1080 kmmuser '' ${PROD_PUBLIC_IP}${NC}"
echo -e "Тогда прокси будут доступны ТОЛЬКО с этого NL сервера."
