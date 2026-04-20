#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — setup.sh
#  Первоначальная установка для ЛОКАЛЬНОЙ РАЗРАБОТКИ
#  Использование: ./scripts/setup.sh
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

# ── Путь к репозиторию ───────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

header "kmmzavod — Установка среды разработки"
echo -e "  Корень проекта: ${BOLD}$REPO_ROOT${RESET}\n"

# =============================================================================
# 1. Проверка зависимостей
# =============================================================================
header "1/7 · Проверка зависимостей"

check_cmd() {
  local cmd="$1" name="${2:-$1}" install_hint="${3:-}"
  if command -v "$cmd" &>/dev/null; then
    local ver
    ver=$("$cmd" --version 2>&1 | head -1)
    success "$name найден: $ver"
  else
    warn "$name не найден."
    [ -n "$install_hint" ] && echo -e "    ${YELLOW}→ $install_hint${RESET}"
    return 1
  fi
}

MISSING=0
check_cmd node  "Node.js"  "Скачать: https://nodejs.org (нужна v20+)" || MISSING=1
check_cmd pnpm  "pnpm"     "Установить: npm install -g pnpm@9"        || MISSING=1
check_cmd docker "Docker"  "Скачать: https://docker.com/products/docker-desktop" || MISSING=1

# Проверяем docker compose (новый плагин)
if docker compose version &>/dev/null 2>&1; then
  success "Docker Compose найден (plugin)"
elif command -v docker-compose &>/dev/null; then
  success "docker-compose найден (standalone)"
  shopt -s expand_aliases 2>/dev/null || true
  alias docker-compose='docker-compose'
else
  warn "Docker Compose не найден."
  echo -e "    ${YELLOW}→ Входит в состав Docker Desktop${RESET}"
  MISSING=1
fi

[ "$MISSING" -eq 1 ] && error "Установите недостающие зависимости и запустите скрипт снова."

# Проверка версии Node
NODE_MAJOR=$(node -e "process.stdout.write(process.version.replace('v','').split('.')[0])")
[ "$NODE_MAJOR" -lt 20 ] && error "Нужен Node.js v20+. Установлен: $(node --version)"

# Проверка Docker daemon
retry_cmd() {
  local tries=0 max=6 delay=2 cmd
  cmd="$*"
  until $cmd; do
    tries=$((tries+1))
    if [ "$tries" -ge $max ]; then
      return 1
    fi
    sleep $delay
  done
  return 0
}

if ! retry_cmd docker info &>/dev/null; then
  error "Docker daemon не запущен или недоступен. Убедитесь, что Docker запущен."
fi

# =============================================================================
# 2. Файл окружения (.env)
# =============================================================================
header "2/7 · Настройка .env"

gen_secret() { openssl rand -base64 "${1:-32}" | tr -d '+=/' | head -c "${1:-32}"; }

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    info "Создаём .env из .env.example..."
    cp .env.example .env
  else
    info "Создаём .env..."
    touch .env
  fi
  success ".env создан"
else
  success ".env уже существует"
fi

# Автозаполняем незаполненные секреты
fix_secret() {
  local var="$1" length="${2:-32}"
  local val
  val=$(grep -E "^${var}=" .env | cut -d= -f2- | tr -d '"' || echo "")
  if [[ -z "$val" || "$val" == *"change_me"* || "$val" == *"CHANGE_ME"* ]]; then
    local new_val
    if [ "$var" = "ENCRYPTION_KEY" ]; then
      new_val=$(openssl rand -hex 32)
    else
      new_val=$(gen_secret "$length")
    fi
    if grep -qE "^${var}=" .env; then
      sed -i "s|^${var}=.*|${var}=${new_val}|" .env
    else
      echo "${var}=${new_val}" >> .env
    fi
    success "$var — автосгенерирован"
  fi
}

fix_secret POSTGRES_PASSWORD 24
fix_secret REDIS_PASSWORD 24
fix_secret MINIO_ROOT_PASSWORD 24
fix_secret JWT_SECRET 48
fix_secret ENCRYPTION_KEY

# Синхронизируем MINIO_SECRET_KEY с MINIO_ROOT_PASSWORD
MINIO_PW=$(grep -E '^MINIO_ROOT_PASSWORD=' .env | cut -d= -f2-)
if [ -n "$MINIO_PW" ]; then
  if grep -qE '^MINIO_SECRET_KEY=' .env; then
    sed -i "s|^MINIO_SECRET_KEY=.*|MINIO_SECRET_KEY=${MINIO_PW}|" .env
  fi
fi

# Синхронизируем POSTGRES_PASSWORD в DATABASE_URL
PG_PW=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
if [ -n "$PG_PW" ]; then
  if grep -qE '^DATABASE_URL=' .env; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://kmmzavod:${PG_PW}@localhost:5433/kmmzavod|" .env
  fi
fi

success "Все секреты заполнены"

# =============================================================================
# 3. Запуск инфраструктуры (postgres, redis, minio)
# =============================================================================
header "3/7 · Запуск инфраструктуры"

