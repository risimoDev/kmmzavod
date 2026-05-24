# Полная аналитика проекта kmmzavod — AI Content Factory

> Дата: Май 2026  
> Версия платформы: v3.0  
> Статус: Production-ready монорепозиторий

---

## 1. Что это за система

**kmmzavod** — SaaS-платформа автоматической генерации видеорекламы для соцсетей (TikTok, Instagram Reels, YouTube Shorts, VK Клипы). Система полностью автоматизирует процесс: от описания товара до готового видео с аватаром, субтитрами, B-roll, фоновой музыкой — и прямой публикацией в соцсети.

**Ключевые возможности:**

- AI-сценарий по PAS-фреймворку (Problem-Agitate-Solution) через GPT/Claude
- Talking-head аватар (HeyGen v2)
- B-roll клипы через Runway Gen-4.5 / Gen-4 Turbo (image-to-video, text-to-video)
- Альтернативный B-roll через Kling v1 Standard
- Статичные сцены с изображениями и Ken Burns анимацией
- Beat-sync переходы по ритму BGM (librosa)
- Субтитры с Whisper-транскрипцией (TikTok-karaoke / Cinematic / Minimal / Default)
- Цветокоррекция (color grading)
- Автопостинг в TikTok, Instagram, YouTube, VK через планировщик (cron)
- Мультитенантная изоляция (каждый клиент — отдельный tenant)
- Биллинг на кредитах (1 кредит = $0.001)

---

## 2. Архитектура системы

### 2.1 Слои системы

```
┌─────────────────────────────────────────────────────────────┐
│                     КЛИЕНТСКИЙ СЛОЙ                          │
│   Next.js Web App (пользователи)  │  Next.js Admin Panel     │
└────────────────┬────────────────────────────┬───────────────┘
                 │ HTTPS/REST                  │
┌────────────────▼────────────────────────────▼───────────────┐
│              API Gateway  (Fastify + TypeScript)             │
│   JWT Auth · Tenant Extraction · Rate Limiter per tenant     │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
   Redis (BullMQ)              PostgreSQL
   8 очередей                  17+ таблиц
         │
         ▼
   Orchestrator (Node.js)
   9 типов воркеров
         │
         ├──► Video Processor (Python/FastAPI + FFmpeg)
         │    10 стадий пайплайна
         │
         └──► MinIO Object Storage
              /assets /scenes /subtitles /videos /temp
```

### 2.2 Сервисы

| Сервис            | Технология                | Роль                                            |
| ----------------- | ------------------------- | ----------------------------------------------- |
| `api`             | Fastify + TypeScript      | REST API Gateway, аутентификация, роутинг задач |
| `orchestrator`    | Node.js + BullMQ          | Воркеры AI-провайдеров, координация пайплайна   |
| `video-processor` | Python + FastAPI + FFmpeg | Монтаж, субтитры, цветокоррекция, Whisper       |
| `web`             | Next.js                   | UI для пользователей                            |
| PostgreSQL        | Prisma ORM                | Основная БД, мультитенантная изоляция           |
| Redis             | BullMQ                    | Очереди задач, session store, кэш               |
| MinIO             | S3-compatible             | Хранилище всех медиафайлов                      |
| Nginx             | Reverse proxy             | SSL терминация, upload size limits              |

---

## 3. Пайплайн генерации видео — детальная логика

### 3.1 Общая схема (fan-out)

