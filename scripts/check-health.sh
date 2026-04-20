#!/usr/bin/env bash
# =============================================================================
#  kmmzavod — check-health.sh
#  Диагностика и автоисправление production-окружения
#
#  Использование:
#    bash scripts/check-health.sh               # диагностика + автофикс
#    bash scripts/check-health.sh --dry-run     # только диагностика, без изменений
#    bash scripts/check-health.sh --fix-only    # только автофиксы без полного отчёта
#
#  Что проверяет:
#    - Docker: статус и health всех контейнеров
#    - API: /health endpoint (db + redis)
#    - Web: HTTP 200 ответ
#    - nginx: домен в конфиге, SSL сертификат
#    - .env: наличие обязательных переменных и CHANGE_ME-заглушек
#    - БД: незаконченные/упавшие Prisma-миграции
#    - Redis: eviction policy (предупреждение)
#    - MinIO: доступность и наличие бакета
#
#  Что исправляет автоматически:
#    - nginx.conf: домен не совпадает с DOMAIN → sed-замена + reload
#    - nginx: не запущен → docker compose up -d nginx
#    - Упавшая Prisma-миграция → resolve --rolled-back + migrate deploy
#    - Контейнер в Restarting → показывает tail логов + предлагает rebuild
#    - CORS_ORIGIN отсутствует в .env → добавляет из PUBLIC_API_URL
# =============================================================================

set -euo pipefail

# ── Цвета ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
MAGENTA='\033[0;35m'

ok()     { echo -e "  ${GREEN}✔  $*${RESET}"; ((PASS++)) || true; }
fail()   { echo -e "  ${RED}✖  $*${RESET}"; ((FAIL++)) || true; }
warn()   { echo -e "  ${YELLOW}⚠  $*${RESET}"; ((WARN++)) || true; }
fixed()  { echo -e "  ${CYAN}⚙  ИСПРАВЛЕНО: $*${RESET}"; ((FIXED++)) || true; }
info()   { echo -e "  ${BLUE}▶  $*${RESET}"; }
header() { echo -e "\n${BOLD}${MAGENTA}══  $*  ══${RESET}"; }

# ── Счётчики ─────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; WARN=0; FIXED=0
DRY_RUN=false
FIX_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --fix-only)  FIX_ONLY=true ;;
  esac
done

# ── Корень проекта ────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env"

echo -e "\n${BOLD}${BLUE}kmmzavod — Health Check & Autofix${RESET}"
echo -e "  Директория: ${BOLD}$REPO_ROOT${RESET}"
echo -e "  Режим:      ${BOLD}$([ "$DRY_RUN" = true ] && echo 'dry-run (без изменений)' || echo 'autofix включён')${RESET}"
echo -e "  Время:      $(date '+%Y-%m-%d %H:%M:%S')"

# =============================================================================
# HELPER: безопасное чтение из .env
# =============================================================================
env_get() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
env_has() { grep -qE "^${1}=.+" "$ENV_FILE" 2>/dev/null; }

# =============================================================================
# 1. .env файл
# =============================================================================
header "1. Конфигурация .env"

if [ ! -f "$ENV_FILE" ]; then
  fail ".env не найден: $ENV_FILE"
