#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — server-setup.sh
#  Полностью автоматическая настройка чистого Ubuntu 22.04/24.04 сервера
#
#  Использование:
#    sudo bash scripts/server-setup.sh --domain k-m-m.ru --repo-url git@github.com:user/repo.git
#    sudo DOMAIN=k-m-m.ru REPO_URL=... bash scripts/server-setup.sh
#    sudo bash scripts/server-setup.sh -y          # без вопросов, всё автоматически
#
#  Параметры (CLI-флаги или переменные окружения):
#    --domain DOMAIN         Домен сайта (для nginx + SSL)
#    --repo-url URL          URL git-репозитория
#    --admin-email EMAIL     Email администратора      [admin@kmmzavod.ru]
#    --admin-password PASS   Пароль администратора      [автогенерация]
#    --app-dir DIR           Директория проекта         [/opt/kmmzavod]
#    --deploy-user USER      Имя deploy-пользователя    [deploy]
#    --skip-firewall         Не настраивать UFW
#    --skip-ssl              Не получать Let's Encrypt сертификат
#    -y, --yes               Не задавать интерактивных вопросов
#    -h, --help              Показать помощь
#
#  AI-ключи подхватываются из переменных окружения:
#    GPTUNNEL_API_KEY, HEYGEN_API_KEY, RUNWAY_API_KEY, IMAGE_GEN_API_KEY,
#    KLING_ACCESS_KEY, KLING_SECRET_KEY, GEMINI_API_KEY, AI_PROXY_URL
#
#  Что делает скрипт:
#    1.  Обновляет систему, ставит утилиты
#    2.  Устанавливает Docker CE + Compose V2
#    3.  Создаёт swap (если RAM < 4GB)
#    4.  Создаёт пользователя deploy с docker-доступом
#    5.  Клонирует репозиторий (или использует существующий)
#    6.  Автогенерирует .env со всеми паролями
#    7.  Настраивает nginx.conf под домен
#    8.  Настраивает firewall (UFW)
#    9.  Получает SSL-сертификат Let's Encrypt
#   10.  Собирает и запускает все Docker-сервисы
#   11.  Применяет миграции PostgreSQL через Prisma
#   12.  Создаёт MinIO-бакет
#   13.  Создаёт администратора
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

# ── Параметры по умолчанию (переопределяются из env или CLI) ──────────────────
APP_DIR="${APP_DIR:-/opt/kmmzavod}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
REPO_URL="${REPO_URL:-}"
DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@kmmzavod.ru}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SKIP_FIREWALL="${SKIP_FIREWALL:-false}"
SKIP_SSL="${SKIP_SSL:-false}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

# AI-ключи (подхватываются из окружения если заданы, иначе CHANGE_ME)
_GPTUNNEL_API_KEY="${GPTUNNEL_API_KEY:-CHANGE_ME}"
_HEYGEN_API_KEY="${HEYGEN_API_KEY:-CHANGE_ME}"
_RUNWAY_API_KEY="${RUNWAY_API_KEY:-CHANGE_ME}"
_IMAGE_GEN_API_KEY="${IMAGE_GEN_API_KEY:-CHANGE_ME}"
_KLING_ACCESS_KEY="${KLING_ACCESS_KEY:-}"
_KLING_SECRET_KEY="${KLING_SECRET_KEY:-}"
_GEMINI_API_KEY="${GEMINI_API_KEY:-}"
_AI_PROXY_URL="${AI_PROXY_URL:-}"

# ── Справка ──────────────────────────────────────────────────────────────────
show_help() {
  cat <<'HELP'
Использование: sudo bash scripts/server-setup.sh [опции]

Опции:
  --domain DOMAIN         Домен для nginx + SSL (например: k-m-m.ru)
  --repo-url URL          URL git-репозитория для клонирования
  --admin-email EMAIL     Email администратора          [admin@kmmzavod.ru]
  --admin-password PASS   Пароль администратора          [автогенерация]
  --app-dir DIR           Директория проекта             [/opt/kmmzavod]
  --deploy-user USER      Системный пользователь         [deploy]
  --skip-firewall         Не настраивать UFW
  --skip-ssl              Не получать SSL-сертификат
  -y, --yes               Полностью автоматический режим (без вопросов)
  -h, --help              Вывести эту справку

AI-ключи подхватываются из переменных окружения, если заданы:
  GPTUNNEL_API_KEY, HEYGEN_API_KEY, RUNWAY_API_KEY,
  IMAGE_GEN_API_KEY, KLING_ACCESS_KEY, KLING_SECRET_KEY,
  GEMINI_API_KEY, AI_PROXY_URL

Примеры:
  # Полная установка с доменом
  sudo bash scripts/server-setup.sh --domain k-m-m.ru \
    --repo-url git@github.com:user/kmmzavod.git -y

  # С AI-ключами из окружения
  export GPTUNNEL_API_KEY=sk-... HEYGEN_API_KEY=...
  sudo -E bash scripts/server-setup.sh --domain k-m-m.ru -y

  # Минимальная установка (без домена — по IP)
  sudo bash scripts/server-setup.sh -y
HELP
  exit 0
}