```
POST /api/v1/projects/{id}/jobs
         │
         ▼
   pipeline queue
         │
         ▼ coordinator.ts
   startPipeline()
   ├── Загружает job + preset + product context
   ├── Генерирует presigned URLs для изображений продукта
   └──► gpt-script queue
              │
              ▼ gpt-script.worker.ts
        ШАГ 1: Генерация ИДЕИ (отдельный LLM вызов)
        ├── Prompt: IDEA_SYSTEM_PROMPT с anti-repeat хешами
        ├── Модель: claude-4.6-sonnet через GPTunnel
        ├── Хеширует идею SHA-256 (16 hex символов)
        ├── Проверяет дубликат по usedIdeaHashes
        └── Если дубликат — retry до 5 раз

        ШАГ 2: Генерация СЦЕНАРИЯ из идеи
        ├── Prompt: SCRIPT_SYSTEM_PROMPT с PAS-фреймворком
        ├── Анализирует изображения продукта (мультимодально)
        ├── Генерирует JSON: { title, scenes[], social_metadata }
        └── Создаёт Scene записи в БД

        ШАГ 3: Fan-out по типам сцен
        ├── avatar → heygen-render queue (combined mode)
        ├── clip   → image-gen queue (purpose=runway-frame) → runway-clip
        └── image  → image-gen queue (purpose=scene-image)

              │
       ┌──────┼───────┐
       ▼      ▼       ▼
  heygen   runway   image-gen
  worker   worker   worker
       │      │       │
       └──────┴───────┘
              │ (все сцены done)
              ▼ pipeline-state.worker.ts
        allDone check
              │
              ▼ video-compose queue
        video-compose.worker.ts
        ├── Whisper транскрипция аватара
        ├── Генерация субтитров (.ass файл)
        └── POST /compose → video-processor
              │
              ▼ CompositionPipeline (Python)
        10 стадий монтажа
              │
              ▼
        Финальный .mp4 → MinIO
              │
              ▼
        video.status = 'completed'
```

### 3.2 Стадии монтажа в Video Processor (10 стадий)

| #   | Стадия         | Что происходит                                                    |
| --- | -------------- | ----------------------------------------------------------------- |
| 1   | Download       | Параллельное скачивание всех ассетов из MinIO                     |
| 2   | Quality Gate   | OpenCV: проверка blur, black frames, exposure, motion             |
| 3   | Prepare Clips  | Нормализация видео (scale, fps, audio), Ken Burns для изображений |
| 3.5 | Beat Detection | librosa: BPM + beat/onset timestamps из BGM                       |
| 4   | Beat-align     | Подстройка длин клипов под биты музыки                            |
| 5   | Concat         | xfade переходы (fade/smoothleft/smoothright/cut) или L/J-cuts     |
| 6   | Color Grading  | FFmpeg color grading (brightness/contrast/saturation)             |
| 7   | Subtitles      | Burn ASS субтитров с Whisper-точными тайтмингами                  |
| 8   | BGM Mix        | amix: BGM + avatar audio с fade in/out                            |
| 9   | Final Encode   | H.264, -preset slow, -crf 20, -movflags +faststart                |
| 10  | Upload         | MinIO upload финального .mp4                                      |

### 3.3 Режимы создания аватара

**COMBINED MODE (новый, default):**

- Все avatar-сцены объединяются в один скрипт → один вызов HeyGen
- Экономия: меньше API calls, ниже стоимость
- Whisper транскрибирует комбинированное видео → точные субтитры по всей длине

**SINGLE MODE (legacy, backward compat):**

- Каждая avatar-сцена → отдельный HeyGen вызов
- Субтитры из каждой сцены отдельно

### 3.4 Типы сцен и их обработка

| Тип      | Источник                   | Обработка                                                |
| -------- | -------------------------- | -------------------------------------------------------- |
| `avatar` | HeyGen API                 | Talking-head 1080×1920, зелёный фон → chroma key         |
| `clip`   | Runway / Kling             | image-to-video (с референсом продукта) или text-to-video |
| `image`  | fal.ai / Runway / GPTunnel | Статик → Ken Burns (zoom_in/out, pan_lr/rl/tb)           |
| `text`   | Нет генерации              | Только субтитры из script                                |

### 3.5 Двухэтапная генерация B-roll (clip сцены)

```
GPT генерирует prompt: "<IMAGE_PROMPT> ||| <MOTION_PROMPT>"
         │
         ▼ image-gen.worker.ts
Берёт IMAGE_PROMPT
Генерирует изображение (fal.ai flux-pro или Runway image)
с referenceImageUrls от продукта
Загружает в MinIO как scene-frame
         │
         ▼ runway-clip.worker.ts
Берёт MOTION_PROMPT
image-to-video (gen4_turbo, 5 кредитов/сек)
Runway скачивает образ через base64 data URI (обход Docker network)
         │
         ▼
Готовый видеоклип в MinIO
```