info "Запускаем postgres, redis, minio..."
docker compose up -d postgres redis minio

info "Ожидание готовности сервисов (до 30 сек)..."
WAIT=0
until docker compose exec -T postgres pg_isready -U kmmzavod -q 2>/dev/null; do
  sleep 2; WAIT=$((WAIT+2))
  [ "$WAIT" -ge 30 ] && error "PostgreSQL не запустился за 30 сек. Проверьте: docker compose logs postgres"
done
success "PostgreSQL готов"

WAIT=0
until docker compose exec -T redis redis-cli -a "$(grep REDIS_PASSWORD .env | cut -d= -f2)" ping 2>/dev/null | grep -q PONG; do
  sleep 2; WAIT=$((WAIT+2))
  [ "$WAIT" -ge 30 ] && { warn "Redis не ответил на ping — продолжаем..."; break; }
done
success "Redis готов"

success "MinIO запущен (http://localhost:9001)"

# =============================================================================
# 4. Установка зависимостей
# =============================================================================
header "4/7 · Установка npm-зависимостей"

info "Запускаем pnpm install..."
pnpm install
success "Зависимости установлены"

# =============================================================================
# 5. Миграции базы данных
# =============================================================================
header "5/7 · Применение миграций БД"

info "Запускаем prisma migrate deploy..."
cd packages/db
pnpm migrate:deploy
cd "$REPO_ROOT"
success "Миграции применены"

# =============================================================================
# 6. Создание администратора
# =============================================================================
header "6/7 · Создание администратора"

# Проверяем существует ли уже admin
ADMIN_COUNT=$(docker compose exec -T postgres psql -U kmmzavod -tAc \
  "SELECT COUNT(*) FROM \"User\" WHERE role='admin';" 2>/dev/null || echo "0")

if [ "${ADMIN_COUNT:-0}" -gt 0 ]; then
  success "Администратор уже существует — пропускаем"
else
  echo ""
  echo -e "  ${CYAN}Создание первого администратора${RESET}"
  echo -e "  ${YELLOW}Администратор создаётся после запуска API (pnpm dev).${RESET}"
  echo -e "  ${YELLOW}Запустите API в отдельном терминале, затем выполните:${RESET}"
  echo ""
  echo -e "  ${CYAN}curl -X POST http://localhost:3000/api/v1/auth/register \\"
  echo -e "    -H 'Content-Type: application/json' \\"
  echo -e "    -d '{\"email\":\"admin@kmmzavod.ru\",\"password\":\"yourpass\",\"displayName\":\"Admin\",\"tenantName\":\"Admin Org\"}'${RESET}"
  echo ""
  echo -e "  Затем повысьте роль:"
  echo -e "  ${CYAN}docker compose exec postgres psql -U kmmzavod -c \\"
  echo -e "    \"UPDATE \\\\\"User\\\\\" SET role='admin' WHERE email='admin@kmmzavod.ru';\"${RESET}"
fi

# =============================================================================
# 7. Python-окружение для video-processor
# =============================================================================
header "7/7 · Python-окружение (video-processor)"

if command -v python3 &>/dev/null; then
  if [ ! -d "apps/video-processor/.venv" ]; then
    info "Создаём виртуальное окружение Python..."
    python3 -m venv apps/video-processor/.venv
    info "Устанавливаем зависимости..."
    apps/video-processor/.venv/bin/pip install -q -r apps/video-processor/requirements.txt
    success "Python venv создан: apps/video-processor/.venv"
  else
    success "Python venv уже существует"
  fi
else
  warn "Python3 не найден — video-processor будет работать только в Docker"
fi

# =============================================================================
# Итог
# =============================================================================
header "Готово!"

echo ""
echo -e "${BOLD}${GREEN}Среда разработки настроена!${RESET}"
echo ""
echo -e "  ${BOLD}Запуск инфраструктуры:${RESET}"
echo -e "    ${CYAN}docker compose up -d${RESET}"
echo ""
echo -e "  ${BOLD}Запуск в режиме разработки:${RESET}"
echo -e "    ${CYAN}pnpm dev${RESET}"
echo ""
echo -e "  ${BOLD}Полезные ссылки:${RESET}"
echo -e "    API:            ${CYAN}http://localhost:3000${RESET}"
echo -e "    Web:            ${CYAN}http://localhost:3001${RESET}"
echo -e "    MinIO Console:  ${CYAN}http://localhost:9001${RESET}"
echo ""

# =============================================================================
# Итоговое сообщение
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║   ✔  Установка завершена успешно!                    ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Следующий шаг:${RESET} запустить dev-серверы"
echo ""
echo -e "  ${CYAN}pnpm dev${RESET}           — запустить все серверы для разработки"
echo ""
echo -e "  ${BOLD}После запуска:${RESET}"
echo -e "  ${CYAN}http://localhost:3001${RESET}  — веб-интерфейс"
echo -e "  ${CYAN}http://localhost:3000${RESET}  — API"
echo -e "  ${CYAN}http://localhost:9001${RESET}  — MinIO Console"
echo ""