# ── Разбор CLI-аргументов ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)         DOMAIN="$2"; shift ;;
    --repo-url)       REPO_URL="$2"; shift ;;
    --admin-email)    ADMIN_EMAIL="$2"; shift ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift ;;
    --app-dir)        APP_DIR="$2"; shift ;;
    --deploy-user)    DEPLOY_USER="$2"; shift ;;
    --skip-firewall)  SKIP_FIREWALL=true ;;
    --skip-ssl)       SKIP_SSL=true ;;
    -y|--yes)         NON_INTERACTIVE=true ;;
    -h|--help)        show_help ;;
    *) warn "Неизвестный параметр: $1" ;;
  esac
  shift
done

# ── Утилиты ──────────────────────────────────────────────────────────────────
gen_secret() { openssl rand -base64 "${1:-32}" | tr -d '+=/' | head -c "${1:-32}"; }

# Безопасное экранирование строки для JSON (предотвращение JSON-инъекции)
json_escape() {
  local str="$1"
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  str="${str//$'\n'/\\n}"
  str="${str//$'\r'/\\r}"
  str="${str//$'\t'/\\t}"
  printf '"%s"' "$str"
}

# Безопасное экранирование для SQL (предотвращение SQL-инъекции)
sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

# Ожидание освобождения apt/dpkg lock
wait_for_apt() {
  local tries=0
  while fuser /var/lib/dpkg/lock >/dev/null 2>&1 \
     || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 \
     || fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 40 ]; then
      warn "Apt lock не освободился за 2 минуты — продолжаем"
      break
    fi
    info "Ожидание освобождения apt/dpkg... ($tries)"
    sleep 3
  done
}

# ── Автогенерация паролей ────────────────────────────────────────────────────
PG_PASS="$(gen_secret 24)"
REDIS_PASS="$(gen_secret 24)"
MINIO_PASS="$(gen_secret 24)"
JWT_SEC="$(gen_secret 48)"
ENCRYPT_KEY="$(openssl rand -hex 32)"

# Если пароль админа не задан — генерируем
ADMIN_PASS_GENERATED=false
if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(gen_secret 16)"
  ADMIN_PASS_GENERATED=true
fi

# ── Определение IP-адреса сервера ────────────────────────────────────────────
SERVER_IP="$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null \
  || curl -sf --max-time 5 https://ifconfig.me 2>/dev/null \
  || hostname -I | awk '{print $1}')"

# ── Определение PUBLIC_API_URL и MINIO_PUBLIC_URL ────────────────────────────
if [ -n "$DOMAIN" ]; then
  PUBLIC_API_URL="https://${DOMAIN}"
  MINIO_PUBLIC_URL="https://${DOMAIN}/storage"
else
  PUBLIC_API_URL="http://${SERVER_IP}"
  MINIO_PUBLIC_URL="http://${SERVER_IP}/storage"
fi

# =============================================================================
header "kmmzavod — Настройка production-сервера"
echo -e "  Директория:   ${BOLD}$APP_DIR${RESET}"
echo -e "  Пользователь: ${BOLD}$DEPLOY_USER${RESET}"
echo -e "  Домен:        ${BOLD}${DOMAIN:-не задан (работаем по IP: $SERVER_IP)}${RESET}"
echo -e "  Admin email:  ${BOLD}$ADMIN_EMAIL${RESET}"
echo ""

# =============================================================================
# 1/13. Обновление системы
# =============================================================================
header "1/13 · Обновление системы"

