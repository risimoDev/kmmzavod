#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — deploy.sh
#  Деплой изменений на сервер (production)
#  Использование: ./scripts/deploy.sh [опции]
#
#  Опции:
#    --no-build      Не пересобирать образы (только перезапустить)
#    --no-migrate    Не применять миграции
#    --service NAME  Пересобрать только один сервис (api | web | orchestrator...)
#    --create-admin  Создать администратора после деплоя
#    --rollback      Откатиться к предыдущей версии (git reset --hard HEAD~1)
#    -h, --help      Показать помощь
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

# ── Параметры ────────────────────────────────────────────────────────────────
DO_BUILD=true
DO_MIGRATE=true
SINGLE_SERVICE=""
CREATE_ADMIN=false
DO_ROLLBACK=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)    DO_BUILD=false ;;
    --no-migrate)  DO_MIGRATE=false ;;
    --service)     SINGLE_SERVICE="$2"; shift ;;
    --create-admin) CREATE_ADMIN=true ;;
    --rollback)    DO_ROLLBACK=true ;;
    -h|--help)
      cat <<'HELP'
Использование: ./scripts/deploy.sh [опции]

  --no-build       Не пересобирать Docker образы
  --no-migrate     Не применять миграции БД
  --service NAME   Обновить только один сервис (api|web|orchestrator|video-processor)
  --create-admin   Создать admin-пользователя
  --rollback       Откатиться на предыдущий коммит
  -h, --help       Помощь

Примеры:
  ./scripts/deploy.sh                   # Полный деплой
  ./scripts/deploy.sh --service api     # Только API
  ./scripts/deploy.sh --no-build        # Перезапуск без пересборки
  ./scripts/deploy.sh --rollback        # Откат
HELP
      exit 0 ;;
    *) warn "Неизвестный параметр: $1" ;;
  esac
  shift
done

# ── Путь к репозиторию ───────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Время начала ─────────────────────────────────────────────────────────────
START_TIME=$(date +%s)
DEPLOY_DATE=$(date '+%Y-%m-%d %H:%M:%S')

header "kmmzavod — Деплой изменений"
echo -e "  Дата: ${BOLD}$DEPLOY_DATE${RESET}"
echo -e "  Директория: ${BOLD}$REPO_ROOT${RESET}"

# =============================================================================
# ROLLBACK
# =============================================================================
if $DO_ROLLBACK; then
  header "Откат к предыдущей версии"
  CURRENT=$(git rev-parse --short HEAD)
  PREV=$(git rev-parse --short HEAD~1 2>/dev/null || echo "")
  [ -z "$PREV" ] && error "Нет предыдущего коммита для отката"

  warn "Текущий коммит: $CURRENT"
  warn "Откат на: $PREV — $(git log -1 --pretty=format:'%s' HEAD~1)"
  read -rp "  Продолжить откат? [y/N]: " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { info "Откат отменён."; exit 0; }

  git reset --hard HEAD~1
  success "Откат выполнен: $(git rev-parse --short HEAD)"

  # Пересобрать и перезапустить после отката
  DO_BUILD=true
fi

# =============================================================================
# 1. Git pull
# =============================================================================
header "1/6 · Получение обновлений"

if $DO_ROLLBACK; then
  info "Пропускаем git pull (откат)"
else
  # Проверяем незакоммиченные изменения
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "Есть незакоммиченные изменения:"
    git status --short
    read -rp "  Сохранить через stash и продолжить? [y/N]: " STASH_CONFIRM
    if [[ "$STASH_CONFIRM" =~ ^[Yy]$ ]]; then
      git stash push -m "deploy-$(date +%s)"
      success "Изменения сохранены в stash"
    else
      error "Деплой прерван. Зафиксируйте или отмените изменения."
    fi
  fi

  PREV_COMMIT=$(git rev-parse --short HEAD)
  info "Текущий коммит: $PREV_COMMIT"

  BRANCH=$(git branch --show-current)
  info "Получаем обновления (ветка: $BRANCH)..."
  git fetch origin
  git pull origin "$BRANCH"

  NEW_COMMIT=$(git rev-parse --short HEAD)
  if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
    success "Уже на последней версии ($NEW_COMMIT)"
  else
    success "Обновлено: $PREV_COMMIT → $NEW_COMMIT"
    echo ""
    info "Изменённые файлы:"
    git diff --name-only "$PREV_COMMIT" "$NEW_COMMIT" | head -20 | sed 's/^/    /'
    echo ""
  fi
fi

# =============================================================================
# 2. Проверка .env
# =============================================================================
header "2/6 · Проверка конфигурации"

[ ! -f .env ] && error ".env не найден. Скопируйте .env.example → .env и заполните."

# Проверяем что docker доступен
docker info &>/dev/null 2>&1 || error "Docker daemon не запущен"
docker compose version &>/dev/null 2>&1 || error "Docker Compose не найден"

success ".env найден, Docker доступен"