### 3.6 Beat-sync логика

```python
# librosa анализирует BGM
tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
onset_frames = librosa.onset.onset_detect(y=y, sr=sr)

# snap_to_beat(): сдвигает точку перехода к ближайшему биту
# tolerance_sec = 0.5 — если бит дальше, оставляет как есть

# compute_beat_aligned_segment_weights():
# Пересчитывает длины клипов пропорционально, чтобы
# переходы попадали на биты
```

---

## 4. Очереди BullMQ — детали

| Очередь          | Воркеры | Retry | Назначение                  |
| ---------------- | ------- | ----- | --------------------------- |
| `pipeline`       | 2       | 3×exp | Запуск пайплайна, fan-out   |
| `gpt-script`     | 2       | 3×exp | GPT/Claude сценарий         |
| `heygen-render`  | 3       | 5×exp | HeyGen avatar polling       |
| `kling-clip`     | 5       | 5×exp | Kling text-to-video polling |
| `runway-clip`    | 5       | 5×exp | Runway video polling        |
| `image-gen`      | 4       | 3×exp | fal.ai/Runway image gen     |
| `video-compose`  | 2       | 3×exp | Монтаж + Whisper            |
| `pipeline-state` | 10      | 1     | Проверка завершения, fan-in |
| `scheduler`      | 1       | —     | Cron tick каждые 60 сек     |
| `publish`        | 2       | 3×30s | Публикация в соцсети        |

---

## 5. База данных — ключевые модели

```
Tenant (1)
 ├── Users (N)           — пользователи tenant
 ├── Projects (N)        — рабочие пространства
 ├── Products (N)        — карточки товаров (name, features, images[])
 ├── VideoPresets (N)    — «завод» настроек (cron, avatar, style)
 ├── Videos (N)          — итоговые видео
 │    └── Scenes (N)     — 3-10 сцен на видео
 ├── Jobs (N)            — 1:1 с видео, BullMQ tracking
 │    └── JobEvents (N)  — audit log, append-only
 ├── Generations (N)     — каждый AI-вызов, cost tracking
 ├── CreditTransactions  — движение кредитов
 └── SocialAccounts      — OAuth токены для публикации
```

**Стратегия изоляции:** каждая таблица содержит `tenant_id`, все индексы составные с `tenant_id` первым. Row-level isolation без PostgreSQL RLS (проверки в коде).

---

## 6. AI Провайдеры и стоимость

| Провайдер                    | Назначение                 | Стоимость                   | Env var            |
| ---------------------------- | -------------------------- | --------------------------- | ------------------ |
| GPTunnel → Claude 4.6 Sonnet | Сценарий (idea + script)   | $3/1M input + $15/1M output | `GPTUNNEL_API_KEY` |
| HeyGen v2                    | Avatar video (1080×1920)   | ~$0.03/сек, мин. $0.10      | `HEYGEN_API_KEY`   |
| Runway Gen-4.5               | Text-to-video B-roll       | $0.12/сек                   | `RUNWAY_API_KEY`   |
| Runway Gen-4 Turbo           | Image-to-video B-roll      | $0.05/сек                   | `RUNWAY_API_KEY`   |
| Kling v1 Standard            | Text-to-video B-roll (alt) | $0.028/сек                  | `KLING_API_KEY`    |
| fal.ai flux-pro              | Image generation           | $0.055/image                | `FAL_API_KEY`      |
| Runway image turbo           | Image generation (alt)     | $0.02/image                 | `RUNWAY_API_KEY`   |

**Примерная стоимость одного 30-секундного видео:**

- Сценарий (claude): ~$0.02
- HeyGen (15 сек аватар): ~$0.45
- 3× Runway clip (5 сек × $0.05): ~$0.75
- 3× изображения (fal.ai): ~$0.17
- **Итого: ~$1.40 / видео**

---

## 7. Форматы вывода (Compose Presets)