export DEBIAN_FRONTEND=noninteractive
wait_for_apt
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git openssl ca-certificates \
  gnupg lsb-release htop net-tools ufw \
  apt-transport-https software-properties-common
success "Система обновлена"

# =============================================================================
# 2/13. Установка Docker CE
# =============================================================================
header "2/13 · Установка Docker CE"

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

  wait_for_apt
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
  success "Docker CE установлен: $(docker --version)"
fi

# =============================================================================
# 3/13. Swap (для серверов с малым RAM)
# =============================================================================
header "3/13 · Проверка swap"

TOTAL_MEM_MB=$(awk '/MemTotal/ {printf "%.0f", $2/1024}' /proc/meminfo)
if [ "$TOTAL_MEM_MB" -lt 4000 ] && [ ! -f /swapfile ]; then
  info "RAM < 4GB (${TOTAL_MEM_MB}MB) — создаём 2GB swap..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  success "Swap 2GB создан"
else
  success "Swap не требуется (RAM: ${TOTAL_MEM_MB}MB)"
fi

# =============================================================================
# 4/13. Создание пользователя deploy
# =============================================================================
header "4/13 · Пользователь deploy"

if id "$DEPLOY_USER" &>/dev/null; then
  success "Пользователь $DEPLOY_USER уже существует"
else
  useradd -m -s /bin/bash "$DEPLOY_USER"
  success "Пользователь $DEPLOY_USER создан"
fi

# docker group
if ! getent group docker >/dev/null; then
  groupadd docker || true
fi
usermod -aG docker "$DEPLOY_USER" || true
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
# 5/13. Клонирование репозитория
# =============================================================================
header "5/13 · Репозиторий"

if [ -d "$APP_DIR/.git" ]; then
  success "Репозиторий уже клонирован: $APP_DIR"
elif [ -n "$REPO_URL" ]; then
  info "Клонируем $REPO_URL → $APP_DIR..."
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
  success "Репозиторий клонирован"
else
  if [ "$NON_INTERACTIVE" = true ]; then
    warn "REPO_URL не задан. Убедитесь что код уже в $APP_DIR"
    mkdir -p "$APP_DIR"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
  else
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
fi

cd "$APP_DIR"

# Удаляем dev-override — он отключает app-сервисы через profiles
if [ -f "$APP_DIR/docker-compose.override.yml" ]; then
  info "Удаляем docker-compose.override.yml (dev-only)"
  rm -f "$APP_DIR/docker-compose.override.yml"
  success "override удалён — все сервисы будут работать в Docker"
fi

# =============================================================================
# 6/13. Конфигурация .env
# =============================================================================
header "6/13 · Конфигурация .env"

if [ -f "$APP_DIR/.env" ]; then
  success ".env уже существует — пропускаем генерацию"
  # Перечитываем пароли из существующего .env для последующих шагов
  PG_PASS="$(grep -E '^POSTGRES_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)"
  REDIS_PASS="$(grep -E '^REDIS_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)"
  MINIO_PASS="$(grep -E '^MINIO_ROOT_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)"
else
  info "Генерируем .env с безопасными паролями..."

  cat > "$APP_DIR/.env" <<ENVEOF
# =============================================================================
# Автоматически сгенерировано server-setup.sh $(date '+%Y-%m-%d %H:%M')
# =============================================================================

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
MINIO_SECURE=false
MINIO_PUBLIC_URL=${MINIO_PUBLIC_URL}

# ── Auth ──────────────────────────────────────────────────────────────────────
JWT_SECRET=${JWT_SEC}
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
ENCRYPTION_KEY=${ENCRYPT_KEY}

# ── AI Keys ───────────────────────────────────────────────────────────────────
GPTUNNEL_API_KEY=${_GPTUNNEL_API_KEY}
GPTUNNEL_BASE_URL=https://gptunnel.ru/v1
HEYGEN_API_KEY=${_HEYGEN_API_KEY}
RUNWAY_API_KEY=${_RUNWAY_API_KEY}
RUNWAY_VIDEO_MODEL=gen4_turbo
KLING_ACCESS_KEY=${_KLING_ACCESS_KEY}
KLING_SECRET_KEY=${_KLING_SECRET_KEY}
IMAGE_GEN_PROVIDER=fal
IMAGE_GEN_API_KEY=${_IMAGE_GEN_API_KEY}
GEMINI_API_KEY=${_GEMINI_API_KEY}

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
AI_PROXY_URL=${_AI_PROXY_URL}