else
  ok ".env существует"

  REQUIRED_VARS=(
    POSTGRES_PASSWORD DATABASE_URL
    REDIS_PASSWORD
    MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY
    JWT_SECRET
    PUBLIC_API_URL
  )

  MISSING_VARS=()
  CHANGE_ME_VARS=()

  for var in "${REQUIRED_VARS[@]}"; do
    val="$(env_get "$var")"
    if [ -z "$val" ]; then
      MISSING_VARS+=("$var")
    elif echo "$val" | grep -qi "change_me\|CHANGE_ME"; then
      CHANGE_ME_VARS+=("$var")
    fi
  done

  if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    fail "Отсутствуют обязательные переменные: ${MISSING_VARS[*]}"
    info "Добавьте в $ENV_FILE"
  else
    ok "Все обязательные переменные заданы"
  fi

  if [ ${#CHANGE_ME_VARS[@]} -gt 0 ]; then
    warn "Переменные со значением CHANGE_ME (нужно заполнить): ${CHANGE_ME_VARS[*]}"
  fi

  # Проверить AI-ключи (не обязательные, но нужны для работы)
  AI_KEYS=(GPTUNNEL_API_KEY HEYGEN_API_KEY RUNWAY_API_KEY IMAGE_GEN_API_KEY)
  AI_MISSING=()
  for key in "${AI_KEYS[@]}"; do
    val="$(env_get "$key")"
    if [ -z "$val" ] || echo "$val" | grep -qi "change_me"; then
      AI_MISSING+=("$key")
    fi
  done
  if [ ${#AI_MISSING[@]} -gt 0 ]; then
    warn "AI-ключи не заполнены (генерация видео не будет работать): ${AI_MISSING[*]}"
  else
    ok "AI-ключи заданы"
  fi

  # Автофикс: добавить CORS_ORIGIN если нет
  if ! env_has "CORS_ORIGIN"; then
    PUBLIC_API="$(env_get "PUBLIC_API_URL")"
    if [ -n "$PUBLIC_API" ]; then
      if [ "$DRY_RUN" = false ]; then
        echo "CORS_ORIGIN=${PUBLIC_API}" >> "$ENV_FILE"
        fixed "CORS_ORIGIN добавлен в .env: $PUBLIC_API"
      else
        warn "[dry-run] CORS_ORIGIN отсутствует — был бы добавлен: $PUBLIC_API"
      fi
    else
      warn "CORS_ORIGIN отсутствует в .env и PUBLIC_API_URL тоже не задан"
    fi
  else
    ok "CORS_ORIGIN задан: $(env_get CORS_ORIGIN)"
  fi
fi

# =============================================================================
# 2. Docker — статус контейнеров
# =============================================================================
header "2. Статус контейнеров Docker"

if ! command -v docker &>/dev/null; then
  fail "Docker не установлен"
  exit 1
fi

if ! docker compose ps &>/dev/null; then
  fail "docker compose не работает или нет прав"
  exit 1
fi

SERVICES=(postgres redis minio api orchestrator web video-processor nginx)
ALL_HEALTHY=true

for svc in "${SERVICES[@]}"; do
  # Получить статус
  STATUS=$(docker compose ps --format '{{.Status}}' "$svc" 2>/dev/null | head -1)
  NAME=$(docker compose ps --format '{{.Name}}' "$svc" 2>/dev/null | head -1)

  if [ -z "$STATUS" ]; then
    fail "$svc: контейнер не найден"
    ALL_HEALTHY=false
    continue
  fi

  case "$STATUS" in
    *"(healthy)"*|*"healthy"*)
      ok "$svc: $STATUS" ;;
    *"(health: starting)"*)
      warn "$svc: запускается (health: starting)" ;;
    *"(unhealthy)"*)
      fail "$svc: UNHEALTHY"
      ALL_HEALTHY=false
      info "Логи $svc (последние 10 строк):"
      docker compose logs "$svc" --tail=10 2>/dev/null | sed 's/^/    /' || true
      ;;
    *"Restarting"*)
      fail "$svc: RESTARTING (циклический перезапуск)"
      ALL_HEALTHY=false
      info "Логи $svc (последние 15 строк):"
      docker compose logs "$svc" --tail=15 2>/dev/null | sed 's/^/    /' || true
      if [ "$DRY_RUN" = false ]; then
        echo ""
        read -rp "  Попробовать пересобрать $svc? [y/N]: " REBUILD
        if [[ "$REBUILD" =~ ^[Yy]$ ]]; then
          docker compose build "$svc" && docker compose up -d "$svc"
          fixed "$svc пересобран и перезапущен"
        fi
      fi
      ;;
    *"Up"*)
      # Up без healthcheck (nginx)
      ok "$svc: $STATUS" ;;
    *"Exited"*)
      fail "$svc: STOPPED ($STATUS)"
      ALL_HEALTHY=false
      if [ "$DRY_RUN" = false ]; then
        docker compose up -d "$svc" && fixed "$svc запущен"
      fi
      ;;
    *)
      warn "$svc: неизвестный статус: $STATUS" ;;
  esac
