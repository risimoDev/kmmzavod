#!/bin/bash
# ==============================================================================
# KMMZAVOD - Автоматическая установка SOCKS5 Прокси (Dante Server) на VPS
# Поддерживаемые ОС: Ubuntu 20.04/22.04/24.04, Debian 10/11/12
# ==============================================================================
set -e

# Цвета для вывода
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}       KMMZAVOD - БЫСТРАЯ УСТАНОВКА SOCKS5 ПРОКСИ ДЛЯ ПЛАТЫ     ${NC}"
echo -e "${CYAN}================================================================${NC}"

# Проверка root прав
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ОШИБКА] Запустите скрипт с правами root (sudo bash $0)${NC}"
  exit 1
fi

# Параметры по умолчанию или из аргументов
PROXY_PORT=${1:-1080}
PROXY_USER=${2:-kmmuser}
PROXY_PASS=${3:-$(openssl rand -hex 6 2>/dev/null || tr -dc A-Za-z0-9 </dev/urandom | head -c 12)}

echo -e "${YELLOW}[1/4] Обновление пакетов и установка dante-server...${NC}"
apt-get update -y
apt-get install -y dante-server ufw

# Определение основного сетевого интерфейса
NET_IFACE=$(ip route get 8.8.8.8 | awk -- '{printf $5}')
SERVER_IP=$(curl -s -4 ifconfig.me || ip route get 8.8.8.8 | awk '{print $7}')

echo -e "${GREEN}[OK] Сетевой интерфейс: $NET_IFACE, Внешний IP: $SERVER_IP${NC}"

echo -e "${YELLOW}[2/4] Создание системного пользователя для аутентификации...${NC}"
if id "$PROXY_USER" &>/dev/null; then
    echo "Пользователь $PROXY_USER уже существует, обновляем пароль..."
    echo "$PROXY_USER:$PROXY_PASS" | chpasswd
else
    useradd -r -s /bin/false "$PROXY_USER"
    echo "$PROXY_USER:$PROXY_PASS" | chpasswd
    echo -e "${GREEN}[OK] Пользователь $PROXY_USER создан.${NC}"
fi

echo -e "${YELLOW}[3/4] Настройка конфигурации /etc/danted.conf...${NC}"
cat <<EOF > /etc/danted.conf
logoutput: /var/log/danted.log
internal: 0.0.0.0 port = ${PROXY_PORT}
external: ${NET_IFACE}

socksmethod: username
clientmethod: none

user.privileged: root
user.unprivileged: nobody

client pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: error
}

socks pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    command: bind connect udpassociate
    socksmethod: username
    log: error
}
EOF

echo -e "${YELLOW}[4/4] Настройка файрвола UFW и перезапуск сервиса...${NC}"
if command -v ufw &>/dev/null; then
    ufw allow ${PROXY_PORT}/tcp >/dev/null 2>&1 || true
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
echo ""
echo -e "${YELLOW}Строка для файла vps-proxies.txt (скопируйте в kmmzavod):${NC}"
echo -e "${GREEN}${SERVER_IP}:${PROXY_PORT}:${PROXY_USER}:${PROXY_PASS}${NC}"
echo -e "${GREEN}================================================================${NC}"