# ── Public URLs ───────────────────────────────────────────────────────────────
PUBLIC_API_URL=${PUBLIC_API_URL}
NEXT_PUBLIC_API_URL=${PUBLIC_API_URL}
ENVEOF

  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  success ".env создан с автогенерированными паролями"

  # Проверяем AI-ключи
  HAS_CHANGE_ME=false
  for key in GPTUNNEL_API_KEY HEYGEN_API_KEY RUNWAY_API_KEY IMAGE_GEN_API_KEY; do
    val="$(grep -E "^${key}=" "$APP_DIR/.env" | cut -d= -f2-)"
    if [[ "$val" == "CHANGE_ME" ]]; then
      HAS_CHANGE_ME=true
    fi
  done
  if [ "$HAS_CHANGE_ME" = true ]; then
    warn "AI-ключи со значением CHANGE_ME нужно заполнить позже:"
    echo -e "  ${CYAN}nano $APP_DIR/.env${RESET}"
    echo -e "  Переменные: GPTUNNEL_API_KEY, HEYGEN_API_KEY, RUNWAY_API_KEY, IMAGE_GEN_API_KEY"
    echo ""
    if [ "$NON_INTERACTIVE" != true ]; then
      echo -e "  ${YELLOW}Можете заполнить сейчас или позже (сервисы запустятся и без них).${RESET}"
      read -rp "  Нажмите Enter для продолжения... "
    fi
  fi
fi

# =============================================================================
# 7/13. Конфигурация nginx.conf под домен
# =============================================================================
header "7/13 · Настройка nginx.conf"

NGINX_CONF="$APP_DIR/infra/nginx/nginx.conf"
if [ -f "$NGINX_CONF" ]; then
  if [ -n "$DOMAIN" ]; then
    info "Настраиваем nginx.conf на домен: $DOMAIN"
    # Заменяем хардкод-домен k-m-m.ru на заданный
    sed -i "s/k-m-m\.ru/${DOMAIN}/g" "$NGINX_CONF"
    success "nginx.conf настроен на $DOMAIN"
  else
    info "Домен не задан — создаём HTTP-only nginx.conf для IP"
    cat > "$NGINX_CONF" <<'NGINXEOF'
events {
  worker_connections 1024;
}

http {
  client_max_body_size 500M;

  gzip on;
  gzip_vary on;
  gzip_proxied any;
  gzip_comp_level 4;
  gzip_min_length 256;
  gzip_types
    text/plain text/css text/javascript
    application/json application/javascript application/xml
    image/svg+xml;

  resolver 127.0.0.11 valid=10s ipv6=off;

  server {
    listen 80;
    server_name _;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /api/ {
      set $upstream_api http://api:3000;
      proxy_pass $upstream_api;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_buffering off;
      proxy_cache off;
      chunked_transfer_encoding on;
      proxy_read_timeout 3600s;
    }

    location /storage/ {
      set $upstream_minio http://minio:9000;
      rewrite ^/storage/(.*)$ /$1 break;
      proxy_pass $upstream_minio;
      proxy_http_version 1.1;
      proxy_set_header Host minio:9000;
      proxy_set_header Connection "";
      proxy_hide_header x-amz-request-id;
      proxy_hide_header x-amz-id-2;
      proxy_hide_header x-amz-meta-server-side-encryption;
      proxy_hide_header x-amz-server-side-encryption;
      add_header Cache-Control "public, max-age=86400, immutable";
      add_header X-Content-Type-Options "nosniff" always;
    }

    location /_next/webpack-hmr {
      set $upstream_web http://web:3001;
      proxy_pass $upstream_web;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
    }

    location / {
      set $upstream_web http://web:3001;
      proxy_pass $upstream_web;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
    }
  }
}
NGINXEOF
    success "nginx.conf: HTTP-only конфиг для работы по IP"
  fi
else
  warn "nginx.conf не найден: $NGINX_CONF"
fi

# =============================================================================
# 8/13. Firewall (UFW)
# =============================================================================
header "8/13 · Настройка Firewall (UFW)"

if [ "$SKIP_FIREWALL" = true ]; then
  info "Пропускаем настройку firewall (--skip-firewall)"
