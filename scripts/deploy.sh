#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — deploy.sh
#  Деплой изменений на сервер (production)
#  Использование: ./scripts/deploy.sh [опции]
#
#  Опции:
#    --no-build      Не пересобирать образы (только перезапустить)
#    --no-cache      Собрать образы без использования кэша
#    --no-migrate    Не применять миграции
#    --service NAME  Пересобрать только один сервис (api | web | orchestrator...)
#    --create-admin  Создать администратора после деплоя
#    --rollback      Запустить сохранённые образы предыдущего релиза
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

# ── Утилиты безопасности ─────────────────────────────────────────────────────
json_escape() {
  local str="$1"
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  str="${str//$'\n'/\\n}"
  str="${str//$'\r'/\\r}"
  str="${str//$'\t'/\\t}"
  printf '"%s"' "$str"
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

# ── Параметры ────────────────────────────────────────────────────────────────
DO_BUILD=true
BUILD_OPTIONS=()
DO_MIGRATE=true
SINGLE_SERVICE=""
CREATE_ADMIN=false
DO_ROLLBACK=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)    DO_BUILD=false ;;
    --no-cache)    BUILD_OPTIONS=(--no-cache) ;;
    --no-migrate)  DO_MIGRATE=false ;;
    --service)     SINGLE_SERVICE="$2"; shift ;;
    --create-admin) CREATE_ADMIN=true ;;
    --rollback)    DO_ROLLBACK=true ;;
    -h|--help)
      cat <<'HELP'
Использование: ./scripts/deploy.sh [опции]

  --no-build       Не пересобирать Docker образы
  --no-cache       Собрать без использования кэша
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
save_release_tag() {
  if grep -q '^KMM_RELEASE_SHA=' .env; then
    sed -i "s/^KMM_RELEASE_SHA=.*/KMM_RELEASE_SHA=$KMM_RELEASE_SHA/" .env
  else
    printf '\nKMM_RELEASE_SHA=%s\n' "$KMM_RELEASE_SHA" >> .env
  fi
}

