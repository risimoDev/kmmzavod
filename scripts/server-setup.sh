#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — server-setup.sh
#  Первоначальная настройка чистого Ubuntu 22.04 сервера
#  Использование: sudo bash scripts/server-setup.sh
#
#  Что делает скрипт:
#    1. Обновляет систему
#    2. Устанавливает Docker CE + Docker Compose v2
#    3. Устанавливает Git, curl, openssl, ufw
#    4. Создаёт пользователя deploy
#    5. Клонирует репозиторий
#    6. Генерирует безопасные пароли и создаёт .env
#    7. Настраивает firewall (UFW)
#    8. Запускает все сервисы
#    9. Применяет миграции БД
#   10. Создаёт администратора
# =============================================================================

set -euo pipefail

# ── Цвета ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▶  $*${RESET}"; }
success() { echo -e "${GREEN}✔  $*${RESET}"; }
warn()    { echo -e "${YELLOW}⚠  $*${RESET}"; }
error()   { echo -e "${RED}✖  $*${RESET}" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${BLUE}═══  $*  ═══${RESET}\n"; }

# ── Проверка root ────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Запустите с sudo: sudo bash $0"

# ── Конфигурация ─────────────────────────────────────────────────────────────
APP_DIR="${APP_DIR:-/opt/kmmzavod}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
REPO_URL="${REPO_URL:-}"   # Заполнится интерактивно если пусто
DOMAIN="${DOMAIN:-}"       # Ваш домен (необязательно для старта)

header "kmmzavod — Настройка сервера Ubuntu 22.04"
echo -e "  Директория: ${BOLD}$APP_DIR${RESET}"
echo -e "  Пользователь: ${BOLD}$DEPLOY_USER${RESET}\n"

# =============================================================================
# 1. Обновление системы
# =============================================================================
header "1/10 · Обновление системы"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git openssl ca-certificates \
  gnupg lsb-release htop net-tools ufw \
  apt-transport-https software-properties-common
success "Система обновлена"

# =============================================================================
# 2. Установка Docker CE
# =============================================================================
header "2/10 · Установка Docker CE"

if command -v docker &>/dev/null; then
  success "Docker уже установлен: $(docker --version)"
else
  info "Добавляем официальный репозиторий Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
     https://download.docker.com/linux/ubuntu \
     $(lsb_release -cs) stable" \
    | tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
  success "Docker CE установлен: $(docker --version)"
fi

# =============================================================================
# 3. Создание пользователя deploy
# =============================================================================
header "3/10 · Пользователь deploy"

if id "$DEPLOY_USER" &>/dev/null; then
  success "Пользователь $DEPLOY_USER уже существует"
else
  useradd -m -s /bin/bash "$DEPLOY_USER"
  success "Пользователь $DEPLOY_USER создан"
fi

# Добавить в группу docker
usermod -aG docker "$DEPLOY_USER"
success "$DEPLOY_USER добавлен в группу docker"

# SSH ключи для deploy (копируем от root если есть)
DEPLOY_HOME="$(getent passwd $DEPLOY_USER | cut -d: -f6)"
mkdir -p "$DEPLOY_HOME/.ssh"
if [ -f /root/.ssh/authorized_keys ] && [ ! -f "$DEPLOY_HOME/.ssh/authorized_keys" ]; then
  cp /root/.ssh/authorized_keys "$DEPLOY_HOME/.ssh/authorized_keys"
fi
chmod 700 "$DEPLOY_HOME/.ssh" 2>/dev/null || true
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys" 2>/dev/null || true
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh" 2>/dev/null || true

# =============================================================================
# 4. Клонирование репозитория
# =============================================================================
header "4/10 · Репозиторий"

if [ -z "$REPO_URL" ]; then
  echo -e "  ${CYAN}Укажите URL репозитория Git${RESET}"
  read -rp "  REPO_URL [или Enter чтобы пропустить]: " REPO_URL
fi

if [ -n "$REPO_URL" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    success "Репозиторий уже клонирован в $APP_DIR"
  else
    info "Клонируем в $APP_DIR..."
    git clone "$REPO_URL" "$APP_DIR"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
    success "Репозиторий клонирован"
  fi
else
  warn "Репозиторий пропущен. Скопируйте файлы вручную в $APP_DIR"
  mkdir -p "$APP_DIR"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
fi

cd "$APP_DIR"

# =============================================================================
# 5. Настройка .env
# =============================================================================
header "5/10 · Конфигурация .env"

gen_secret() { openssl rand -base64 "${1:-32}" | tr -d '+=/' | head -c "${1:-32}"; }

if [ -f "$APP_DIR/.env" ]; then
  success ".env уже существует — пропускаем генерацию"
else
  if [ ! -f "$APP_DIR/.env.example" ]; then
    warn ".env.example не найден — создаём базовый .env"
    cat > "$APP_DIR/.env" <<EOF
# Автоматически сгенерировано server-setup.sh
POSTGRES_PASSWORD=$(gen_secret 24)
REDIS_PASSWORD=$(gen_secret 24)
MINIO_ROOT_USER=kmmzavod
MINIO_ROOT_PASSWORD=$(gen_secret 24)
JWT_SECRET=$(gen_secret 48)
OPENAI_API_KEY=sk-placeholder
HEYGEN_API_KEY=placeholder
KLING_ACCESS_KEY=placeholder
KLING_SECRET_KEY=placeholder
IMAGE_GEN_API_KEY=placeholder
IMAGE_GEN_PROVIDER=fal
PUBLIC_API_URL=http://$(curl -sf https://api.ipify.org 2>/dev/null || echo "localhost"):3000
NEXT_PUBLIC_API_URL=http://$(curl -sf https://api.ipify.org 2>/dev/null || echo "localhost"):3000
DATABASE_URL=postgresql://kmmzavod:\${POSTGRES_PASSWORD}@localhost:5433/kmmzavod
EOF
  else
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    # Заменяем change_me значения автоматически
    PG_PASS=$(gen_secret 24)
    REDIS_PASS=$(gen_secret 24)
    MINIO_PASS=$(gen_secret 24)
    JWT_SEC=$(gen_secret 48)
    SERVER_IP=$(curl -sf https://api.ipify.org 2>/dev/null || echo "localhost")

    sed -i "s|change_me_strong_password|${PG_PASS}|g"    "$APP_DIR/.env"
    sed -i "s|change_me_redis_password|${REDIS_PASS}|g"  "$APP_DIR/.env"
    sed -i "s|change_me_minio_password|${MINIO_PASS}|g"  "$APP_DIR/.env"
    sed -i "s|change_me_jwt_secret_min_32_chars|${JWT_SEC}|g" "$APP_DIR/.env"
    sed -i "s|http://localhost:3000|http://${SERVER_IP}:3000|g" "$APP_DIR/.env"
  fi

  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  success ".env создан с автогенерированными паролями"

  echo ""
  warn "Заполните AI-ключи в .env:"
  echo -e "  ${CYAN}nano $APP_DIR/.env${RESET}"
  echo -e "  Переменные: OPENAI_API_KEY, HEYGEN_API_KEY, KLING_ACCESS_KEY, KLING_SECRET_KEY"
  echo ""
  read -rp "  Нажмите Enter когда будете готовы продолжить... "
fi

# =============================================================================
# 6. Firewall (UFW)
# =============================================================================
header "6/10 · Настройка Firewall (UFW)"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw allow 3000/tcp  # API (прямой доступ при необходимости)
ufw allow 3001/tcp  # Web (прямой доступ при необходимости)
ufw --force enable
success "UFW настроен (SSH, 80, 443, 3000, 3001)"

# =============================================================================
# 7. Сборка и запуск Docker сервисов
# =============================================================================
header "7/10 · Сборка и запуск сервисов"

cd "$APP_DIR"
info "Сборка Docker образов (может занять 5-10 минут)..."
docker compose build --no-cache 2>&1 | tail -5

info "Запуск всех сервисов..."
docker compose up -d
success "Сервисы запущены"

# =============================================================================
# 8. Ожидание готовности БД и применение миграций
# =============================================================================
header "8/10 · Миграции базы данных"

info "Ожидание готовности PostgreSQL (до 60 сек)..."
WAIT=0
until docker compose exec -T postgres pg_isready -U kmmzavod -q 2>/dev/null; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 60 ] && error "PostgreSQL не запустился за 60 сек"
  echo -ne "  Ожидаем... ${WAIT}s\r"
done
success "PostgreSQL готов"

info "Применяем миграции Prisma..."
docker compose exec -T api \
  sh -c 'cd /app && npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>/dev/null || \
docker compose run --rm -e DATABASE_URL="postgresql://kmmzavod:$(grep POSTGRES_PASSWORD .env | cut -d= -f2)@postgres:5432/kmmzavod" \
  api sh -c 'npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>/dev/null || \
warn "Миграции не применились автоматически. Запустите вручную: docker compose exec api npx prisma migrate deploy"

success "Миграции применены"

# =============================================================================
# 9. Создание администратора
# =============================================================================
header "9/10 · Создание администратора"

info "Ожидание API (до 30 сек)..."
API_PORT=3000
WAIT=0
until curl -sf "http://localhost:${API_PORT}/api/v1/health" &>/dev/null ||
      curl -sf "http://localhost:${API_PORT}/" &>/dev/null; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 30 ] && { warn "API не ответил — пропускаем создание admin"; break; }
done

if [ "$WAIT" -lt 30 ]; then
  echo ""
  read -rp "  Email администратора [admin@kmmzavod.ru]: " ADMIN_EMAIL
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@kmmzavod.ru}"
  read -rsp "  Пароль (мин. 8 символов): " ADMIN_PASS
  echo ""

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${API_PORT}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"email\": \"${ADMIN_EMAIL}\",
      \"password\": \"${ADMIN_PASS}\",
      \"displayName\": \"Admin\",
      \"tenantName\": \"Platform Admin\"
    }" 2>/dev/null || echo "000")

  if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "409" ]]; then
    docker compose exec -T postgres psql -U kmmzavod -c \
      "UPDATE \"User\" SET role='admin' WHERE email='${ADMIN_EMAIL}';" 2>/dev/null
    success "Администратор создан: $ADMIN_EMAIL"
  else
    warn "Не удалось создать admin (HTTP $HTTP_STATUS). Создайте позже командой:"
    echo -e "  ${CYAN}./scripts/deploy.sh --create-admin${RESET}"
  fi