else
  ufw --force reset >/dev/null 2>&1
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow ssh >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  success "UFW: SSH + 80 + 443 открыты. Порты 3000/3001/9001 закрыты снаружи"
fi

# =============================================================================
# 9/13. SSL-сертификат Let's Encrypt
# =============================================================================
header "9/13 · SSL-сертификат"

if [ -z "$DOMAIN" ]; then
  info "Домен не задан — SSL пропускаем"
elif [ "$SKIP_SSL" = true ]; then
  info "SSL пропущен (--skip-ssl)"
else
  if ! command -v certbot &>/dev/null; then
    info "Устанавливаем certbot..."
    apt-get install -y -qq certbot
  fi

  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    success "Сертификат уже существует: /etc/letsencrypt/live/$DOMAIN/"
  else
    info "Получаем сертификат (certbot standalone)..."
    # nginx ещё не запущен — порт 80 свободен
    if certbot certonly --standalone \
      --email "admin@${DOMAIN}" --agree-tos --no-eff-email \
      -d "$DOMAIN" \
      --non-interactive; then
      success "Сертификат получен: /etc/letsencrypt/live/$DOMAIN/"
    else
      warn "Не удалось получить SSL-сертификат."
      warn "Возможно, DNS для $DOMAIN ещё не указывает на $SERVER_IP."
      warn "Получите позже: certbot certonly --standalone -d $DOMAIN"
    fi
  fi

  # Автообновление сертификата
  RENEW_HOOK_FILE="/etc/cron.d/certbot-renew-kmmzavod"
  cat > "$RENEW_HOOK_FILE" <<CRONEOF
0 3 * * * root certbot renew --quiet \\
  --pre-hook  "docker compose -f ${APP_DIR}/docker-compose.yml stop nginx" \\
  --post-hook "docker compose -f ${APP_DIR}/docker-compose.yml up -d nginx"
CRONEOF
  chmod 644 "$RENEW_HOOK_FILE"
  success "Автообновление сертификата настроено"
fi

# =============================================================================
# 10/13. Сборка и запуск Docker-сервисов
# =============================================================================
header "10/13 · Сборка и запуск сервисов"

cd "$APP_DIR"

info "Сборка Docker-образов (5–15 минут)..."
BUILD_LOG="/tmp/kmmzavod-build.log"
if ! docker compose build --progress=plain 2>&1 | tee "$BUILD_LOG"; then
  error "Сборка образов не удалась. Лог: $BUILD_LOG"
fi

info "Запуск инфраструктуры (postgres, redis, minio)..."
docker compose up -d postgres redis minio

info "Ожидание готовности PostgreSQL (до 60 сек)..."
WAIT=0
until docker compose exec -T postgres pg_isready -U kmmzavod -q 2>/dev/null; do
  sleep 3; WAIT=$((WAIT + 3))
  [ "$WAIT" -ge 60 ] && error "PostgreSQL не запустился. Логи: docker compose logs postgres"
done
success "PostgreSQL готов"

info "Ожидание готовности Redis (до 30 сек)..."
WAIT=0
until docker compose exec -T redis redis-cli -a "$REDIS_PASS" ping 2>/dev/null | grep -q PONG; do
  sleep 2; WAIT=$((WAIT + 2))
  [ "$WAIT" -ge 30 ] && { warn "Redis не ответил — продолжаем"; break; }
done
success "Redis готов"

info "Запуск всех сервисов..."
docker compose up -d
success "Все сервисы запущены"

# =============================================================================
# 11/13. Миграции базы данных
# =============================================================================
header "11/13 · Миграции базы данных"

info "Ожидание api-контейнера (до 60 сек)..."
WAIT=0
until docker compose exec -T api sh -c 'echo ok' &>/dev/null; do
  sleep 3; WAIT=$((WAIT + 3))
  [ "$WAIT" -ge 60 ] && { warn "API-контейнер не готов — пробуем миграции напрямую"; break; }
done

MIGRATED=false

# Вариант 1: через api-контейнер
if ! $MIGRATED; then
  info "Применяем prisma migrate deploy через api..."
  if docker compose exec -T api \
    sh -c 'cd /app && npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>&1; then
    MIGRATED=true
    success "Миграции применены"
  fi
fi

