 # Настройка подключения социальных сетей — kmmzavod

Система поддерживает автопубликацию видео в три платформы: **TikTok**, **Instagram Reels**, **YouTube Shorts**. Каждая требует настройки OAuth-приложения на стороне провайдера.

---

## Общая архитектура

```
┌──────────────┐      ┌──────────────────┐      ┌──────────────────────┐
│  Фронтенд    │──►   │  API (Fastify)   │──►   │  Orchestrator        │
│  /settings   │      │  OAuth callbacks  │      │  Publish Worker      │
│  page.tsx    │      │  publish.routes   │      │  (BullMQ)            │
└──────────────┘      └──────────────────┘      └──────────────────────┘
                              │                           │
                      Social OAuth2 flow           Upload video via API
                              │                           │
                    ┌─────────▼────────────┐    ┌─────────▼────────────┐
                    │ TikTok / Google /     │    │ TikTok / Instagram / │
                    │ Facebook OAuth2       │    │ YouTube API          │
                    └──────────────────────┘    └──────────────────────┘
```

**Поток:**
1. Пользователь нажимает "Подключить аккаунт" → Фронтенд redirect на `/api/v1/social/{platform}/authorize`
2. API формирует OAuth URL и перенаправляет пользователя на провайдера
3. Пользователь авторизуется → провайдер redirect на `/api/v1/social/{platform}/callback`
4. API обменивает `code` на access/refresh token, шифрует и сохраняет в БД
5. При публикации → Orchestrator расшифровывает токены и загружает видео через API провайдера

---

## 1. Переменные окружения

Добавьте в `.env` файл:

```bash
# ── Social Publishing ─────────────────────────────────────────────────────────

# TikTok
TIKTOK_CLIENT_KEY=your_tiktok_client_key
TIKTOK_CLIENT_SECRET=your_tiktok_client_secret

# Instagram (через Facebook App)
INSTAGRAM_APP_ID=your_facebook_app_id
INSTAGRAM_APP_SECRET=your_facebook_app_secret

# YouTube Shorts (через Google OAuth2)
YOUTUBE_CLIENT_ID=your_google_client_id
YOUTUBE_CLIENT_SECRET=your_google_client_secret

# Шифрование токенов (ОБЯЗАТЕЛЬНО для production!)
# Генерация: openssl rand -hex 32
ENCRYPTION_KEY=your_64_character_hex_string_here
```

---

## 2. Настройка TikTok

### 2.1 Создание приложения