done

# =============================================================================
# 3. API health endpoint
# =============================================================================
header "3. API /health"

API_URL="http://127.0.0.1:3000"

# Ждём до 15 сек если только что запустился
for i in $(seq 1 3); do
  HEALTH_RESP=$(docker compose exec -T api wget -qO- "http://127.0.0.1:3000/health" 2>/dev/null || echo "")
  [ -n "$HEALTH_RESP" ] && break
  sleep 5
done

if [ -z "$HEALTH_RESP" ]; then
  fail "API /health не отвечает (порт 3000)"
else
  API_STATUS=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "parse_error")
  DB_STATUS=$(echo "$HEALTH_RESP"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['checks'].get('db','?'))" 2>/dev/null || echo "?")
  RD_STATUS=$(echo "$HEALTH_RESP"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['checks'].get('redis','?'))" 2>/dev/null || echo "?")

  if [ "$API_STATUS" = "ok" ]; then
    ok "API: status=ok  db=$DB_STATUS  redis=$RD_STATUS"
  else
    fail "API: status=$API_STATUS  db=$DB_STATUS  redis=$RD_STATUS"
    fail "Полный ответ: $HEALTH_RESP"
  fi
fi

# =============================================================================
# 4. Web (Next.js)
# =============================================================================
header "4. Web (Next.js)"

WEB_CODE=$(curl -sL -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:3001" 2>/dev/null || echo "000")
if [[ "$WEB_CODE" == "200" || "$WEB_CODE" == "301" || "$WEB_CODE" == "302" ]]; then
  ok "Web отвечает: HTTP $WEB_CODE"
else
  fail "Web не отвечает: HTTP $WEB_CODE"
fi

# =============================================================================
# 5. nginx — конфиг и сертификат
# =============================================================================
header "5. nginx + SSL"

NGINX_CONF="$REPO_ROOT/infra/nginx/nginx.conf"
DOMAIN="$(env_get DOMAIN 2>/dev/null || true)"

# Если DOMAIN не в .env, вытащить из nginx.conf
if [ -z "$DOMAIN" ]; then
  DOMAIN=$(grep -oP 'server_name \K[a-z0-9._-]+(?= )' "$NGINX_CONF" 2>/dev/null | grep -v '^_$' | head -1 || true)
fi

if [ -z "$DOMAIN" ]; then
  warn "Не удалось определить домен"
else
  info "Домен: $DOMAIN"

  # Проверить что nginx.conf настроен на этот домен
  if grep -q "server_name $DOMAIN" "$NGINX_CONF" 2>/dev/null; then
    ok "nginx.conf: server_name настроен на $DOMAIN"
  else
    # Проверить на k-m-m.ru (хардкод из репо)
    OLD_DOMAIN=$(grep -oP 'server_name \K[a-z0-9._-]+(?= )' "$NGINX_CONF" 2>/dev/null | grep -v '^_$' | head -1 || echo "?")
    fail "nginx.conf: server_name=$OLD_DOMAIN, ожидался $DOMAIN"
    if [ "$DRY_RUN" = false ]; then
      git checkout "$NGINX_CONF" 2>/dev/null || true
      sed -i "s/k-m-m\.ru/${DOMAIN}/g" "$NGINX_CONF"
      docker compose restart nginx
      fixed "nginx.conf перенастроен на $DOMAIN и nginx перезапущен"
    fi
  fi

  # Проверить SSL-сертификат
  CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  if [ -f "$CERT_PATH" ]; then
    EXPIRY=$(openssl x509 -enddate -noout -in "$CERT_PATH" 2>/dev/null | cut -d= -f2 || echo "?")
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [ "$DAYS_LEFT" -lt 0 ]; then
      fail "SSL сертификат ИСТЁК ($EXPIRY)"
    elif [ "$DAYS_LEFT" -lt 14 ]; then
      warn "SSL сертификат истекает через ${DAYS_LEFT} дней ($EXPIRY)"
      if [ "$DRY_RUN" = false ]; then
        docker compose stop nginx
        certbot renew --standalone --quiet
        docker compose up -d nginx
        fixed "SSL сертификат обновлён"
      fi
    else
      ok "SSL сертификат действителен: ${DAYS_LEFT} дней (до $EXPIRY)"
    fi
  else
    fail "SSL сертификат не найден: $CERT_PATH"
    warn "Получите сертификат:"
    warn "  docker compose stop nginx"
    warn "  certbot certonly --standalone -d $DOMAIN"
    warn "  docker compose up -d nginx"
  fi

  # Проверить что nginx отвечает снаружи (HTTP)
  HTTP_CODE=$(curl -sL -o /dev/null -w "%{http_code}" --max-time 10 "http://${DOMAIN}" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "301" || "$HTTP_CODE" == "308" ]]; then
    ok "HTTP http://$DOMAIN → $HTTP_CODE"
  else
    warn "HTTP http://$DOMAIN → $HTTP_CODE (возможно DNS не настроен)"
  fi

  HTTPS_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "https://${DOMAIN}" 2>/dev/null || echo "000")
  if [[ "$HTTPS_CODE" == "200" || "$HTTPS_CODE" == "301" ]]; then
    ok "HTTPS https://$DOMAIN → $HTTPS_CODE"
  else
    fail "HTTPS https://$DOMAIN → $HTTPS_CODE"
  fi
