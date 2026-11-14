#!/bin/bash
# ==============================================================================
# KMMZAVOD - Автоматическая установка защищенного SOCKS5 (Dante Server) на VPS
# Поддерживаемые ОС: Ubuntu 20.04/22.04/24.04, Debian 10/11/12
# ==============================================================================
set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   KMMZAVOD - УСТАНОВКА ЗАЩИЩЕННОГО SOCKS5 ПРОКСИ ДЛЯ ПЛАТЫ     ${NC}"
echo -e "${CYAN}================================================================${NC}"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ОШИБКА] Запустите скрипт с правами root (sudo bash $0)${NC}"
  exit 1
fi

PROXY_PORT=${1:-${PROXY_PORT:-1080}}
PROXY_USER=${2:-${PROXY_USER:-kmmuser}}
PROXY_PASS=${PROXY_PASS:-${3:-$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9_')}}
ALLOW_IP=${4:-${PROXY_ALLOW_IP:-""}}

echo -e "${YELLOW}[1/4] Обновление пакетов и установка dante-server...${NC}"
apt-get update -y
apt-get install -y dante-server ufw

# Надежное определение основного сетевого интерфейса и внешнего IP
NET_IFACE=$(ip -o -4 route get 8.8.8.8 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p')
if [ -z "$NET_IFACE" ]; then
    NET_IFACE=$(ip route show default | awk '{print $5}' | head -n1)
fi
SERVER_IP=$(curl -s -4 ifconfig.me || ip route get 8.8.8.8 | awk '{print $7}')

echo -e "${GREEN}[OK] Сетевой интерфейс: $NET_IFACE, Внешний IP: $SERVER_IP${NC}"

echo -e "${YELLOW}[2/4] Создание изолированного системного пользователя...${NC}"
if id "$PROXY_USER" &>/dev/null; then
    echo "$PROXY_USER:$PROXY_PASS" | chpasswd
else
    useradd -r -s /bin/false -M "$PROXY_USER"
    echo "$PROXY_USER:$PROXY_PASS" | chpasswd
    echo -e "${GREEN}[OK] Пользователь $PROXY_USER создан.${NC}"
fi

# Запрет входа по SSH для этого пользователя (защита от туннелирования через SSH)
mkdir -p /etc/ssh/sshd_config.d
echo "DenyUsers $PROXY_USER" > /etc/ssh/sshd_config.d/kmm-proxy.conf
if command -v systemctl &>/dev/null && systemctl is-active --quiet ssh; then
    systemctl reload ssh || true
elif command -v systemctl &>/dev/null && systemctl is-active --quiet sshd; then
    systemctl reload sshd || true
fi

echo -e "${YELLOW}[3/4] Настройка конфигурации /etc/danted.conf...${NC}"

CLIENT_RULE="from: 0.0.0.0/0 to: 0.0.0.0/0"
if [ -n "$ALLOW_IP" ]; then
    echo -e "${GREEN}[БЕЗОПАСНОСТЬ] Доступ к прокси ограничен только с IP: $ALLOW_IP${NC}"
    CLIENT_RULE="from: ${ALLOW_IP} to: 0.0.0.0/0"
fi

cat <<EOF > /etc/danted.conf
logoutput: /var/log/danted.log
internal: 0.0.0.0 port = ${PROXY_PORT}
external: ${NET_IFACE}

socksmethod: username
clientmethod: none

user.privileged: root
user.unprivileged: nobody

client pass {
    ${CLIENT_RULE}
    log: error
}

socks pass {
    ${CLIENT_RULE}
    command: connect
    socksmethod: username
    log: error
}
EOF

echo -e "${YELLOW}[4/4] Настройка файрвола UFW и перезапуск сервиса...${NC}"
if command -v ufw &>/dev/null && ufw status | grep -qw "active"; then
    if [ -n "$ALLOW_IP" ]; then
        ufw allow from ${ALLOW_IP} to any port ${PROXY_PORT} proto tcp >/dev/null 2>&1 || true
    else
        ufw allow ${PROXY_PORT}/tcp >/dev/null 2>&1 || true
    fi
fi

systemctl restart danted
systemctl enable danted

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}   [УСПЕХ] SOCKS5 ПРОКСИ УСПЕШНО НАСТРОЕН И ЗАПУЩЕН!            ${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "IP адрес:   ${CYAN}${SERVER_IP}${NC}"
echo -e "Порт:       ${CYAN}${PROXY_PORT}${NC}"
echo -e "Логин:      ${CYAN}${PROXY_USER}${NC}"
echo -e "Пароль:     ${CYAN}${PROXY_PASS}${NC}"
echo -e "Тип:        ${CYAN}socks5${NC}"
if [ -n "$ALLOW_IP" ]; then
    echo -e "Защита:     ${GREEN}Разрешен только с IP ${ALLOW_IP}${NC}"
fi
echo ""
echo -e "${YELLOW}Строка для файла vps-proxies.txt:${NC}"
echo -e "${GREEN}${SERVER_IP}:${PROXY_PORT}:${PROXY_USER}:${PROXY_PASS}${NC}"
echo -e "${GREEN}================================================================${NC}"