| Пресет    | Переход         | Субтитры                            | BGM volume |
| --------- | --------------- | ----------------------------------- | ---------- |
| TikTok    | fade 0.25s      | Bold white, size 48, tiktok karaoke | 20%        |
| Instagram | smoothleft 0.5s | Cinematic grey, size 42             | 14%        |
| YouTube   | fade 0.4s       | White default, size 40              | 10%        |
| VK        | cut 0.15s       | Bold white, size 44, tiktok         | 16%        |

Каждое видео рендерится в **нескольких вариантах параллельно** — по одному на платформу.

---

## 8. Автоматизация — VideoPreset «Завод»

```
VideoPreset (status: active)
├── productId         — источник данных для сценария
├── heygenAvatarId    — ID аватара HeyGen
├── heygenVoiceId     — голос
├── editStyle         — dynamic | smooth | minimal | random
├── targetDurationSec — целевая длина
├── cronExpression    — стандартный 5-поле cron
├── timezone          — Europe/Moscow и др.
├── autoPublish       — публиковать сразу после рендера
├── publishPlatforms  — ['tiktok', 'instagram']
└── usedIdeaHashes[]  — хеши идей для anti-repeat
```

**Scheduler worker** (каждые 60 сек):

1. Ищет все active presets с `next_run_at <= NOW`
2. Создаёт `Video + Job` запись
3. Ставит в `pipeline` очередь
4. Обновляет `lastRunAt`, вычисляет следующий `nextRunAt`

---

## 9. Публикация в соцсети

| Платформа | Клиент           | Метод                                |
| --------- | ---------------- | ------------------------------------ |
| TikTok    | TikTokClient     | Скачивает в tempfile → uploadVideo() |
| Instagram | InstagramClient  | Presigned URL → uploadReel()         |
| YouTube   | YouTubeClient    | Presigned URL → YouTube Data API v3  |
| VK        | PostBridgeClient | PostBridge API                       |

Токены OAuth хранятся в БД **зашифрованными** (AES-256 через `crypto.ts`). При публикации декриптуются в памяти.

---

## 10. Quality Gate

OpenCV анализирует каждый клип перед монтажом:

| Проверка             | Порог                       | Severity                     |
| -------------------- | --------------------------- | ---------------------------- |
| Blur (Laplacian var) | < 25 critical, < 50 warning | critical/warning             |
| Black frames         | ≥60% чёрных кадров          | critical                     |
| Dark frames          | mean < 25                   | warning                      |
| Overexposure         | mean > 240                  | warning                      |
| No motion            | frame diff < 2.0            | warning                      |
| Min score to pass    | 0.4                         | (логирование, не блокировка) |

**Текущее поведение:** при critical issues — только логирование, монтаж продолжается. Видео не блокируется.

---

## 11. Субтитры (ASS format)

Используется формат **ASS (Advanced SubStation Alpha)** — нативный для FFmpeg burn-in.

| Стиль     | Особенности                                                            |
| --------- | ---------------------------------------------------------------------- |
| DEFAULT   | Arial, size 56, outline 3px, bottom-centre, fade-in                    |
| TIKTOK    | Arial Bold, size 72, karaoke \\kf теги, 3 слова/чанк, жёлтый highlight |
| CINEMATIC | Italic, size 44, полупрозрачный box, fade-in/out                       |
| MINIMAL   | Маленький шрифт, верх экрана, без outline                              |

Тайтминги берутся из **Whisper** (word-level timestamps) для frame-accurate синхронизации.

---

## 12. Что работает хорошо

1. **Fan-out архитектура** — параллельная генерация всех сцен сокращает время до 2-3× по сравнению с последовательной
2. **Combined HeyGen mode** — единый видеовызов для всех avatar-сцен экономит деньги и упрощает тайтминг субтитров
3. **Image-to-video двухэтап** — гарантирует что B-roll содержит реальный продукт из референсных изображений
4. **Beat-sync** — профессиональный монтаж в ритм музыки без ручной работы
5. **Anti-repeat идеи** — SHA-256 хеши не дают фабрике повторять одинаковые концепции
6. **Multi-variant рендер** — одно видео = несколько форматов для разных платформ параллельно
7. **PAS-фреймворк** — структурированный промпт даёт конверсионный сценарий
8. **Мультитенантность** — полная изоляция данных и биллинг на уровне tenant
9. **Whisper точные субтитры** — word-level timestamps вместо примерных тайтмингов