fi

# =============================================================================
# 6. База данных — миграции
# =============================================================================
header "6. Prisma миграции"

SCHEMA_PATH="packages/db/prisma/schema.prisma"

# Проверить упавшие миграции
FAILED_MIGRATION=$(docker compose exec -T api \
  node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.\$queryRaw\`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL\`
  .then(r=>{r.forEach(m=>console.log(m.migration_name));p.\$disconnect();})
  .catch(e=>{console.error('ERR:'+e.message);p.\$disconnect();});
" 2>/dev/null | grep -v '^$' || true)

if [ -n "$FAILED_MIGRATION" ]; then
  fail "Найдена незавершённая миграция: $FAILED_MIGRATION"
  if [ "$DRY_RUN" = false ]; then
    info "Помечаем как rolled-back и повторно деплоим..."
    docker compose exec -T api npx prisma migrate resolve \
      --rolled-back "$FAILED_MIGRATION" \
      --schema="$SCHEMA_PATH" 2>&1 | tail -3
    docker compose exec -T api npx prisma migrate deploy \
      --schema="$SCHEMA_PATH" 2>&1 | tail -5
    fixed "Миграция $FAILED_MIGRATION исправлена"
  fi
else
  # Проверить что все применены
  PENDING=$(docker compose exec -T api \
    node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.\$queryRaw\`SELECT COUNT(*) as cnt FROM _prisma_migrations WHERE finished_at IS NOT NULL\`
  .then(r=>{console.log(r[0].cnt);p.\$disconnect();})
  .catch(()=>{console.log('?');p.\$disconnect();});
" 2>/dev/null | tr -d '[:space:]' || echo "?")
  ok "Миграции: $PENDING применены, нет упавших"
fi

# =============================================================================
# 7. Redis — eviction policy
# =============================================================================
header "7. Redis"

REDIS_PWD="$(env_get REDIS_PASSWORD)"
EVICTION=$(docker compose exec -T redis \
  redis-cli -a "$REDIS_PWD" config get maxmemory-policy 2>/dev/null | tail -1 || echo "?")

case "$EVICTION" in
  "allkeys-lru"|"allkeys-lfu")
    warn "Redis eviction policy: $EVICTION"
    warn "BullMQ рекомендует 'noeviction' — задачи могут теряться при переполнении памяти"
    warn "Чтобы исправить: docker compose exec redis redis-cli -a \$REDIS_PASSWORD config set maxmemory-policy noeviction"
    ;;
  "noeviction")
    ok "Redis eviction policy: noeviction (рекомендуемое)" ;;
  *)
    warn "Redis eviction policy: $EVICTION" ;;
esac

# =============================================================================
# 8. MinIO — доступность и бакет
# =============================================================================
header "8. MinIO"

MINIO_USER="$(env_get MINIO_ROOT_USER)"
MINIO_PASS="$(env_get MINIO_ROOT_PASSWORD)"
MINIO_BUCKET="$(env_get MINIO_BUCKET 2>/dev/null || echo 'kmmzavod')"
[ -z "$MINIO_BUCKET" ] && MINIO_BUCKET="kmmzavod"

MINIO_HEALTH=$(curl -sf --max-time 5 "http://127.0.0.1:9000/minio/health/live" 2>/dev/null && echo "ok" || echo "fail")
if [ "$MINIO_HEALTH" = "ok" ]; then
  ok "MinIO API доступен (:9000)"
else
  fail "MinIO API недоступен (:9000)"
fi

# Проверить бакет через mc (если установлен)
if docker compose exec -T minio mc --version &>/dev/null; then
  BUCKET_EXISTS=$(docker compose exec -T minio \
    mc alias set local http://localhost:9000 "$MINIO_USER" "$MINIO_PASS" 2>/dev/null && \
    docker compose exec -T minio mc ls "local/$MINIO_BUCKET" &>/dev/null && echo "yes" || echo "no")
  if [ "$BUCKET_EXISTS" = "yes" ]; then
    ok "MinIO бакет '$MINIO_BUCKET' существует"
  else
    fail "MinIO бакет '$MINIO_BUCKET' не найден"
    if [ "$DRY_RUN" = false ]; then
      docker compose exec -T minio \
        sh -c "mc alias set local http://localhost:9000 '$MINIO_USER' '$MINIO_PASS' && \
               mc mb local/$MINIO_BUCKET --ignore-existing && \
               mc anonymous set download local/$MINIO_BUCKET/public"
      fixed "MinIO бакет '$MINIO_BUCKET' создан"
    fi
  fi
fi

# =============================================================================
# 9. git — есть ли непримененные изменения
# =============================================================================
header "9. Git состояние"

GIT_BEHIND=$(git fetch origin main --dry-run 2>&1 | grep -c '\[new\|behind' || true)
LOCAL_DIFF=$(git diff --name-only HEAD origin/main 2>/dev/null | wc -l | tr -d ' ' || echo "0")

if [ "$LOCAL_DIFF" -gt 0 ]; then
  warn "Есть $LOCAL_DIFF файл(ов) отличающихся от origin/main — возможно нужен git pull"
  git diff --name-only HEAD origin/main 2>/dev/null | sed 's/^/    /' || true
else
  ok "Код соответствует origin/main"
fi

DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo "0")
if [ "$DIRTY" -gt 0 ]; then
  warn "Есть незакоммиченные изменения на сервере ($DIRTY файл(ов))"
  git status --short 2>/dev/null | sed 's/^/    /' || true
else
  ok "Рабочая директория чистая"
fi

# =============================================================================
# ИТОГОВЫЙ ОТЧЁТ
# =============================================================================
TOTAL=$((PASS + FAIL + WARN))

echo ""
echo -e "${BOLD}${BLUE}══════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Итог: ${GREEN}✔ $PASS OK${RESET}  ${RED}✖ $FAIL FAIL${RESET}  ${YELLOW}⚠ $WARN WARN${RESET}  ${CYAN}⚙ $FIXED FIXED${RESET}"
echo -e "${BOLD}${BLUE}══════════════════════════════════════════${RESET}"
echo ""

if [ "$FAIL" -eq 0 ] && [ "$FIXED" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  Всё в порядке! Система работает нормально.${RESET}"
elif [ "$FAIL" -eq 0 ] && [ "$FIXED" -gt 0 ]; then
  echo -e "${CYAN}${BOLD}  Исправлено автоматически: $FIXED. Проверьте статус выше.${RESET}"
else
  echo -e "${RED}${BOLD}  Обнаружены проблемы. Требуется ручное вмешательство.${RESET}"
fi
echo ""

exit $FAIL