if $DO_ROLLBACK; then
  [ -s .deploy-release.previous ] || error "Нет сохранённого предыдущего релиза"
  export KMM_RELEASE_SHA="$(cat .deploy-release.previous)"
  [[ "$KMM_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || error "Некорректный идентификатор релиза"
  export COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
  for service in api orchestrator editor video-processor web; do
    docker image inspect "kmmzavod-$service:$KMM_RELEASE_SHA" >/dev/null || error "Образ предыдущего релиза $service недоступен"
  done
  docker compose up -d --no-build --no-deps --wait api orchestrator editor video-processor web
  save_release_tag
  success "Запущен предыдущий релиз $KMM_RELEASE_SHA. Схема БД сохранена."
  exit 0
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

export COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
export KMM_RELEASE_SHA="$(git rev-parse HEAD)"

# =============================================================================
# 2. Проверка .env
# =============================================================================
header "2/6 · Проверка конфигурации"

[ ! -f .env ] && error ".env не найден. Скопируйте .env.example → .env и заполните."
if ! grep -qE '^INTERNAL_SERVICE_TOKEN=.+$' .env; then
  command -v openssl >/dev/null || error "Для генерации INTERNAL_SERVICE_TOKEN нужен openssl"
  token="$(openssl rand -hex 32)" || error "Не удалось сгенерировать INTERNAL_SERVICE_TOKEN"
  (umask 077; printf '\nINTERNAL_SERVICE_TOKEN=%s\n' "$token" >> .env)
  unset token
fi

# Проверяем что docker доступен
docker info &>/dev/null 2>&1 || error "Docker daemon не запущен"
docker compose version &>/dev/null 2>&1 || error "Docker Compose не найден"

if ! grep -qE '^MINIO_IMAGE=.+$' .env; then
  minio_container="$(docker compose ps -q minio)"
  if [ -n "$minio_container" ]; then
    minio_id="$(docker inspect --format '{{.Image}}' "$minio_container")"
    minio_digest="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$minio_id")"
    if [[ "$minio_digest" == *@sha256:* ]]; then
      printf '\nMINIO_IMAGE=%s\n' "$minio_digest" >> .env
    fi
  fi
fi

success ".env найден, Docker доступен"

# Показываем текущий статус сервисов
echo ""
info "Текущий статус сервисов:"
docker compose ps --format "table {{.Service}}\t{{.Status}}" 2>/dev/null || docker compose ps 2>/dev/null | tail -n +2 | sed 's/^/  /'

# =============================================================================
# 3. Сборка Docker образов
# =============================================================================
if $DO_BUILD; then
  header "3/6 · Сборка Docker образов"

  if [ -n "$SINGLE_SERVICE" ]; then
    info "Сборка только: ${BOLD}$SINGLE_SERVICE${RESET}"
    BUILD_OPTIONS+=("$SINGLE_SERVICE")
  else
    info "Сборка всех сервисов..."
  fi

  if ! docker compose --parallel "${COMPOSE_PARALLEL_LIMIT:-1}" build "${BUILD_OPTIONS[@]}"; then
    docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    storage_paths=("$REPO_ROOT")
    for storage in "$docker_root" /var/lib/containerd; do
      if [ -d "$storage" ]; then storage_paths+=("$storage"); fi
    done
    info "Свободное место и inode на файловых системах Docker и проекта:"
    df -hP -- "${storage_paths[@]}" >&2 || true
    df -iP -- "${storage_paths[@]}" >&2 || true
    error "Сборка образов не удалась. Проверьте сообщение Docker выше."
  fi
  success "Образы собраны"
else
  header "3/6 · Сборка пропущена (--no-build)"
fi

# =============================================================================
# 4. Миграции базы данных — ДО запуска нового кода
# =============================================================================
# Новый код может обращаться к новым колонкам/таблицам, поэтому схема обновляется
# раньше, чем стартуют новые контейнеры. Миграции запускаются из НОВОГО образа api
# (docker compose run): в уже работающем api-контейнере лежат старые migrations/.
if $DO_MIGRATE; then
  header "4/6 · Миграции базы данных"

  docker compose up -d postgres redis minio

  info "Ожидаем готовности PostgreSQL..."
  WAIT=0
  until docker compose exec -T postgres pg_isready -U kmmzavod -q 2>/dev/null; do
    sleep 2; WAIT=$((WAIT+2))
    [ "$WAIT" -ge 30 ] && error "PostgreSQL не ответил за 30 сек"
  done

  info "Сохраняем резервную копию PostgreSQL перед миграциями..."
  (umask 077
    mkdir -p .deploy-backups &&
    backup=".deploy-backups/pg-${KMM_RELEASE_SHA}-$(date +%s).dump" &&
    docker compose exec -T postgres pg_dump -U kmmzavod -Fc kmmzavod > "$backup.tmp" &&
    docker compose exec -T postgres pg_restore --list < "$backup.tmp" >/dev/null &&
    mv -- "$backup.tmp" "$backup"
  ) || error "Не удалось проверить резервную копию PostgreSQL"
  info "Применяем миграции Prisma..."
  if docker compose run --rm --no-deps api     sh -c 'cd /app && npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma' 2>&1; then
    success "Миграции применены"
  else
    # Не запускаем новый код поверх несовпадающей схемы — старые контейнеры продолжают работать
    error "Миграции не применены — обновление сервисов отменено. Запустите вручную:
  docker compose run --rm --no-deps api sh -c 'cd /app && npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma'"
  fi
else
  header "4/6 · Миграции пропущены (--no-migrate)"
fi

# =============================================================================
# 5. Обновление сервисов
# =============================================================================
header "5/6 · Обновление сервисов"

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

  # Все сервисы из docker-compose.yml (api, orchestrator, video-processor, editor, web,
  # nginx, farm-proxy-relay, ...) — без явного списка, чтобы новые сервисы не выпадали
  # из деплоя. Сервисы под profiles (publisher) стартуют только если профиль включён
  # через COMPOSE_PROFILES.
  docker compose up -d --remove-orphans --wait
  if [ -s .deploy-release.current ] && [ "$(cat .deploy-release.current)" != "$KMM_RELEASE_SHA" ]; then
    cp -- .deploy-release.current .deploy-release.previous
  fi
  printf '%s\n' "$KMM_RELEASE_SHA" > .deploy-release.current
  save_release_tag

  success "Все сервисы обновлены"
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

  # Безопасное экранирование для JSON
  ESCAPED_EMAIL=$(json_escape "$ADMIN_EMAIL")
  ESCAPED_PASS=$(json_escape "$ADMIN_PASS")
  REGISTER_BODY="{\"email\":${ESCAPED_EMAIL},\"password\":${ESCAPED_PASS},\"displayName\":\"Admin\",\"tenantName\":\"Platform Admin\"}"

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${API_PORT}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    -d "$REGISTER_BODY" 2>/dev/null || echo "000")

  if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "409" ]]; then
    # Безопасное обновление роли (SQL-инъекция предотвращена экранированием)
    SAFE_EMAIL="$(sql_escape "$ADMIN_EMAIL")"
    docker compose exec -T postgres psql -U kmmzavod -c \
      "UPDATE \"users\" SET role='admin' WHERE email='${SAFE_EMAIL}';"
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