1. Зайдите на [TikTok for Developers](https://developers.tiktok.com/)
2. Создайте приложение (App type: **Web**)
3. Включите продукты:
   - **Login Kit** — для авторизации
   - **Content Posting API** — для публикации видео

### 2.2 Настройка OAuth

В настройках приложения → **Login Kit** → **Redirect URIs**:

```
# Development:
http://localhost:3000/api/v1/social/tiktok/callback

# Production:
https://api.yourdomain.com/api/v1/social/tiktok/callback
```

### 2.3 Запрос Scopes

Необходимые scopes (запрашиваются автоматически в коде):
- `user.info.basic` — имя аккаунта для отображения
- `video.upload` — загрузка видео
- `video.publish` — публикация видео

### 2.4 Получение ключей

- **Client Key** → `TIKTOK_CLIENT_KEY`
- **Client Secret** → `TIKTOK_CLIENT_SECRET`

### 2.5 Важные ограничения

- Приложение должно пройти **App Review** для доступа к Content Posting API
- В sandbox-режиме можно публиковать только для тестовых пользователей
- Максимальный размер файла: **4 GB**
- Поддерживаемые форматы: MP4, MOV, WebM
- Privacy level по умолчанию: `SELF_ONLY` (видео в черновиках)

---

## 3. Настройка Instagram (через Facebook Graph API)

### 3.1 Создание Facebook App

1. Зайдите в [Meta for Developers](https://developers.facebook.com/)
2. Создайте приложение → тип **Business**
3. Добавьте продукты:
   - **Facebook Login for Business**
   - **Instagram Graph API** (или Instagram API with Instagram Login)

### 3.2 Требования Instagram

- Аккаунт Instagram должен быть **Business** или **Creator**
- Аккаунт должен быть связан с **Facebook Page**
- Facebook App должен иметь доступ к этой странице

### 3.3 Настройка OAuth

В настройках **Facebook Login** → **Valid OAuth Redirect URIs**:

```
# Development:
http://localhost:3000/api/v1/social/instagram/callback

# Production:
https://api.yourdomain.com/api/v1/social/instagram/callback
```

### 3.4 Запрос Permissions

Необходимые permissions:
- `instagram_basic` — базовая информация об IG аккаунте
- `instagram_content_publish` — публикация Reels
- `pages_show_list` — список связанных Facebook Pages
- `pages_read_engagement` — чтение данных страницы

### 3.5 Получение ключей

- **App ID** → `INSTAGRAM_APP_ID`
- **App Secret** → `INSTAGRAM_APP_SECRET` (Settings → Basic → App Secret)

### 3.6 Поток авторизации (как это работает в коде)

1. Пользователь перенаправляется на Facebook OAuth dialog
2. После авторизации: `code` обменивается на short-lived token
3. Short-lived token обменивается на **long-lived token** (60 дней)
4. Через Graph API получаем список Facebook Pages пользователя
5. Для каждой страницы проверяем наличие связанного Instagram Business Account
6. Сохраняем long-lived token + IG Business Account ID

### 3.7 Важные ограничения

- Публикация Reels требует **публично доступный URL видео** (используется presigned MinIO URL)
- Обработка контейнера может занять до 10 минут
- Максимальная длина Reel: **90 секунд**
- App Review обязателен для production (permissions review)

---

## 4. Настройка YouTube Shorts (Google OAuth2)

### 4.1 Создание проекта в Google Cloud

1. Зайдите в [Google Cloud Console](https://console.cloud.google.com/)
2. Создайте проект (или используйте существующий)
3. Включите **YouTube Data API v3** в Library

### 4.2 Создание OAuth2 Credentials

1. Перейдите в **APIs & Services → Credentials**
2. Нажмите **Create Credentials → OAuth 2.0 Client IDs**
3. Application type: **Web application**
4. Authorized redirect URIs:

```
# Development:
http://localhost:3000/api/v1/social/youtube/callback

# Production:
https://api.yourdomain.com/api/v1/social/youtube/callback
```

### 4.3 Настройка OAuth Consent Screen

1. **APIs & Services → OAuth consent screen**
2. User Type: **External** (или Internal для Workspace)
3. Добавьте scopes:
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/userinfo.profile`
4. Добавьте тестовых пользователей (пока приложение в Testing mode)

### 4.4 Получение ключей

- **Client ID** → `YOUTUBE_CLIENT_ID`
- **Client Secret** → `YOUTUBE_CLIENT_SECRET`

### 4.5 Важные ограничения

- В Testing mode: только тестовые пользователи (max 100)
- Для production: нужна **Verification** (подтверждение Google)
- YouTube API quota: **10 000 units/day** по умолчанию (1 upload = ~1600 units)
- Для классификации как Short: добавляется `#Shorts` в заголовок + видео < 60 сек вертикальное
- `access_type: 'offline'` обеспечивает получение refresh_token

---

## 5. Шифрование токенов (ENCRYPTION_KEY)

### 5.1 Генерация ключа

```bash
# Linux/macOS/WSL:
openssl rand -hex 32

# PowerShell:
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

# Или через Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Результат — строка из 64 hex символов, например:
```
a1b2c3d4e5f6...
```

### 5.2 Как работает шифрование

- **Алгоритм**: AES-256-GCM
- **Формат хранения**: `base64(iv[12] + authTag[16] + ciphertext)`
- При `ENCRYPTION_KEY` = пусто → токены хранятся в plaintext (только для dev!)
- Legacy plaintext токены автоматически читаются при включении шифрования (graceful fallback)

### 5.3 Ротация ключа

В текущей реализации ротация ключа **не поддерживается** напрямую. При смене ключа все существующие зашифрованные токены станут нечитаемыми. Нужно будет:
1. Расшифровать все токены старым ключом
2. Зашифровать новым ключом
3. Обновить записи в БД

---

## 6. Прокси для социальных сетей

### 6.1 Зачем нужен прокси

- Российские серверы могут иметь ограниченный доступ к TikTok/Instagram API
- Каждый соц. аккаунт может использовать **персональный прокси** для изоляции

### 6.2 Настройка глобального прокси

```bash
# В .env:
AI_PROXY_URL=http://user:password@proxy.example.com:8080
# Или:
AI_PROXY_URL=socks5://user:password@proxy.example.com:1080
```

### 6.3 Настройка per-account прокси

При подключении аккаунта (через UI или API) можно указать прокси:

```
socks5://user:pass@residential-proxy.com:1080
http://user:pass@isp-proxy.com:8080
```

Этот прокси используется **только** для данного аккаунта при публикации.

### 6.4 Приоритет прокси

1. Per-account `proxyUrl` (из SocialAccount.proxyUrl)
2. Global `AI_PROXY_URL` из AdminSetting в БД
3. `AI_PROXY_URL` из .env

---

## 7. PostBridge (кросс-постинг)

Дополнительный вариант — использовать PostBridge API для кросс-постинга:

```bash
POST_BRIDGE_API_KEY=your_postbridge_api_key
```

PostBridge позволяет публиковать в несколько соцсетей через единый API. Настройка:
1. Зарегистрируйтесь на [PostBridge.com](https://postbridge.com)
2. Подключите свои соц. аккаунты в их дашборде
3. Получите API ключ
4. В kmmzavod: создайте social account с platform = "postbridge"
5. В поле `accountName` укажите числовой ID аккаунта из PostBridge

---

## 8. Проверка работоспособности

### 8.1 Проверка конфигурации

```bash
# Убедитесь, что все переменные заданы:
grep -E "TIKTOK_|INSTAGRAM_|YOUTUBE_|ENCRYPTION_KEY" .env
```

### 8.2 Тест OAuth flow (development)

1. Запустите API: `cd apps/api && pnpm dev`
2. Запустите Web: `cd apps/web && pnpm dev`
3. Войдите в систему → перейдите в Settings
4. Нажмите кнопку платформы → должен произойти redirect на OAuth провайдера
5. После авторизации → redirect обратно на `/settings?success=...`

### 8.3 Тест публикации

1. Убедитесь, что есть completed видео
2. Откройте страницу видео → кнопка "Publish"
3. Выберите подключённый аккаунт
4. Нажмите опубликовать
5. Проверьте логи orchestrator: `docker compose logs -f orchestrator | grep publish`

### 8.4 Общие проблемы

| Проблема | Решение |
|----------|---------|
| `TikTok OAuth not configured` | Проверьте `TIKTOK_CLIENT_KEY` в .env |
| `YouTube token exchange failed` | Проверьте redirect URI в Google Console |
| `No Instagram Business Account linked` | Убедитесь, что IG аккаунт Business и привязан к FB Page |
| Токены не расшифровываются | Проверьте `ENCRYPTION_KEY` совпадает между API и Orchestrator |
| Redirect после OAuth на localhost | В production: настройте `NEXT_PUBLIC_API_URL` правильно |
| OAuth redirect на неправильный frontend URL | Текущий код использует хак `replace(':3000',':3001')` — в production нужен отдельный `FRONTEND_URL` |

---

## 9. Production Checklist

- [ ] `ENCRYPTION_KEY` задан (64 hex символа)
- [ ] `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` заданы
- [ ] `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` заданы
- [ ] `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` заданы
- [ ] Redirect URIs содержат production домен у всех провайдеров
- [ ] `NEXT_PUBLIC_API_URL` указывает на production API URL
- [ ] TikTok App прошёл App Review
- [ ] Facebook App прошёл Permissions Review
- [ ] YouTube app прошёл OAuth Verification
- [ ] Переменные присутствуют и в API и в Orchestrator docker-compose
- [ ] Прокси настроен если сервер в РФ
- [ ] SSL сертификат настроен (OAuth провайдеры требуют HTTPS redirect URI в production)

---

## 10. Структура в коде

| Компонент | Файл | Назначение |
|-----------|------|-----------|
| OAuth authorize endpoints | `apps/api/src/routes/publish.routes.ts:188-227` | Формирование OAuth URL и redirect |
| OAuth callback handlers | `apps/api/src/routes/publish.routes.ts:45-182` | Обмен code на token, сохранение |
| Social accounts CRUD | `apps/api/src/routes/publish.routes.ts:229-264` | Ручное создание, список, удаление |
| Publish endpoint | `apps/api/src/routes/publish.routes.ts:266-284` | Создание задачи публикации |
| Publish worker | `apps/orchestrator/src/workers/publish.worker.ts` | Загрузка видео в соцсеть |
| TikTok client | `apps/orchestrator/src/clients/social/tiktok.client.ts` | Content Posting API v2 |
| Instagram client | `apps/orchestrator/src/clients/social/instagram.client.ts` | Meta Graph API v20.0 |
| YouTube client | `apps/orchestrator/src/clients/social/youtube.client.ts` | YouTube Data API v3 |
| PostBridge client | `apps/orchestrator/src/clients/social/postbridge.client.ts` | Кросс-постинг API |
| Token encryption | `apps/api/src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt |
| Frontend settings | `apps/web/src/app/(app)/settings/page.tsx` | UI подключения аккаунтов |
| Frontend API client | `apps/web/src/lib/api.ts:378-398` | socialAccountsApi |
| DB schema | `packages/db/prisma/schema.prisma:773-834` | SocialAccount + PublishJob models |
| Queue definition | `packages/queue/src/queues.ts:74-83` | Publish queue config |