# Вариант 2: docker compose run (fallback)
if ! $MIGRATED; then
  info "Fallback: docker compose run..."
  if docker compose run --rm \
    -e DATABASE_URL="postgresql://kmmzavod:${PG_PASS}@postgres:5432/kmmzavod" \
    api sh -c 'cd /app && npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>&1; then
    MIGRATED=true
    success "Миграции применены (fallback)"
  fi
fi

if ! $MIGRATED; then
  warn "Миграции не удалось применить автоматически."
  echo -e "  ${CYAN}Запустите вручную:${RESET}"
  echo -e "  ${CYAN}docker compose exec api sh -c 'npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma'${RESET}"
fi

# =============================================================================
# 12/13. Создание MinIO бакета
# =============================================================================
header "12/13 · Создание MinIO бакета"

info "Создаём бакет 'kmmzavod' в MinIO..."

# Ожидаем MinIO health
WAIT=0
until docker compose exec -T minio curl -sf http://localhost:9000/minio/health/live &>/dev/null; do
  sleep 2; WAIT=$((WAIT + 2))
  [ "$WAIT" -ge 30 ] && { warn "MinIO не ответил на health check"; break; }
done

# Используем mc из minio/mc контейнера
ACTUAL_NETWORK=$(docker network ls --format '{{.Name}}' | grep -E "_backend$" | head -1)

if [ -n "$ACTUAL_NETWORK" ]; then
  if docker run --rm --network "$ACTUAL_NETWORK" \
    --entrypoint sh minio/mc -c "
      mc alias set local http://minio:9000 kmmzavod '${MINIO_PASS}' --api S3v4 &&
      mc mb --ignore-existing local/kmmzavod &&
      mc anonymous set download local/kmmzavod/public
    " 2>/dev/null; then
    success "Бакет 'kmmzavod' создан, /public — публичный доступ"
  else
    warn "Не удалось создать бакет. Приложение создаст его при первом запуске."
  fi
else
  warn "Docker-сеть backend не найдена. Бакет создастся автоматически."
fi

# =============================================================================
# 13/13. Создание администратора
# =============================================================================
header "13/13 · Создание администратора"

info "Ожидание API health (до 60 сек)..."
WAIT=0
API_READY=false
until curl -sf --max-time 3 "http://localhost:3000/health" &>/dev/null; do
  sleep 3; WAIT=$((WAIT + 3))
  if [ "$WAIT" -ge 60 ]; then
    warn "API не ответил на /health — пропускаем создание админа"
    break
  fi
done
[ "$WAIT" -lt 60 ] && API_READY=true

if [ "$API_READY" = true ]; then
  ADMIN_COUNT=$(docker compose exec -T postgres psql -U kmmzavod -tAc \
    "SELECT COUNT(*) FROM \"User\" WHERE role='admin';" 2>/dev/null || echo "0")

  if [ "${ADMIN_COUNT:-0}" -gt 0 ]; then
    success "Администратор уже существует"
  else
    info "Создаём администратора: $ADMIN_EMAIL"

    # Экранирование для JSON (предотвращение инъекции)
    ESCAPED_EMAIL=$(json_escape "$ADMIN_EMAIL")
    ESCAPED_PASS=$(json_escape "$ADMIN_PASSWORD")

    REGISTER_BODY="{\"email\":${ESCAPED_EMAIL},\"password\":${ESCAPED_PASS},\"displayName\":\"Admin\",\"tenantName\":\"Platform Admin\"}"

    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "http://localhost:3000/api/v1/auth/register" \
      -H "Content-Type: application/json" \
      -d "$REGISTER_BODY" 2>/dev/null || echo "000")

    if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "409" ]]; then
      # Повышаем до admin — SQL-инъекция предотвращена экранированием
      SAFE_EMAIL="$(sql_escape "$ADMIN_EMAIL")"
      docker compose exec -T postgres psql -U kmmzavod -c \
        "UPDATE \"User\" SET role='admin' WHERE email='${SAFE_EMAIL}';" 2>/dev/null
      success "Администратор создан: $ADMIN_EMAIL"
    else
      warn "Не удалось создать админа (HTTP $HTTP_STATUS)."
      echo -e "  ${CYAN}Создайте вручную: cd $APP_DIR && ./scripts/deploy.sh --create-admin${RESET}"
    fi
  fi
else
  warn "Создайте администратора после запуска API:"
  echo -e "  ${CYAN}cd $APP_DIR && ./scripts/deploy.sh --create-admin${RESET}"
