#!/usr/bin/env bash
# =============================================================================
#  renew-certs.sh — выпуск/обновление SSL-сертификата + настройка автопродления
#
#  Запускать НА СЕРВЕРЕ от root:
#    sudo bash scripts/renew-certs.sh
#    sudo bash scripts/renew-certs.sh --domain k-m-m.online --email admin@k-m-m.online
#
#  Опции:
#    --domain DOMAIN     Основной домен            [k-m-m.online]
#    --no-www            Не добавлять www.DOMAIN в сертификат
#    --email EMAIL       Email для Let's Encrypt   [admin@DOMAIN]
#    --app-dir DIR       Каталог приложения        [/opt/kmmzavod]
#    --force             Перевыпустить, даже если срок ещё не подошёл
#
#  Что делает:
#    1.  Ставит certbot (если нет)
#    2.  Выпускает/расширяет сертификат на DOMAIN + www.DOMAIN через webroot
#        (без остановки nginx; standalone — только как запасной путь)
#    3.  Ставит deploy-hook: перезагрузка nginx в контейнере после продления
#    4.  Включает автопродление (systemd-таймер certbot, иначе cron.d)
#    5.  Удаляет сломанный многострочный /etc/cron.d/certbot-renew-kmmzavod
#    6.  Проверяет всё через `certbot renew --dry-run`
#
#  Идемпотентен: можно запускать повторно.
# =============================================================================
set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'
BOLD=$'\033[1m'; RESET=$'\033[0m'

header()  { echo -e "\n${BOLD}${BLUE}── $* ──${RESET}"; }
info()    { echo -e "  $*"; }
success() { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET} $*"; }
error()   { echo -e "  ${RED}✗ $*${RESET}" >&2; exit 1; }

# ── Параметры ───────────────────────────────────────────────────────────────
DOMAIN="${DOMAIN:-k-m-m.online}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/kmmzavod}"
WEBROOT="${WEBROOT:-/var/www/certbot}"
WITH_WWW=true
FORCE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)   DOMAIN="$2"; shift ;;
    --email)    ADMIN_EMAIL="$2"; shift ;;
    --app-dir)  APP_DIR="$2"; shift ;;
    --no-www)   WITH_WWW=false ;;
    --force)    FORCE=true ;;
    -h|--help)  sed -n '2,25p' "$0"; exit 0 ;;
    *)          error "Неизвестная опция: $1" ;;
  esac
  shift
done

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${DOMAIN}}"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"

[ "$(id -u)" -eq 0 ] || error "Запускать от root: sudo bash $0"

echo -e "${BOLD}Домен:${RESET}   $DOMAIN$([ "$WITH_WWW" = true ] && echo " + www.$DOMAIN")"
echo -e "${BOLD}Email:${RESET}   $ADMIN_EMAIL"
echo -e "${BOLD}Compose:${RESET} $COMPOSE_FILE"

# ── 1. certbot ──────────────────────────────────────────────────────────────
header "1/6 · certbot"

if command -v certbot &>/dev/null; then
  success "certbot уже установлен ($(certbot --version 2>&1))"
else
  info "Устанавливаем certbot..."
  apt-get update -qq
  apt-get install -y -qq certbot
  success "certbot установлен"
fi

# ── 2. Текущее состояние сертификата ────────────────────────────────────────
header "2/6 · Текущий сертификат"

LIVE_DIR="/etc/letsencrypt/live/$DOMAIN"
if [ -f "$LIVE_DIR/fullchain.pem" ]; then
  CUR_EXPIRY="$(openssl x509 -enddate -noout -in "$LIVE_DIR/fullchain.pem" | cut -d= -f2)"
  CUR_SANS="$(openssl x509 -noout -ext subjectAltName -in "$LIVE_DIR/fullchain.pem" \
              | tr -d ' ' | grep -o 'DNS:[^,]*' | sed 's/DNS://' | paste -sd, -)"
  info "Найден: $LIVE_DIR"
  info "Действует до: ${BOLD}${CUR_EXPIRY}${RESET}"
  info "Домены:       ${CUR_SANS}"
  if openssl x509 -checkend 0 -noout -in "$LIVE_DIR/fullchain.pem" &>/dev/null; then
    success "Сертификат ещё действителен"
  else
    warn "Сертификат ПРОСРОЧЕН — выпускаем заново"
  fi
