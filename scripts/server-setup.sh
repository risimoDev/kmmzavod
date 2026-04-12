#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — server-setup.sh
#  Первоначальная настройка чистого Ubuntu 22.04/24.04 сервера
#  Использование: sudo bash scripts/server-setup.sh
#
#  Что делает скрипт:
#    1. Обновляет систему, ставит утилиты
#    2. Устанавливает Docker CE + Compose V2
#    3. Создаёт пользователя deploy с docker-доступом
#    4. Клонирует репозиторий (или использует существующий)
#    5. Автогенерирует .env со всеми паролями (рандомные)
#    6. Настраивает firewall (UFW)
#    7. Собирает и запускает все Docker-сервисы
#    8. Применяет миграции PostgreSQL через Prisma
#    9. Создаёт администратора
#   10. Выводит итог и URL-ы
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
REPO_URL="${REPO_URL:-}"
DOMAIN="${DOMAIN:-}"

header "kmmzavod — Настройка сервера"
echo -e "  Директория: ${BOLD}$APP_DIR${RESET}"
echo -e "  Пользователь: ${BOLD}$DEPLOY_USER${RESET}"
echo ""

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

if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  success "Docker уже установлен: $(docker --version)"
  success "Compose: $(docker compose version)"
else
  info "Добавляем репозиторий Docker..."
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

usermod -aG docker "$DEPLOY_USER"
success "$DEPLOY_USER добавлен в группу docker"

# SSH-ключи: копируем от root → deploy
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
mkdir -p "$DEPLOY_HOME/.ssh"
if [ -f /root/.ssh/authorized_keys ] && [ ! -f "$DEPLOY_HOME/.ssh/authorized_keys" ]; then
  cp /root/.ssh/authorized_keys "$DEPLOY_HOME/.ssh/authorized_keys"
  info "SSH-ключи скопированы от root → $DEPLOY_USER"
fi
chmod 700 "$DEPLOY_HOME/.ssh" 2>/dev/null || true
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys" 2>/dev/null || true
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh" 2>/dev/null || true

# =============================================================================
# 4. Клонирование репозитория
# =============================================================================
header "4/10 · Репозиторий"

if [ -d "$APP_DIR/.git" ]; then
  success "Репозиторий уже клонирован: $APP_DIR"
elif [ -n "$REPO_URL" ]; then
  info "Клонируем $REPO_URL → $APP_DIR..."
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
  success "Репозиторий клонирован"
else
  echo -e "  ${CYAN}URL репозитория не задан.${RESET}"
  read -rp "  Введите REPO_URL (или Enter чтобы пропустить): " REPO_URL
  if [ -n "$REPO_URL" ]; then
    git clone "$REPO_URL" "$APP_DIR"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
    success "Репозиторий клонирован"
  else
    warn "Скопируйте файлы вручную в $APP_DIR"
    mkdir -p "$APP_DIR"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
  fi
fi

cd "$APP_DIR"

# Удаляем dev-override — он отключает app-сервисы через profiles
if [ -f "$APP_DIR/docker-compose.override.yml" ]; then
  info "Удаляем docker-compose.override.yml (dev-only, мешает на сервере)"
  rm -f "$APP_DIR/docker-compose.override.yml"
  success "override удалён — все сервисы будут работать в Docker"
fi

# =============================================================================
# 5. Настройка .env
# =============================================================================
header "5/10 · Конфигурация .env"

gen_secret() { openssl rand -base64 "${1:-32}" | tr -d '+=/' | head -c "${1:-32}"; }

if [ -f "$APP_DIR/.env" ]; then
  success ".env уже существует — пропускаем генерацию"
else
  info "Генерируем .env с безопасными паролями..."

  PG_PASS="$(gen_secret 24)"
  REDIS_PASS="$(gen_secret 24)"
  MINIO_PASS="$(gen_secret 24)"
  JWT_SEC="$(gen_secret 48)"
  ENCRYPT_KEY="$(openssl rand -hex 32)"
  SERVER_IP="$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

  # NB: все пароли инлайнятся — .env не поддерживает cross-variable reference
  cat > "$APP_DIR/.env" <<ENVEOF
# Автоматически сгенерировано server-setup.sh $(date '+%Y-%m-%d %H:%M')

