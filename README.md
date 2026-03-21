# kmmzavod — AI Video Generation SaaS Platform

Мультитенантная SaaS-платформа для автоматической генерации видео с использованием HeyGen, Kling AI и других AI-провайдеров.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                        Nginx :80/:443                   │
│              reverse proxy + SSL termination            │
└──────────────┬──────────────────────────┬───────────────┘
               │                          │
        ┌──────▼──────┐           ┌───────▼──────┐
        │  API :3000  │           │  Web :3001   │
        │  Fastify    │           │  Next.js 14  │
        └──────┬──────┘           └──────────────┘
               │
     ┌─────────┼──────────┐
     │         │          │
┌────▼───┐ ┌──▼───┐ ┌────▼──────────────┐
│ Postgres│ │Redis │ │   Orchestrator    │
│  :5433  │ │:6379 │ │  (BullMQ workers) │
└─────────┘ └──────┘ └────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Video Processor    │
                    │  Python/FastAPI :8000│
                    └─────────────────────┘
                  + MinIO S3 :9000/:9001
```

### Сервисы

| Сервис            | Технология           | Порт   | Назначение                           |
| ----------------- | -------------------- | ------ | ------------------------------------ |
| `api`             | Fastify + TypeScript | 3000   | REST API, авторизация, бизнес-логика |
| `web`             | Next.js 14           | 3001   | Веб-интерфейс                        |
| `orchestrator`    | Node.js + BullMQ     | —      | Очереди задач, AI-пайплайн           |
| `video-processor` | Python + FastAPI     | 8000   | Сборка видео через FFmpeg            |
| `postgres`        | PostgreSQL 15        | 5433   | Основная БД                          |
| `redis`           | Redis 7              | 6379   | Очереди, кэш, сессии                 |
| `minio`           | MinIO                | 9000   | S3-совместимое хранилище файлов      |
| `nginx`           | Nginx Alpine         | 80/443 | Reverse proxy                        |

---

## Быстрый старт (локальная разработка)

### Требования

- **Node.js** 20+ ([nodejs.org](https://nodejs.org))
- **pnpm** 9+ (`npm install -g pnpm@9`)
- **Docker Desktop** ([docker.com](https://www.docker.com/products/docker-desktop/))
- **Git**

### Установка

```bash
# 1. Клонировать репозиторий
git clone <repo-url> kmmzavod
cd kmmzavod

# 2. Запустить скрипт установки (Linux/macOS/WSL)
chmod +x scripts/setup.sh
./scripts/setup.sh

# Windows (PowerShell / Git Bash) — запустить команды вручную (см. ниже)
```

### Ручная установка (шаг за шагом)

```bash
# 1. Создать .env из шаблона
cp .env.example .env
# Отредактировать .env — заполнить все CHANGE_ME значения

# 2. Запустить инфраструктуру
docker compose up -d postgres redis minio

# 3. Дождаться запуска (обычно 10-15 сек)
docker compose ps

# 4. Установить зависимости
pnpm install

# 5. Применить миграции БД
cd packages/db && pnpm migrate:deploy && cd ../..

# 6. Запустить dev-серверы
pnpm dev
```

После запуска:

- **Веб-интерфейс** — http://localhost:3001
- **API** — http://localhost:3000
- **MinIO Console** — http://localhost:9001 (логин/пароль из .env)
- **Prisma Studio** — `cd packages/db && pnpm studio`

---

## Конфигурация (.env)

Скопируйте `.env.example` → `.env` и заполните:

```bash
# Обязательные для работы
POSTGRES_PASSWORD=           # пароль PostgreSQL (любая строка)
REDIS_PASSWORD=              # пароль Redis
MINIO_ROOT_USER=             # логин MinIO (например: kmmzavod)
MINIO_ROOT_PASSWORD=         # пароль MinIO (мин. 8 символов)
JWT_SECRET=                  # секрет JWT (мин. 32 символа, любая строка)

# AI-провайдеры (нужны для генерации видео)
OPENAI_API_KEY=sk-...        # OpenAI (GPT для сценариев)
HEYGEN_API_KEY=...           # HeyGen (аватар-видео)
KLING_ACCESS_KEY=...         # Kling AI (video generation)
KLING_SECRET_KEY=...
IMAGE_GEN_API_KEY=...        # fal.ai / Replicate (генерация изображений)
IMAGE_GEN_PROVIDER=fal       # fal | replicate | comfyui

# URL сервера (для production — ваш домен)
PUBLIC_API_URL=https://api.yourdomain.com
```

---

## Создание администратора

После первого запуска создайте администратора:

```bash
# Зарегистрировать пользователя через API
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@yourdomain.com",
    "password": "YourStrong!Password123",
    "displayName": "Admin",
    "tenantName": "Platform Admin"
  }'