---

## 13. Проблемы и что улучшить

### 13.1 Критические проблемы

#### P0 — Quality Gate не блокирует

**Проблема:** `quality_gate.py` при critical issues (blur, black frames) только логирует, монтаж продолжается. В продакшне будут видео с браком.

**Решение:**

```python
# В pipeline.py — добавить retry или замену сцены при critical
critical = [i for i in report.issues if i.severity == "critical"]
if critical and not self.req.skip_quality_gate:
    raise ValueError(f"Quality gate failed: {[i.message for i in critical]}")
```

Настроить retry в BullMQ: при quality gate fail → перегенерировать только проблемную сцену.

#### P0 — Нет chroma key для HeyGen зелёного фона

**Проблема:** HeyGen генерирует аватар на зелёном фоне (`#00FF00`). В `ffmpeg.py` нет chromakey фильтра. Аватар накладывается поверх B-roll с зелёным фоном — это грубый баг.

**Решение:**

```python
# В normalize_video_clip или отдельной функции:
vf = (
    f"chromakey=0x00FF00:0.1:0.0,"  # удаляем зелёный
    f"scale={width}:{height}:..."
)
```

**Или** изменить HeyGen background на `transparent` (PNG/WebM с alpha-каналом) и использовать `-vf "chromakey"` + `overlay`.

#### P1 — Runway gen4_turbo не поддерживает text-to-video

**Проблема:** В `runway.client.ts` создан guard, что gen4_turbo не поддерживает text-to-video. Но если нет referenceImageUrl → fallback на gen4.5 (в 2.4× дороже) происходит молча. GPT должен всегда генерировать изображение для clip-сцен.

**Решение:** Сделать image-gen обязательным шагом перед runway-clip. Никакого text-to-video пути.

#### P1 — Аудио аватара теряется при конкатенации

**Проблема:** В combined mode аватар идёт как единый трек. При `concat_with_transitions` / `concat_with_lj_cuts` аудио сегментов нужно корректно remux. Риск: аудио может сдвинуться или потеряться при xfade переходах между сценами.

**Решение:** Явно разделять avatar audio track от video track при финальном миксе. Использовать `amerge` вместо `amix` для объединения дорожек.

---

### 13.2 Качество видео — что улучшить

#### V1 — Chroma Key (КРИТИЧНО для аватара)

Сейчас аватар просто ставится как отдельная сцена, а не накладывается поверх B-roll. Профессиональный формат — **split screen** или **overlay**:

```
┌─────────────────┐    ┌─────────────────┐
│                 │    │  B-roll фон     │
│  HeyGen аватар  │ →  │ ┌─────────────┐ │
│  (зел. фон)     │    │ │   Аватар    │ │
│                 │    │ │ (chromakey) │ │
└─────────────────┘    │ └─────────────┘ │
                       └─────────────────┘
```

FFmpeg команда:

```bash
ffmpeg -i broll.mp4 -i avatar.mp4 \
  -filter_complex "[1:v]chromakey=0x00FF00:0.15:0.0[ck]; [0:v][ck]overlay=0:H-h" \
  output.mp4
```

#### V2 — Ken Burns качество

Текущий Ken Burns использует `zoompan` через crop+eval. Проблемы:

- Нет easing (линейное движение выглядит механически)
- Нет поддержки диагональных движений

**Улучшение:** Добавить кривые Безье через expression-based eval:

```bash
# Easing: ease-in-out для zoom
crop=iw/zoom:ih/zoom:...,scale=W:H,zoompan=z='if(lte(on,1),1.2,max(1,zoom-0.0015))':...
```

#### V3 — Субтитры: анимация слов

Текущий TikTok стиль — базовый `\kf` karaoke. Трендовые видео используют:

- **Scale pop-in** каждого слова (`\fscx110\fscy110` → `\fscx100\fscy100`)
- **Цветовая подсветка** активного слова
- **Shadow/glow** эффект

Это уже частично реализовано в `subtitle.py`, но нет shadow/glow.

#### V4 — Переходы между сценами

