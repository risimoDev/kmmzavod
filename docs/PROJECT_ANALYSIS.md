# Полный анализ проекта kmmzavod — Отчёт и план улучшений

> **Формат**: промпт-инструкция для AI-ассистента по последовательному исправлению и улучшению проекта.

---

## 1. Критические баги и проблемы безопасности

### 1.1 OAuth State — отсутствие подписи и верификации (CRITICAL)

**Файл**: `apps/api/src/routes/publish.routes.ts:71-72, 113-114, 165-166`

**Проблема**: OAuth `state` параметр формируется как простой `base64(JSON)` без криптографической подписи. Злоумышленник может подделать `state`, указать чужой `tenantId` и привязать соц. аккаунт к чужому тенанту.

```typescript
// Текущий небезопасный код:
const state = Buffer.from(JSON.stringify({ tenantId: req.user.tenantId, userId: req.user.userId })).toString('base64');
// В callback:
const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
const { tenantId } = decodedState; // ← ничем не верифицировано!
```

**Исправление**: Подписывать state через HMAC-SHA256 с JWT_SECRET или использовать короткоживущий JWT-токен в state. В callback верифицировать подпись перед использованием `tenantId`.

---

### 1.2 OAuth callback — отсутствие аутентификации (CRITICAL)

**Файл**: `apps/api/src/routes/publish.routes.ts:45-88, 90-130, 132-182`

**Проблема**: Callback эндпоинты (`/social/tiktok/callback`, `/social/youtube/callback`, `/social/instagram/callback`) находятся **до** `app.addHook('preHandler', app.authenticate)` на строке 186. Они публичные — любой кто знает формат URL может вызвать их с поддельным `code` и `state`. Единственная защита — неподписанный base64 state (см. 1.1).

**Исправление**: Подписать state JWT-токеном; в callback верифицировать JWT подпись state.

---

### 1.3 Token leak через URL — OAuth redirect с `?token=` (HIGH)

**Файл**: `apps/web/src/app/(app)/settings/page.tsx:80`

```typescript
window.location.href = `${apiBase}/api/v1/social/${p}/authorize?token=${getAccessToken()}`;
```

**Проблема**: Access token передаётся в query string. Он попадёт в:
- Логи Nginx/API
- HTTP Referer при redirect на TikTok/Google/Facebook
- Историю браузера

**Исправление**: API `authorize` эндпоинты уже под `app.authenticate` (строка 186) и читают токен из Authorization header. Фронтенд должен вызвать API через `fetch` (или через `apiFetch`) чтобы получить redirect URL, а затем уже перенаправить пользователя. Либо отправлять обычный redirect с авторизацией через cookie.

---

### 1.4 Шифрование токенов — passthrough в dev (MEDIUM)

**Файл**: `apps/api/src/lib/crypto.ts:22-23`

**Проблема**: Без `ENCRYPTION_KEY` функция `encrypt()` возвращает plaintext. В development это ожидаемо, но:
- Если production-деплой забудет установить `ENCRYPTION_KEY`, все OAuth токены хранятся в plain text
- В config.ts строка 65-68 есть проверка для production, но она в API сервисе. Orchestrator НЕ проверяет обязательность `ENCRYPTION_KEY` в production.

**Исправление**: Добавить аналогичную проверку в `apps/orchestrator/src/config.ts` для production.

---

### 1.5 `NEXT_PUBLIC_API_URL` replace-хак для redirect (MEDIUM)

**Файл**: `apps/api/src/routes/publish.routes.ts:49, 83, 86, 92, 125, 128, 134, 177, 180`

```typescript
config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')
```

**Проблема**: Хрупкий хак — работает только в dev (localhost:3000→3001). В production с доменами (`api.example.com` → `app.example.com`) replace вернёт исходный URL и redirect уйдёт на неверный адрес.

**Исправление**: Ввести отдельную переменную `FRONTEND_URL` (или `PUBLIC_WEB_URL`) и использовать её для redirect после OAuth.

---

## 2. Баги логики

### 2.1 Delete social account — soft delete, но UI не обновляется корректно

**Файл**: `apps/api/src/routes/publish.routes.ts:257-264`

**Проблема**: API делает `update({ isActive: false })` — soft delete. Но `apps/web/src/app/(app)/settings/page.tsx:109-110` после delete убирает аккаунт из списка `setAccounts(prev => prev.filter(a => a.id !== deleteTarget.id))`. Аккаунт исчезает из UI, хотя API его показывает при следующей загрузке (в `inactiveAccounts`). Несоответствие UX — пользователь думает, что аккаунт удалён, но он просто деактивирован.

**Исправление**: После delete обновлять locальный state корректно (менять `isActive` на false, а не удалять из массива).