else
  info "Сертификата нет — выпускаем первый раз"
fi

# ── 3. Webroot для ACME-challenge ───────────────────────────────────────────
header "3/6 · Проверка ACME webroot"

mkdir -p "$WEBROOT/.well-known/acme-challenge"
chmod -R 755 "$WEBROOT"

# Кладём пробный файл и пытаемся достать его снаружи через nginx на :80.
# Если получилось — продлеваем без даунтайма (webroot). Если нет — standalone.
PROBE="kmmzavod-probe-$$"
echo "ok" > "$WEBROOT/.well-known/acme-challenge/$PROBE"
trap 'rm -f "$WEBROOT/.well-known/acme-challenge/$PROBE"' EXIT

AUTHENTICATOR="webroot"
if curl -fsS --max-time 10 "http://${DOMAIN}/.well-known/acme-challenge/${PROBE}" 2>/dev/null | grep -q '^ok$'; then
  success "webroot отдаётся через nginx — продление без остановки сервиса"
else
  AUTHENTICATOR="standalone"
  warn "webroot недоступен снаружи (nginx лежит или :80 не проброшен)"
  warn "Используем standalone — nginx будет остановлен на ~30 секунд"
fi
rm -f "$WEBROOT/.well-known/acme-challenge/$PROBE"
trap - EXIT

# ── 4. Deploy-hook: перезагрузка nginx после продления ──────────────────────
header "4/6 · Deploy-hook (перезагрузка nginx)"

HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"
HOOK_FILE="$HOOK_DIR/10-reload-kmmzavod-nginx.sh"
mkdir -p "$HOOK_DIR"

cat > "$HOOK_FILE" <<HOOKEOF
#!/usr/bin/env bash
# Перезагружает nginx в контейнере после успешного продления сертификата.
# Ставится автоматически: scripts/renew-certs.sh
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE}"
[ -f "\$COMPOSE_FILE" ] || exit 0

# Мягкий reload без обрыва соединений; если не вышло — рестарт контейнера.
if docker compose -f "\$COMPOSE_FILE" exec -T nginx nginx -s reload 2>/dev/null; then
  echo "[certbot deploy-hook] nginx reloaded"
else
  docker compose -f "\$COMPOSE_FILE" restart nginx
  echo "[certbot deploy-hook] nginx restarted"
fi
HOOKEOF

chmod 755 "$HOOK_FILE"
success "Deploy-hook: $HOOK_FILE"

# ── 5. Выпуск / расширение сертификата ──────────────────────────────────────
header "5/6 · Выпуск сертификата"

CERTBOT_ARGS=(
  certonly
  --non-interactive
  --agree-tos
  --no-eff-email
  --email "$ADMIN_EMAIL"
  --cert-name "$DOMAIN"
  -d "$DOMAIN"
  --expand
  --keep-until-expiring
)
[ "$WITH_WWW" = true ] && CERTBOT_ARGS+=(-d "www.$DOMAIN")
[ "$FORCE" = true ] && CERTBOT_ARGS+=(--force-renewal)

if [ "$AUTHENTICATOR" = "webroot" ]; then
  CERTBOT_ARGS+=(--webroot -w "$WEBROOT")
  info "Метод: webroot ($WEBROOT)"
  certbot "${CERTBOT_ARGS[@]}" || error "certbot не смог выпустить сертификат"