# Выдать роль admin через SQL
docker compose exec postgres psql -U kmmzavod -c \
  "UPDATE \"User\" SET role='admin' WHERE email='admin@yourdomain.com';"
```

Доступ к панели администратора: http://localhost:3001/admin

---

## Деплой на сервер

### Первичная настройка сервера (Ubuntu 22.04)

```bash
# Запустить на свежем сервере
curl -fsSL https://raw.githubusercontent.com/your-org/kmmzavod/main/scripts/server-setup.sh | bash
```

Или скачать и запустить:

```bash
chmod +x scripts/server-setup.sh
sudo ./scripts/server-setup.sh
```

Скрипт автоматически:

- Установит Docker, Docker Compose, Git, Nginx
- Настроит firewall (UFW)
- Создаст пользователя `deploy`
- Сгенерирует безопасные пароли
- Запустит все сервисы

### Обновление (деплой изменений)

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

Скрипт выполняет:

1. `git pull` — получить последние изменения
2. `docker compose build --no-cache` — пересобрать образы
3. `docker compose up -d` — обновить запущенные контейнеры
4. `prisma migrate deploy` — применить новые миграции
5. Health-check всех сервисов

---

## Структура проекта

```
kmmzavod/
├── apps/
│   ├── api/            # Fastify REST API
│   │   └── src/
│   │       ├── routes/ # Маршруты (auth, videos, projects, admin...)
│   │       ├── lib/    # DB, MinIO, хелперы
│   │       └── plugins/# Fastify плагины
│   ├── web/            # Next.js фронтенд
│   │   └── src/
│   │       ├── app/    # App Router страницы
│   │       ├── components/ # UI компоненты
│   │       └── lib/    # API клиенты, утилиты
│   ├── orchestrator/   # BullMQ воркеры, AI-пайплайн
│   └── video-processor/ # Python FastAPI + FFmpeg
├── packages/
│   ├── db/             # Prisma схема и клиент
│   │   └── prisma/
│   │       └── schema.prisma
│   ├── queue/          # BullMQ очереди
│   └── storage/        # MinIO S3 клиент
├── infra/
│   ├── nginx/          # Nginx конфигурация
│   └── postgres/       # Инициализация БД
├── scripts/
│   ├── setup.sh        # Локальная установка
│   ├── server-setup.sh # Настройка сервера
│   └── deploy.sh       # Деплой изменений
├── docker-compose.yml  # Все сервисы
├── .env.example        # Шаблон переменных окружения
└── pnpm-workspace.yaml # pnpm монорепо
```

---

## Полезные команды

```bash
# Просмотр логов всех сервисов
docker compose logs -f

# Логи конкретного сервиса
docker compose logs -f api
docker compose logs -f orchestrator

# Перезапустить один сервис
docker compose restart api

# Зайти в контейнер
docker compose exec api sh
docker compose exec postgres psql -U kmmzavod

# Prisma Studio (GUI для БД)
cd packages/db && pnpm studio

# Создать новую миграцию (при изменении схемы)
cd packages/db && pnpm migrate:dev --name describe_your_change

# Остановить всё
docker compose down

# Остановить и удалить данные (ОСТОРОЖНО!)
docker compose down -v
```

---

## API Эндпоинты

| Метод | URL                           | Описание                     |
| ----- | ----------------------------- | ---------------------------- |
| POST  | `/api/v1/auth/register`       | Регистрация                  |
| POST  | `/api/v1/auth/login`          | Вход                         |
| POST  | `/api/v1/auth/refresh`        | Обновить токен               |
| GET   | `/api/v1/videos`              | Список видео                 |
| POST  | `/api/v1/videos`              | Создать видео                |
| GET   | `/api/v1/videos/:id`          | Детали видео + статус        |
| GET   | `/api/v1/projects`            | Список проектов              |
| POST  | `/api/v1/projects`            | Создать проект               |
| GET   | `/api/v1/admin/stats`         | Статистика платформы (admin) |
| GET   | `/api/v1/admin/users`         | Все пользователи (admin)     |
| GET   | `/api/v1/admin/tenants`       | Все тенанты (admin)          |
| PUT   | `/api/v1/admin/settings/:key` | Изменить настройку (admin)   |

---

## Переменные окружения в production

Для production замените все `localhost` на реальные URL и используйте сильные пароли:

```bash
# Генерация безопасных секретов
openssl rand -base64 32  # для JWT_SECRET, паролей
```

Обязательно настройте:

- `PUBLIC_API_URL` — внешний URL API (например: `https://api.example.com`)
- SSL-сертификат через Certbot или Cloudflare
- Бэкапы PostgreSQL через pg_dump или managed DB