fi

# =============================================================================
# Итог
# =============================================================================
header "Готово!"

info "Статус сервисов:"
docker compose ps --format "table {{.Service}}\t{{.Status}}" 2>/dev/null || docker compose ps
echo ""

# ── Сохранение секретов ──────────────────────────────────────────────────────
SECRETS_FILE="$APP_DIR/.secrets-setup"
{
  echo "# ================================================================"
  echo "# kmmzavod — секреты установки ($(date '+%Y-%m-%d %H:%M'))"
  echo "# УДАЛИТЕ этот файл после сохранения данных в менеджер паролей!"
  echo "# ================================================================"
  echo ""
  echo "# Инфраструктура"
  echo "POSTGRES_PASSWORD=$PG_PASS"
  echo "REDIS_PASSWORD=$REDIS_PASS"
  echo "MINIO_ROOT_PASSWORD=$MINIO_PASS"
  echo "JWT_SECRET=$JWT_SEC"
  echo "ENCRYPTION_KEY=$ENCRYPT_KEY"
  echo ""
  echo "# Администратор"
  echo "ADMIN_EMAIL=$ADMIN_EMAIL"
  if [ "$ADMIN_PASS_GENERATED" = true ]; then
    echo "ADMIN_PASSWORD=$ADMIN_PASSWORD  # автосгенерирован"
  else
    echo "ADMIN_PASSWORD=***  # задан пользователем"
  fi
} > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
chown "$DEPLOY_USER:$DEPLOY_USER" "$SECRETS_FILE"

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║          ✔  Сервер настроен успешно!                         ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}IP:${RESET}     $SERVER_IP"
[ -n "$DOMAIN" ] && echo -e "  ${BOLD}Домен:${RESET}  $DOMAIN"
echo ""
echo -e "  ${BOLD}URL-ы:${RESET}"
if [ -n "$DOMAIN" ]; then
  echo -e "    ${CYAN}https://$DOMAIN${RESET}           — Веб"
  echo -e "    ${CYAN}https://$DOMAIN/api/${RESET}      — API"
else
  echo -e "    ${CYAN}http://$SERVER_IP${RESET}           — Веб"
  echo -e "    ${CYAN}http://$SERVER_IP/api/${RESET}      — API"
fi
echo ""
echo -e "  ${BOLD}Администратор:${RESET}"
echo -e "    Email:    ${CYAN}$ADMIN_EMAIL${RESET}"
if [ "$ADMIN_PASS_GENERATED" = true ]; then
  echo -e "    Пароль:   ${CYAN}$ADMIN_PASSWORD${RESET}  ${YELLOW}(запишите!)${RESET}"
else
  echo -e "    Пароль:   задан при установке"
fi
echo ""
echo -e "  ${BOLD}Секреты:${RESET}  ${CYAN}$SECRETS_FILE${RESET}"
echo -e "  ${YELLOW}  ↑ Сохраните и удалите этот файл!${RESET}"
echo ""
echo -e "  ${BOLD}Управление:${RESET}"
echo -e "    ${CYAN}cd $APP_DIR && docker compose ps${RESET}"
echo -e "    ${CYAN}cd $APP_DIR && docker compose logs -f${RESET}"
echo -e "    ${CYAN}cd $APP_DIR && ./scripts/deploy.sh${RESET}"
echo ""

# Предупреждение о незаполненных AI-ключах
HAS_CHANGE_ME=false
for key in GPTUNNEL_API_KEY HEYGEN_API_KEY RUNWAY_API_KEY IMAGE_GEN_API_KEY; do
  val="$(grep -E "^${key}=" "$APP_DIR/.env" | cut -d= -f2-)"
  if [[ "$val" == "CHANGE_ME" ]]; then
    HAS_CHANGE_ME=true
  fi
done
if [ "$HAS_CHANGE_ME" = true ]; then
  echo -e "  ${YELLOW}${BOLD}⚠  AI-ключи не заполнены!${RESET}"
  echo -e "  ${YELLOW}Генерация видео не будет работать пока не заполните:${RESET}"
  echo -e "  ${CYAN}nano $APP_DIR/.env${RESET}"
  echo -e "  ${YELLOW}Затем: docker compose restart orchestrator api${RESET}"
  echo ""
fi