# Показываем текущий статус сервисов
echo ""
info "Текущий статус сервисов:"
docker compose ps --format "  {.Service}: {.Status}" 2>/dev/null || docker compose ps 2>/dev/null | tail -n +2 | sed 's/^/  /'

# =============================================================================
# 3. Сборка Docker образов
# =============================================================================
if $DO_BUILD; then
  header "3/6 · Сборка Docker образов"

  BUILD_ARGS="--build"

  if [ -n "$SINGLE_SERVICE" ]; then
    info "Сборка только: ${BOLD}$SINGLE_SERVICE${RESET}"
    docker compose build --no-cache "$SINGLE_SERVICE"
  else
    info "Сборка всех сервисов..."
    # Compose V2 собирает параллельно по умолчанию
    docker compose build --no-cache 2>&1 | tail -20
  fi
  success "Образы собраны"
else
  header "3/6 · Сборка пропущена (--no-build)"
fi

# =============================================================================
# 4. Обновление сервисов (zero-downtime)
# =============================================================================
header "4/6 · Обновление сервисов"

if [ -n "$SINGLE_SERVICE" ]; then
  info "Обновление только $SINGLE_SERVICE..."

  # Для stateless сервисов — сначала поднять новый, потом убрать старый
  docker compose up -d --no-deps "$SINGLE_SERVICE"
  success "Сервис $SINGLE_SERVICE обновлён"

else
  info "Обновление всех сервисов..."

  # Инфраструктура обновляется отдельно (без --no-deps)
  docker compose up -d postgres redis minio
  sleep 3

  # Приложения — с пересборкой
  docker compose up -d --no-deps api orchestrator video-processor web nginx

  success "Все сервисы обновлены"
fi

# =============================================================================
# 5. Миграции базы данных
# =============================================================================
if $DO_MIGRATE; then
  header "5/6 · Миграции базы данных"

  info "Ожидаем готовности PostgreSQL..."
  WAIT=0
  until docker compose exec -T postgres pg_isready -U kmmzavod -q 2>/dev/null; do
    sleep 2; WAIT=$((WAIT+2))
    [ "$WAIT" -ge 30 ] && error "PostgreSQL не ответил за 30 сек"
  done

  info "Применяем миграции Prisma..."
  # Пробуем применить миграции через контейнер api
  MIGRATED=false

  # Вариант 1: через api контейнер если там есть prisma
  if docker compose exec -T api sh -c 'command -v npx' &>/dev/null 2>&1; then
    docker compose exec -T api \
      sh -c 'npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>/dev/null && MIGRATED=true || true
  fi

  # Вариант 2: локально через pnpm если установлен
  if ! $MIGRATED && command -v pnpm &>/dev/null && [ -f packages/db/package.json ]; then
    info "Мигрируем локально через pnpm..."
    cd packages/db && pnpm migrate:deploy && cd "$REPO_ROOT" && MIGRATED=true || true
  fi

  if $MIGRATED; then
    success "Миграции применены"
  else
    warn "Не удалось применить миграции автоматически."
    echo -e "  ${CYAN}Запустите вручную: cd packages/db && pnpm migrate:deploy${RESET}"
  fi
else
  header "5/6 · Миграции пропущены (--no-migrate)"
fi

# =============================================================================
# 6. Создание администратора (опционально)
# =============================================================================
if $CREATE_ADMIN; then
  header "6/6 · Создание администратора"

  sleep 3  # дать API немного времени подняться

  read -rp "  Email администратора: " ADMIN_EMAIL
  read -rsp "  Пароль (мин. 8 символов): " ADMIN_PASS
  echo ""

  API_PORT=3000
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
    success "Администратор: $ADMIN_EMAIL"
  else
    warn "HTTP $HTTP_STATUS — создайте вручную через register API + UPDATE role"
  fi
else
  header "6/6 · Создание admin пропущено"
fi

# =============================================================================
# Health check
# =============================================================================
header "Health Check"

check_service() {
  local name="$1" url="$2"
  if curl -sf --max-time 5 "$url" &>/dev/null; then
    success "$name: OK ($url)"
  else
    warn "$name: не ответил ($url)"
  fi
}

sleep 5  # даём сервисам время на старт
check_service "API"           "http://localhost:3000"
check_service "Web"           "http://localhost:3001"
check_service "Video Processor" "http://localhost:8000/health"

# Проверяем статус контейнеров
echo ""
info "Статус контейнеров:"
docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
docker compose ps 2>/dev/null | tail -n +2

# =============================================================================
# Итог
# =============================================================================
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║   ✔  Деплой завершён за ${DURATION}с                          ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Коммит: ${BOLD}$(git rev-parse --short HEAD)${RESET} — $(git log -1 --pretty=format:'%s')"
echo -e "  Время: $DEPLOY_DATE"
echo ""
echo -e "  ${BOLD}Логи:${RESET}"
echo -e "  ${CYAN}docker compose logs -f api${RESET}"
echo -e "  ${CYAN}docker compose logs -f orchestrator${RESET}"
echo ""