---

### 2.2 Publish route prefix не совпадает с используемыми URL

**Файл**: `apps/api/src/app.ts:127`

```typescript
app.register(publishRoutes, { prefix: '/api/v1' });
```

Роуты внутри:
- `/social/tiktok/callback` → `GET /api/v1/social/tiktok/callback`
- `/social-accounts` → `POST /api/v1/social-accounts`
- `/videos/:videoId/publish` → `POST /api/v1/videos/:videoId/publish`

**Проблема**: `/api/v1/videos/:videoId/publish` конфликтует с `videoRoutes` (prefix `/api/v1/videos`). Fastify может по-разному роутить это, потенциально пропуская авторизацию из `videoRoutes`.

**Исправление**: Вынести publish routes в подпрефикс или убедиться что authenticate hook правильно работает для всех подмаршрутов.

---

### 2.3 Race condition при credit reserve

**Файл**: `apps/api/src/routes/videos.routes.ts:326-338`

**Проблема**: Используется Prisma interactive transaction, но без `SELECT FOR UPDATE`. Prisma по умолчанию использует `READ COMMITTED` isolation. При параллельных запросах два пользователя одного тенанта могут оба пройти проверку credits и списать больше, чем есть.

**Исправление**: Использовать `isolationLevel: 'Serializable'` в `$transaction()` или выполнять `$executeRaw` с `FOR UPDATE` блокировкой на строке tenant.

---

### 2.4 BigInt.prototype.toJSON — глобальный monkey-patch

**Файл**: `apps/api/src/app.ts:3-5`

```typescript
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};
```

**Проблема**: Потеря точности для значений > `Number.MAX_SAFE_INTEGER` (2^53). Модели `Generation`, `CreditTransaction`, `UsageRecord`, `JobEvent` используют `BigInt @id`. При превышении 9007199254740991 записей ID будут неточными.

**Исправление**: Для текущего масштаба проекта это не критично, но стоит использовать `String(this)` вместо `Number(this)` для безопасности.

---

## 3. Проблемы архитектуры и надёжности

### 3.1 SSE connection — Redis duplicate per client

**Файл**: `apps/api/src/routes/videos.routes.ts:110`

```typescript
const sub = getRedis().duplicate();
```

**Проблема**: Каждое SSE-подключение создаёт новый Redis connection. При 100 одновременных клиентах — 100 Redis connections только для SSE. Redis по умолчанию ограничен 10000 connections.

**Исправление**: Использовать единый shared Redis subscriber с Map<channel, Set<response>> для мультиплексирования.

---

### 3.2 `process.loadEnvFile` — Node.js 20.12+ only

**Файл**: `apps/api/src/config.ts:6`, `apps/orchestrator/src/config.ts:5`

```typescript
try { process.loadEnvFile(path.resolve(process.cwd(), '../../.env')); } catch {}
```

**Проблема**: `process.loadEnvFile()` добавлен в Node.js 20.12 (experimental) и 21.7. Silent catch скрывает ошибки при старых версиях Node.

**Исправление**: Использовать `dotenv` или документировать требование Node.js >= 20.12.

---

### 3.3 Отсутствие health check для MinIO при старте API

**Файл**: `apps/api/src/app.ts:85`

```typescript
await storage.ensureBucket();
```

**Проблема**: Если MinIO не готов при старте API — приложение упадёт без retry. Docker depends_on healthcheck помогает, но при dev-режиме (pnpm dev) MinIO может быть недоступен.

**Исправление**: Обернуть в retry-loop с backoff.

---

### 3.4 Docker-compose: API не имеет переменных для Social OAuth

**Файл**: `docker-compose.yml:52-101` (api service)

**Проблема**: В секции `api` отсутствуют переменные `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`. Они есть в orchestrator (строки 136-142), но callback обрабатывается в API! Значит OAuth callbacks в production не смогут обмениватьtoken.

**Исправление**: Добавить все Social OAuth переменные в секцию api docker-compose.yml.

---

### 3.5 `NEXT_PUBLIC_API_URL` переменная отсутствует в API docker env

**Файл**: `docker-compose.yml:70-91`

**Проблема**: `config.NEXT_PUBLIC_API_URL` используется в publish.routes.ts для формирования redirect_uri и callback URL. Но в docker-compose api service эта переменная не установлена! Будет использован default `http://localhost:3000` — OAuth callbacks не будут работать в production.

**Исправление**: Добавить `NEXT_PUBLIC_API_URL: ${PUBLIC_API_URL:-http://localhost:3000}` в environment api service.

---

## 4. Проблемы фронтенда

### 4.1 Auth guard — нет middleware, redirect только в useEffect