else
  CERTBOT_ARGS+=(--standalone)
  info "Метод: standalone (порт 80)"
  NGINX_WAS_UP=false
  if [ -f "$COMPOSE_FILE" ] && docker compose -f "$COMPOSE_FILE" ps -q nginx 2>/dev/null | grep -q .; then
    NGINX_WAS_UP=true
    info "Останавливаем nginx..."
    docker compose -f "$COMPOSE_FILE" stop nginx
  fi

  set +e
  certbot "${CERTBOT_ARGS[@]}"
  CERTBOT_RC=$?
  set -e

  if [ "$NGINX_WAS_UP" = true ]; then
    info "Поднимаем nginx обратно..."
    docker compose -f "$COMPOSE_FILE" up -d nginx
  fi
  [ $CERTBOT_RC -eq 0 ] || error "certbot не смог выпустить сертификат (код $CERTBOT_RC)"
fi

NEW_EXPIRY="$(openssl x509 -enddate -noout -in "$LIVE_DIR/fullchain.pem" | cut -d= -f2)"
NEW_SANS="$(openssl x509 -noout -ext subjectAltName -in "$LIVE_DIR/fullchain.pem" \
            | tr -d ' ' | grep -o 'DNS:[^,]*' | sed 's/DNS://' | paste -sd, -)"
success "Сертификат готов: $NEW_SANS"
success "Действует до: ${BOLD}${NEW_EXPIRY}${RESET}"

# Перезагружаем nginx сразу, чтобы он подхватил свежий сертификат
if [ -f "$COMPOSE_FILE" ]; then
  info "Перезагружаем nginx..."
  bash "$HOOK_FILE" || warn "Не удалось перезагрузить nginx — сделайте вручную"
fi

# ── 6. Автопродление ────────────────────────────────────────────────────────
header "6/6 · Автопродление"

# Удаляем старую сломанную многострочную запись cron.d (не парсится cron'ом)
OLD_CRON="/etc/cron.d/certbot-renew-kmmzavod"
if [ -f "$OLD_CRON" ] && grep -q '\\$' "$OLD_CRON"; then
  rm -f "$OLD_CRON"
  warn "Удалена нерабочая многострочная запись $OLD_CRON"
fi

if systemctl list-unit-files 2>/dev/null | grep -q '^certbot\.timer'; then
  systemctl enable --now certbot.timer
  rm -f "$OLD_CRON"
  success "Автопродление: systemd-таймер certbot.timer (2x в сутки)"
  systemctl list-timers certbot.timer --no-pager 2>/dev/null | sed -n '1,2p' | sed 's/^/    /'
else
  # ВАЖНО: одна строка. cron.d НЕ поддерживает перенос строки через "\".
  cat > "$OLD_CRON" <<'CRONEOF'
# Автопродление SSL (kmmzavod). Перезагрузка nginx — в renewal-hooks/deploy/.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3,15 * * * root perl -e 'sleep int(rand(3600))' && certbot renew --quiet
CRONEOF
  chmod 644 "$OLD_CRON"
  success "Автопродление: cron.d — 03:17 и 15:17 со случайной задержкой"
fi

info "Проверяем продление вхолостую (--dry-run)..."
if certbot renew --dry-run --cert-name "$DOMAIN" 2>&1 | tail -20 | sed 's/^/    /'; then
  success "Автопродление рабочее"
else
  error "certbot renew --dry-run упал — автопродление НЕ настроено, разбирайтесь по выводу выше"
fi

# ── Итог ────────────────────────────────────────────────────────────────────
header "Готово"
echo -e "  Домены:       ${BOLD}${NEW_SANS}${RESET}"
echo -e "  Действует до: ${BOLD}${NEW_EXPIRY}${RESET}"
echo -e "  Метод:        ${BOLD}${AUTHENTICATOR}${RESET}"
echo -e "  Проверка снаружи:"
echo -e "    ${BLUE}echo | openssl s_client -connect ${DOMAIN}:443 -servername ${DOMAIN} 2>/dev/null | openssl x509 -noout -dates${RESET}"
