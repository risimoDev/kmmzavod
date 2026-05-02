# AI API — справочник по интеграции

## HeyGen

- **Base URL**: `https://api.heygen.com`
- **Аутентификация**: заголовок `X-Api-Key: YOUR_KEY`
- **Актуальная версия**: v3 (v2 поддерживается до 31 октября 2026)
- **Env переменная**: `HEYGEN_API_KEY`

### Ключевые эндпоинты

| Метод  | Путь                       | Описание                                      |
| ------ | -------------------------- | --------------------------------------------- |
| `GET`  | `/v2/user/remaining_quota` | Баланс кредитов (используется в health check) |
| `POST` | `/v3/video-agents`         | Создать видео через агента (v3)               |
| `GET`  | `/v3/videos/{id}`          | Статус генерации видео                        |

### Пример (health check в коде)

```
GET https://api.heygen.com/v2/user/remaining_quota
X-Api-Key: <HEYGEN_API_KEY>
```

Ответ: `{ "data": { "remaining_quota": 100 } }`

---

## Runway ML

- **Base URL**: `https://api.dev.runwayml.com` (это production, не staging)
- **Аутентификация**: `Authorization: Bearer YOUR_KEY`
- **Обязательный заголовок**: `X-Runway-Version: 2024-11-06`
- **Env переменная**: `RUNWAY_API_KEY`
- **SDK**: `@runwayml/sdk`

### Ключевые эндпоинты

| Метод    | Путь                 | Описание                                      |
| -------- | -------------------- | --------------------------------------------- |
| `GET`    | `/v1/organization`   | Баланс кредитов (используется в health check) |
| `POST`   | `/v1/image_to_video` | Генерация видео из изображения                |
| `POST`   | `/v1/text_to_video`  | Генерация видео из текста                     |
| `POST`   | `/v1/text_to_image`  | Генерация изображений                         |
| `GET`    | `/v1/tasks/{id}`     | Статус задачи                                 |
| `DELETE` | `/v1/tasks/{id}`     | Отмена задачи                                 |

### Доступные модели (video)

- `gen4.5` — основная модель 2025
- `gen4_turbo` — быстрая
- `seedance2` — новейшая (2026)
- `veo3.1`, `veo3.1_fast` — Google Veo через Runway

### Пример (health check в коде)

```
GET https://api.dev.runwayml.com/v1/organization
Authorization: Bearer <RUNWAY_API_KEY>
X-Runway-Version: 2024-11-06
```

Ответ: `{ "tier": {...}, "creditBalance": 1000, "usage": {...} }`

---

## GPTunnel (OpenAI-совместимый)

- **Base URL**: `https://gptunnel.ru/v1`
- **Аутентификация**: `Authorization: YOUR_KEY` (без "Bearer" по документации, но Bearer тоже принимается)
- **Env переменные**: `GPTUNNEL_API_KEY`, `GPTUNNEL_BASE_URL`

### Ключевые эндпоинты

| Метод  | Путь                   | Описание                                     |
| ------ | ---------------------- | -------------------------------------------- |
| `GET`  | `/v1/models`           | Список моделей (используется в health check) |
| `POST` | `/v1/chat/completions` | Генерация текста (GPT/Claude/etc)            |

### Пример (health check в коде)

```
GET https://gptunnel.ru/v1/models
Authorization: Bearer <GPTUNNEL_API_KEY>
```

### Доступные модели

- `gpt-4o`, `gpt-4o-mini`
- `claude-3-5-sonnet`, `claude-3-5-haiku`
- `gemini-2.0-flash`, `gemini-2.5-pro`
- и другие — см. https://gptunnel.ru/pricing

---

## Диагностика DNS на Ubuntu 24.04 (Docker)

**Симптом**: `EAI_AGAIN <hostname>` внутри контейнеров при обращении к внешним API.

**Причина**: Ubuntu 24.04 по умолчанию использует `nftables`, а Docker требует `iptables-legacy`. Это приводит к тому, что встроенный DNS Docker (127.0.0.11) не может переадресовать запросы на 8.8.8.8.

**Исправление** (один раз на сервере):

```bash
# Переключить на legacy iptables
update-alternatives --set iptables /usr/sbin/iptables-legacy
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

# Перезапустить Docker и пересоздать контейнеры
systemctl restart docker
cd /opt/kmmzavod
docker compose down && docker compose up -d

# Проверить
docker compose exec api nslookup api.heygen.com
```

---

## Конфигурация .env

```env
# HeyGen
HEYGEN_API_KEY=your_key

# Runway
RUNWAY_API_KEY=your_key
RUNWAY_VIDEO_MODEL=gen4_turbo   # или gen4.5, seedance2

# GPTunnel
GPTUNNEL_API_KEY=your_key
GPTUNNEL_BASE_URL=https://gptunnel.ru/v1

# Прокси (оставить пустым если не нужен — сервер в Нидерландах)
AI_PROXY_URL=
```