Текущие переходы: fade, smoothleft, smoothright, cut (4 типа).

**Профессиональные переходы для добавления:**

- `zoom-punch` — быстрый zoom в момент перехода (TikTok trend)
- `glitch` — digital glitch эффект
- `wipe-vertical` — для вертикального видео (9:16)
- `motion-blur` — blur в направлении движения

Реализация через FFmpeg `xfade` filter с custom expressions:

```python
# glitch transition
"xfade=transition=custom:duration=0.2:offset={offset}:expr='..."
```

#### V5 — LUT (цветовые пресеты)

Добавить профессиональные LUT файлы для разных настроений:

- `cinematic_teal_orange.cube` — кинематографичный (teal + orange)
- `vintage_warm.cube` — тёплый ретро
- `clean_bright.cube` — яркий, для beauty/food
- `dramatic_dark.cube` — тёмный и контрастный

```python
# FFmpeg с LUT:
vf = f"lut3d={lut_path}"
```

#### V6 — Whisper точность

Текущий параметр `max_words_per_chunk: 12`. Для TikTok оптимально **2-3 слова** на чанк — так субтитры читабельнее.

Также не используется Whisper `word_timestamps` опция — нужно включить для sentence-level accuracy.

#### V7 — Audio ducking

При переходе от B-roll к аватару BGM нужно делать _ducking_ (снижение громкости). Сейчас `amix` смешивает с фиксированным volume. Нужен `sidechaincompress` или `volume` с `enable=between`:

```bash
# FFmpeg audio ducking:
[bgm][avatar_audio]sidechaincompress=threshold=0.02:ratio=8:attack=0.001:release=0.3[bgm_ducked]
```

#### V8 — Финальный encode настройки

Текущий encode: `-preset slow -crf 20`. Для соцсетей нужна более агрессивная оптимизация:

```bash
# Оптимальные настройки для TikTok/Instagram:
-c:v libx264 -preset veryslow -crf 18 -profile:v high -level 4.0
-c:a aac -b:a 192k -ar 44100
-movflags +faststart
-vf "format=yuv420p"  # обязательно для совместимости
-maxrate 8M -bufsize 16M  # ограничение пиков для стриминга
```

#### V9 — Thumbnail генерация

Сейчас нет автоматической генерации thumbnail из финального видео. Нужно:

1. Извлечь самый "выразительный" кадр (не чёрный, не переход)
2. Опционально наложить текст/логотип

```python
# Извлечь кадр на 10% от длины видео:
ffmpeg -i final.mp4 -ss {duration*0.1} -vframes 1 thumbnail.jpg
```

---

### 13.3 Производительность

#### Perf-1 — Параллельная загрузка ассетов

В `pipeline.py` download stage уже асинхронный (`asyncio.gather`), но ffprobe запускается синхронно для каждого файла. Нужно batch ffprobe в thread pool.

#### Perf-2 — Кэш промежуточных файлов

Нет кэша нормализованных клипов. Если один продукт используется в нескольких видео, изображения перекачиваются и ренормализуются каждый раз. Добавить content-hash кэш в MinIO.

#### Perf-3 — Runway polling оптимизация

Текущий polling: `maxAttempts: 80, baseDelayMs: 15_000` = максимум 20 минут. Для коротких клипов (5 сек) Runway отвечает за 60-90 сек. Переключиться на **webhooks** когда Runway поддержит, пока — уменьшить baseDelay до 5 сек для первых 10 попыток.

#### Perf-4 — HeyGen polling

`maxAttempts: 80, baseDelayMs: 15_000`. HeyGen рендерит 15-секундный ролик ~2-3 минуты. Начальная задержка 15 сек слишком большая. Использовать exponential backoff: `5s, 10s, 15s, 30s...`.

---

### 13.4 Надёжность

#### Rel-1 — Нет deduplication guard в coordinator

Если coordinator.ts вызывается дважды (BullMQ retry) — будет дублирование сцен в БД. Нужна idempotency проверка:

```typescript
const existingScenes = await db.scene.count({ where: { jobId } });
if (existingScenes > 0) return; // already started
```

#### Rel-2 — MinIO temp файлы не чистятся при ошибке