**Файл**: `apps/web/src/app/(app)/dashboard/page.tsx:47-49`

```typescript
if (!getAccessToken()) {
  router.replace("/login");
  return;
}
```

**Проблема**: Каждая защищённая страница должна самостоятельно проверять наличие токена. Нет единого middleware/guard. При SSR или page prefetch контент может мелькнуть до redirect.

**Исправление**: Создать Next.js middleware (`middleware.ts`) или HOC/Context с единым auth guard.

---

### 4.2 Admin link виден всем кто изменит localStorage

**Файл**: `apps/web/src/components/layout/AppShell.tsx:137, 199`

```typescript
const isSuperAdmin = user?.platformRole === 'super_admin';
```

**Проблема**: platformRole читается из localStorage (`getStoredUser()`). Пользователь может вручную изменить localStorage и увидеть ссылку Admin. Хотя API проверит роль на бэкенде, это UI confusion.

**Исправление**: Не критично (security enforced on backend), но стоит отметить как UX issue.

---

### 4.3 Отсутствие error boundary

**Проблема**: Нет глобального React Error Boundary. Необработанная ошибка в любом компоненте приведёт к белому экрану.

**Исправление**: Добавить Error Boundary в root layout.

---

## 5. Проблемы качества кода

### 5.1 Мусорные файлы в корне проекта

Файлы, которые нужно удалить:
- `_debug_config.py`
- `_diag.txt`
- `_health.txt`
- `_test_compose.js`
- `_test_compose_e2e.py`
- `_test_minio.py` / `_test_minio2.py` / `_test_minio3.py` / `_test_minio4.py` / `_test_minio5.py`
- `_test_minio_sync.py`
- `DEPLOYMENT_REPORT.md`
- `FIX_REPORT.md`
- `IMPROVEMENT_PLAN.md`

---

### 5.2 `admin.routes.ts` — файл 104 KB

**Файл**: `apps/api/src/routes/admin.routes.ts` (104087 bytes)

**Проблема**: Монолитный файл ~3000+ строк. Сложно поддерживать, медленная навигация.

**Исправление**: Разбить на модули: `admin/stats.routes.ts`, `admin/users.routes.ts`, `admin/tenants.routes.ts`, `admin/settings.routes.ts`, `admin/pipeline-test.routes.ts`.

---

### 5.3 Дублирование crypto-модуля

**Файлы**: `apps/api/src/lib/crypto.ts`, `apps/orchestrator/src/lib/crypto.ts`

**Проблема**: Один и тот же код шифрования дублируется в двух сервисах.

**Исправление**: Вынести в shared package `@kmmzavod/crypto`.

---

### 5.4 Отсутствие тестов

**Проблема**: Нет ни одного unit/integration теста (только мусорные `_test_*.py` файлы). Критически важные модули (auth, credits, publish) не покрыты тестами.

**Исправление**: Добавить тесты для: auth flow, credit transactions, OAuth callbacks, publish pipeline.

---

## 6. Порядок исправлений (приоритет)

### Фаза 1 — Критическая безопасность
1. Подписать OAuth state через HMAC/JWT
2. Добавить Social OAuth переменные в docker-compose api service
3. Добавить `NEXT_PUBLIC_API_URL`/`PUBLIC_API_URL` в docker-compose api
4. Убрать token из query string на фронтенде
5. Добавить `FRONTEND_URL` вместо replace-хака

### Фаза 2 — Баги логики
6. Исправить race condition credits (isolation level)
7. Исправить delete social account UI state
8. Проверить route prefix конфликты publish vs videos

### Фаза 3 — Надёжность
9. SSE Redis connection pooling
10. Добавить auth middleware на фронтенде
11. Добавить Error Boundary
12. Retry logic для MinIO при старте

### Фаза 4 — Качество кода
13. Удалить мусорные файлы из корня
14. Разбить admin.routes.ts на модули
15. Вынести crypto в shared package
16. BigInt.toJSON → String

### Фаза 5 — Тестирование
17. Unit тесты для auth, credits, crypto
18. Integration тесты для OAuth flow
19. E2E тесты для publish pipeline

---

## 7. Инструкция для AI-ассистента

При работе над исправлениями:
1. **Следуй порядку фаз** — сначала безопасность, потом логика
2. **Минимальные изменения** — не рефакторь всё сразу, только по задаче
3. **Сохраняй обратную совместимость** API endpoints
4. **Добавляй миграции** при изменении schema.prisma
5. **Не удаляй комментарии** без явного указания
6. **Проверяй TypeScript типы** после изменений
7. **Стиль кода**: русские сообщения пользователю, английские имена переменных и комментарии в коде