# ── PostgreSQL ────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=${PG_PASS}
DATABASE_URL=postgresql://kmmzavod:${PG_PASS}@postgres:5432/kmmzavod

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASS}

# ── MinIO ─────────────────────────────────────────────────────────────────────
MINIO_ROOT_USER=kmmzavod
MINIO_ROOT_PASSWORD=${MINIO_PASS}
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=kmmzavod
MINIO_SECRET_KEY=${MINIO_PASS}
MINIO_BUCKET=kmmzavod

# ── Auth ──────────────────────────────────────────────────────────────────────
JWT_SECRET=${JWT_SEC}
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
ENCRYPTION_KEY=${ENCRYPT_KEY}

# ── AI Keys (ЗАПОЛНИТЕ!) ──────────────────────────────────────────────────────
GPTUNNEL_API_KEY=CHANGE_ME
GPTUNNEL_BASE_URL=https://gptunnel.ru/v1
HEYGEN_API_KEY=CHANGE_ME
RUNWAY_API_KEY=CHANGE_ME
RUNWAY_VIDEO_MODEL=gen4_turbo
KLING_ACCESS_KEY=
KLING_SECRET_KEY=
IMAGE_GEN_PROVIDER=fal
IMAGE_GEN_API_KEY=CHANGE_ME
GEMINI_API_KEY=

# ── Video Processor ───────────────────────────────────────────────────────────
VIDEO_PROCESSOR_URL=http://video-processor:8000

# ── Social Publishing (optional) ──────────────────────────────────────────────
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
POST_BRIDGE_API_KEY=
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=

# ── AI Proxy (для российских серверов — обход гео-блокировок AI API) ──────────
# http://user:pass@proxy.example.com:8080  или  socks5://user:pass@host:1080
AI_PROXY_URL=

# ── Public URLs ───────────────────────────────────────────────────────────────
# Трафик идёт через nginx (port 80) — не указываем :3000
PUBLIC_API_URL=http://${SERVER_IP}
NEXT_PUBLIC_API_URL=http://${SERVER_IP}
ENVEOF

  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  success ".env создан с автогенерированными паролями"

  echo ""
  warn "Обязательно заполните AI-ключи!"
  echo -e "  ${CYAN}nano $APP_DIR/.env${RESET}"
  echo -e "  Переменные со значением ${BOLD}CHANGE_ME${RESET}:"
  echo -e "    GPTUNNEL_API_KEY, HEYGEN_API_KEY, RUNWAY_API_KEY, IMAGE_GEN_API_KEY"
  echo ""
  read -rp "  Нажмите Enter когда заполните .env (или Ctrl+C для отмены)... "
fi

# =============================================================================
# 6. Firewall (UFW)
# =============================================================================
header "6/10 · Настройка Firewall (UFW)"

ufw --force reset >/dev/null 2>&1
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow ssh >/dev/null
ufw allow 80/tcp >/dev/null    # Nginx HTTP
ufw allow 443/tcp >/dev/null   # Nginx HTTPS
ufw --force enable >/dev/null
success "UFW: SSH + 80 + 443 открыты. API/Web/MinIO только через nginx"

# =============================================================================
# 7. Сборка и запуск Docker-сервисов
# =============================================================================
header "7/10 · Сборка и запуск сервисов"

cd "$APP_DIR"

info "Сборка Docker-образов (5-15 минут)..."
docker compose build --progress=plain 2>&1 | tee /tmp/kmmzavod-build.log
if [ ${PIPESTATUS[0]} -ne 0 ]; then
  echo ""
  error "Сборка образов не удалась. Полный лог: /tmp/kmmzavod-build.log"
fi

info "Запуск инфраструктуры (postgres, redis, minio)..."
docker compose up -d postgres redis minio

info "Ожидание готовности PostgreSQL (до 60 сек)..."
WAIT=0
until docker compose exec -T postgres pg_isready -U kmmzavod -q 2>/dev/null; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 60 ] && error "PostgreSQL не запустился. Проверьте: docker compose logs postgres"
done
success "PostgreSQL готов"

info "Запуск всех сервисов..."
docker compose up -d
success "Все сервисы запущены"

# =============================================================================
# 8. Миграции базы данных
# =============================================================================
header "8/10 · Миграции базы данных"