В `pipeline.py` `work_dir` создаётся, но не удаляется при исключении. Нужен `try/finally`:

```python
try:
    result = await pipeline.run()
finally:
    shutil.rmtree(work_dir, ignore_errors=True)
```

#### Rel-3 — Нет circuit breaker для AI провайдеров

Если HeyGen/Runway недоступен — все воркеры зависают в polling до timeout. Нужен circuit breaker (opossum или ручная реализация):

- При 3 подряд ошибках → open circuit на 5 минут
- Воркеры получают `CircuitOpenError` → BullMQ delay retry

#### Rel-4 — Race condition в pipeline-state

`pipeline-state.worker.ts` проверяет `allDone` после каждого события. При высоком concurrency (10 воркеров pipeline-state) возможна гонка: два воркера одновременно видят `allDone=true` и ставят два `video-compose` задания. Нужен atomic lock через Redis `SET NX EX`.

---

### 13.5 Безопасность

#### Sec-1 — Presigned URLs в промптах

В `coordinator.ts` presigned URLs (1 час) передаются в GPT промпт для анализа изображений. Если промпт логируется — URL попадают в логи. Сократить TTL до 5 минут или использовать inline base64.

#### Sec-2 — Нет rate limit на /compose endpoint

`video-processor` не имеет rate limiting. Злоумышленник может послать тысячи запросов напрямую. Добавить nginx rate limit или middleware:

```python
# FastAPI limiter
from slowapi import Limiter
limiter = Limiter(key_func=get_remote_address)
@app.post("/compose")
@limiter.limit("10/minute")
```

#### Sec-3 — OAuth токены без rotation

`publish.worker.ts` декриптует токены и использует, но не делает token refresh при 401. Instagram токены живут 60 дней — без refresh публикация упадёт.

---

## 14. Roadmap улучшений по приоритетам

### Немедленно (P0) — Критические баги

- [ ] **Добавить Chroma Key** для HeyGen аватара — иначе видео непригодны
- [ ] **Quality Gate блокировка** — критические клипы должны вызывать retry сцены
- [ ] **Audio ducking** — BGM заглушается когда говорит аватар

### Краткосрочно (1-2 недели) — Качество видео

- [ ] **Ken Burns easing** — плавное движение камеры
- [ ] **LUT цветокоррекция** — 3-4 пресета настроения
- [ ] **Переходы: zoom-punch, glitch** — трендовые для TikTok
- [ ] **Субтитры: shadow/glow** — профессиональный вид
- [ ] **Thumbnail автогенерация** — обложка из лучшего кадра

### Среднесрочно (1 месяц) — Производительность и надёжность

- [ ] **Race condition fix** в pipeline-state (Redis NX lock)
- [ ] **Coordinator idempotency** check
- [ ] **Circuit breaker** для AI провайдеров
- [ ] **Token refresh** для Instagram/TikTok OAuth
- [ ] **Whisper word-level** субтитры (2-3 слова/чанк)
- [ ] **Polling оптимизация** (adaptive backoff)

### Долгосрочно (квартал) — Новые возможности

- [ ] **Аватар overlay** поверх B-roll (chroma key + overlay compositing)
- [ ] **Многоязычность** — субтитры на нескольких языках автоматически
- [ ] **A/B тестирование** вариантов видео с analytics
- [ ] **Webhook от Runway/HeyGen** вместо polling
- [ ] **GPU-accelerated FFmpeg** (NVENC) для ускорения encode
- [ ] **Автоматический A/B тест хуков** — тест 3 вариантов opening
- [ ] **VK Clips API** нативная интеграция
- [ ] **Аналитика CTR** — подтягивать метрики из соцсетей, оптимизировать промпты

---

## 15. Как сделать видео лучше — конкретные рецепты

### 15.1 Лучший хук (первые 3 секунды)

Текущий IDEA_SYSTEM_PROMPT перечисляет типы хуков. Добавить обязательный паттерн:

```
HOOK FORMULA (обязательно):
- Кадр 1 (0-1 сек): ВИЗУАЛЬНЫЙ УДАР — неожиданный образ, крупный план
- Кадр 2 (1-2 сек): ПРОБЛЕМА в одну фразу, максимум 5 слов
- Кадр 3 (2-3 сек): ИНТРИГА — "но есть один способ..."

Запрещено начинать с приветствия. Запрещено медленное intro.
```

### 15.2 Музыкальный ритм

Подбирать BGM по темпу: для динамичных видео — 120-140 BPM, для lifestyle — 90-110 BPM. Добавить метаданные в BGM файлы и выбирать по `editStyle`:

- `dynamic` → 128-140 BPM
- `smooth` → 90-110 BPM
- `minimal` → 70-90 BPM

### 15.3 Визуальная консистентность

В SCRIPT_SYSTEM_PROMPT уже есть PRODUCT_VISUAL_PROFILE анализ. Усилить требование:

```
VISUAL RULE: Каждый b_roll_prompt ОБЯЗАН включать:
1. Точный цвет упаковки продукта (из PRODUCT_VISUAL_PROFILE)
2. Материал/текстуру
3. Один уникальный визуальный элемент продукта
4. Контекст использования (рука, стол, ванная комната)
Запрещено: generic "product on shelf", "white background product shot"
```

### 15.4 Длина сцен

Оптимальные длины для TikTok:

- Hook (avatar): **2-3 сек** — максимально быстро
- Agitate (avatar): **3-4 сек**
- Product reveal (clip): **3 сек** — hero shot
- Benefit (avatar + clip): **4-5 сек** × 2-3 раза
- CTA (avatar): **3-4 сек**
- **Итого: 20-30 сек** — оптимум для Reels/Shorts

Сейчас GPT ставит 5 сек по умолчанию — нужно в промпт добавить точные рекомендации.

### 15.5 Cinematic quality encode

Для максимального качества финального видео (публикация IG/YouTube):

```bash
# 2-pass encode для точного битрейта:
# Pass 1:
ffmpeg -i input.mp4 -c:v libx264 -b:v 6M -pass 1 -f null /dev/null
# Pass 2:
ffmpeg -i input.mp4 -c:v libx264 -b:v 6M -pass 2 \
  -c:a aac -b:a 192k -movflags +faststart output.mp4
```

Или использовать `libx265` (HEVC) — в 2× лучше сжатие при том же качестве (если платформа поддерживает).

### 15.6 Text overlay / Lower thirds

Добавить опциональные lower thirds (текст поверх видео) для усиления ключевых фраз. FFmpeg drawtext:

```python
vf_text = (
    f"drawtext=fontfile=/fonts/Arial-Bold.ttf:"
    f"text='{benefit_text}':"
    f"fontcolor=white:fontsize=36:"
    f"box=1:boxcolor=black@0.5:boxborderw=5:"
    f"x=(w-text_w)/2:y=h-150:"
    f"enable='between(t,{start},{end})'"
)
```

---

## 16. Диагностика текущих проблем

### Проверка состояния системы

```bash
# Статус очередей BullMQ
redis-cli info stats

# Активные воркеры
docker-compose ps

# Логи пайплайна
docker-compose logs orchestrator --tail=100

# Логи монтажа
docker-compose logs video-processor --tail=100

# Проверка MinIO
mc ls minio/kmmzavod/
```

### Типичные ошибки и решения

| Ошибка                         | Причина                                 | Решение                           |
| ------------------------------ | --------------------------------------- | --------------------------------- |
| `EAI_AGAIN hostname`           | Docker DNS + Ubuntu 24 nftables         | Переключить на iptables-legacy    |
| `HeyGen create error`          | Неверный avatar_id или rate limit       | Проверить HEYGEN_API_KEY баланс   |
| `Runway FAILED`                | Промпт > 1000 символов                  | Уже обрезается в worker           |
| `Quality gate FAILED`          | Kling/Runway сгенерировал брак          | Включить retry через quality gate |
| `Workers may still be running` | Race condition, compose запустился рано | Pipeline-state race fix           |
| `Circuit breaker`              | Нет (нужно добавить)                    | Добавить opossum                  |

---

_Документ создан автоматически на основе анализа исходного кода проекта kmmzavod. Обновлять при изменениях архитектуры._