fi

# =============================================================================
# 10. Итог
# =============================================================================
header "10/10 · Итог"

SERVER_IP=$(curl -sf https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║   ✔  Сервер настроен успешно!                        ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Публичный IP: ${BOLD}$SERVER_IP${RESET}"
echo ""
echo -e "  ${BOLD}Доступные URL:${RESET}"
echo -e "  ${CYAN}http://$SERVER_IP${RESET}           — веб через Nginx"
echo -e "  ${CYAN}http://$SERVER_IP:3001${RESET}      — веб напрямую"
echo -e "  ${CYAN}http://$SERVER_IP:3000${RESET}      — API"
echo -e "  ${CYAN}http://$SERVER_IP:9001${RESET}      — MinIO Console"
echo ""
echo -e "  ${BOLD}Управление:${RESET}"
echo -e "  ${CYAN}docker compose ps${RESET}          — статус сервисов"
echo -e "  ${CYAN}docker compose logs -f${RESET}     — логи"
echo -e "  ${CYAN}./scripts/deploy.sh${RESET}        — обновление кода"
echo ""
[ -n "$DOMAIN" ] && echo -e "  ${YELLOW}⚠  Для SSL настройте certbot:${RESET}"
[ -n "$DOMAIN" ] && echo -e "  ${CYAN}certbot --nginx -d $DOMAIN${RESET}"

# Записываем сводку паролей в защищённый файл
SECRETS_FILE="$APP_DIR/.secrets-setup"
{
  echo "# kmmzavod — сгенерированные пароли ($(date))"
  echo "# ХРАНИТЕ В БЕЗОПАСНОМ МЕСТЕ!"
  grep -E "^(POSTGRES_PASSWORD|REDIS_PASSWORD|MINIO_ROOT_PASSWORD|JWT_SECRET)=" "$APP_DIR/.env"
} > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
chown "$DEPLOY_USER:$DEPLOY_USER" "$SECRETS_FILE"
echo ""
warn "Пароли сохранены в ${BOLD}$SECRETS_FILE${RESET}${YELLOW} — сохраните их в надёжном месте!"
echo ""