info "Ожидание api-контейнера (до 30 сек)..."
WAIT=0
until docker compose exec -T api sh -c 'echo ok' &>/dev/null; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 30 ] && break
done

MIGRATED=false

# Через api-контейнер
if ! $MIGRATED; then
  info "Применяем prisma migrate deploy..."
  if docker compose exec -T api \
    sh -c 'cd /app && npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>&1; then
    MIGRATED=true
    success "Миграции применены"
  fi
fi

# Fallback: docker compose run
if ! $MIGRATED; then
  info "Fallback: docker compose run..."
  PG_PASS_FROM_ENV="$(grep -E '^POSTGRES_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)"
  if docker compose run --rm \
    -e DATABASE_URL="postgresql://kmmzavod:${PG_PASS_FROM_ENV}@postgres:5432/kmmzavod" \
    api sh -c 'cd /app && npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>&1; then
    MIGRATED=true
    success "Миграции применены (fallback)"
  fi
fi

if ! $MIGRATED; then
  warn "Миграции не применились. Запустите вручную:"
  echo -e "  ${CYAN}docker compose exec api sh -c 'npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma'${RESET}"
fi

# =============================================================================
# 9. Создание администратора
# =============================================================================
header "9/10 · Создание администратора"

info "Ожидание API health (до 30 сек)..."
WAIT=0
until curl -sf --max-time 3 "http://localhost:3000/health" &>/dev/null; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 30 ] && { warn "API не ответил — пропускаем"; break; }
done

if [ "$WAIT" -lt 30 ]; then
  ADMIN_COUNT=$(docker compose exec -T postgres psql -U kmmzavod -tAc \
    "SELECT COUNT(*) FROM \"User\" WHERE role='admin';" 2>/dev/null || echo "0")

  if [ "${ADMIN_COUNT:-0}" -gt 0 ]; then
    success "Администратор уже существует"
  else
    echo ""
    read -rp "  Email администратора [admin@kmmzavod.ru]: " ADMIN_EMAIL
    ADMIN_EMAIL="${ADMIN_EMAIL:-admin@kmmzavod.ru}"
    read -rsp "  Пароль (мин. 8 символов): " ADMIN_PASS
    echo ""
    [ ${#ADMIN_PASS} -lt 8 ] && error "Пароль короче 8 символов"

    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "http://localhost:3000/api/v1/auth/register" \
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
      warn "Не удалось создать admin (HTTP $HTTP_STATUS). Создайте позже:"
      echo -e "  ${CYAN}./scripts/deploy.sh --create-admin${RESET}"
    fi
  fi
fi

# =============================================================================
# 10. Итог
# =============================================================================
header "10/10 · Готово!"

SERVER_IP="$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

echo ""
info "Статус сервисов:"
docker compose ps --format "table {{.Service}}\t{{.Status}}" 2>/dev/null || docker compose ps

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║      Сервер настроен успешно!                            ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}IP:${RESET} $SERVER_IP"
echo ""
echo -e "  ${BOLD}URL:${RESET}"
echo -e "    ${CYAN}http://$SERVER_IP${RESET}           — Веб (Nginx)"
echo -e "    ${CYAN}http://$SERVER_IP:3000${RESET}      — API"
echo -e "    ${CYAN}http://$SERVER_IP:9001${RESET}      — MinIO Console"
echo ""
echo -e "  ${BOLD}Управление:${RESET}"
echo -e "    ${CYAN}cd $APP_DIR && docker compose ps${RESET}"
echo -e "    ${CYAN}cd $APP_DIR && docker compose logs -f${RESET}"
echo -e "    ${CYAN}cd $APP_DIR && ./scripts/deploy.sh${RESET}"
echo ""

# Сохраняем пароли
SECRETS_FILE="$APP_DIR/.secrets-setup"
{
  echo "# kmmzavod passwords ($(date))"
  echo "# УДАЛИТЕ после сохранения в менеджер паролей!"
  grep -E "^(POSTGRES_PASSWORD|REDIS_PASSWORD|MINIO_ROOT_PASSWORD|JWT_SECRET|ENCRYPTION_KEY)=" "$APP_DIR/.env"
} > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
chown "$DEPLOY_USER:$DEPLOY_USER" "$SECRETS_FILE"
warn "Пароли: ${BOLD}$SECRETS_FILE${RESET}${YELLOW} — сохраните и удалите!"
echo ""
