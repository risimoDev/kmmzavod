# Smart Editor — система интеллектуальной нарезки и монтажа

## Статус реализации (2026-06-30)

Легенда: ✅ готово и проверено · 🟦 готово, не прогнано вживую · ⬜ todo

- ✅ **Сервис `apps/editor`** (FastAPI :8300): config, models, main, Dockerfile, requirements, dev.mjs.
- ✅ **Анализ** (Фаза 1): ffmpeg probe/scene/energy/frame/phash, Whisper-RU/beat/face/motion
  (ленивые импорты), эвристический скоринг → EDL. **Проверено CLI на реальном видео.**
- ✅ **Отбор GPTunnel** (Фаза 2): gpt-4o-mini re-rank + титры, opt-in gpt-4o vision; graceful fallback без ключа.
- ✅ **Рендер** (Фаза 3): smart-crop (трекинг лица), cut/concat, оба режима звука, субтитры по
  финальному аудио, MinIO-аплоад, `/render`. **Проверено: реальные 1080×1920 и 1920×1080 MP4.**
- ✅ **Инфра (Фаза 0):** docker-compose `editor:8300` + env; Prisma `EditProject/EditSource/EditClip`
  + миграция `20260626120000_add_smart_editor` (схема валидна); orchestrator очереди
  `editor-analyze`/`editor-render` + payloads + `services/editor.ts`.
- ✅ **Orchestrator-воркеры** (Фаза 4): `editor-analyze.worker.ts` + `editor-render.worker.ts`,
  зарегистрированы в `index.ts`. **Скомпилированы 2026-07-03**: `tsc --noEmit` чисто.
- ✅ **Fastify API `/editor/*`** (Фаза 4): `editor.routes.ts` — projects CRUD, sources/upload,
  analyze, clips PATCH, render, outputs; очереди в `lib/queues.ts`, пути в `StoragePaths`,
  зарегистрирован в `app.ts`. **Скомпилировано 2026-07-03**: `tsc --noEmit` чисто.
- ✅ **Web UI** (Фаза 4): `apps/web/src/app/(app)/editor/page.tsx` (список+создание) и
  `editor/[id]/page.tsx` (загрузка → раскадровка с thumbnails/транскриптом → правка вкл-выкл/титры
  → render с поллингом → выходы: плееры/скачать/«в уникализацию»). `editorApi` в `lib/api.ts`,
  пункт «Editor» в `AppShell.tsx`. **`next build` прошёл 2026-07-03.**

- ✅ **Апгрейд движка (2026-07-03)** — качество отбора и рендера:
  - **Time-series анализ**: motion/face теперь временные ряды (`motion_series`/`face_series`
    в SourceAnalysis), скоринг различает моменты ВНУТРИ видео (раньше 40% веса были
    константой на весь ролик). Скаляры сохранены для совместимости/фолбэка.
  - **Речевой скоринг**: `speech_salience` (покрытие речью + hook-маркеры: вопросы,
    числа, «секрет/ошибка/способ»...) с весом 0.30 — раньше транскрипт в скоринге
    не участвовал вовсе.
  - **Снап границ**: `snap_window` двигает границы клипа к паузам речи (гэпы между
    словами ≥0.35с) и scene breaks — клип не начинается с полуслова.
  - **LLM-отбор по полному транскрипту**: `_llm_propose` отдаёт модели всю
    расшифровку с таймкодами → она сама предлагает диапазоны (хук/конфликт/панчлайн);
    мерж с эвристикой, fallback на старый re-rank. Дедуп кандидатов по pHash кадров.
  - **Трекинг smart-crop**: 6 сэмплов лица на сегмент → EMA-сглаженный путь →
    кусочно-линейный ffmpeg-expr в crop (кроп следует за лицом, не прыгает).
    **Проверено ffmpeg-прогоном с движущимся треком (RC 0).**
  - **Karaoke-субтитры**: word-timestamps из Whisper → короткие строки 2–4 слова,
    активное слово подсвечивается (`\k`-теги, SecondaryColour→Primary).
    **Проверено: ASS генерится и жжётся ffmpeg (RC 0).**
  - **Beat-snap в mix**: границы сегментов по бит-сетке librosa (было: только сцены).
  - **Sidechain-ducking в keep+BGM** (музыка приседает под речь, как в replace).
  - **Проверено e2e**: CLI render на синтетике → 1080×1920 и 1080×1080 mp4, quality
    gate ok; юнит-прогон скоринга: hook-окно 0.808 vs скучное 0.105 (было ~равно).

**ИТОГ: фича реализована end-to-end** (сервис + воркеры + API + web). Осталось опционально:
media-core (3b) и полировка (5). Backend-движок проверен реальным ffmpeg-рендером; TS-слои
(orchestrator/api/web) сверены по существующим паттернам, но не компилировались (deps не
установлены в этой среде) — типчек/билд прогнать при `pnpm install`.
- ⏭️ **media-core** (Фаза 3b): **СОЗНАТЕЛЬНО ОТЛОЖЕНО.** Требует смены build-context у
  `video-processor` на корень репо + рефактор импортов рабочего прод-сервиса, непроверяемый без
  Docker, ради дедупликации ~200 строк ffmpeg-хелперов. editor самодостаточен и работает.
  Делать отдельным PR, когда можно собрать Docker и прогнать uniquify-регресс.
- ✅ **Полировка** (Фаза 5): quality-gate (blackdetect/freezedetect — **проверено: флагает
  статичный клип как frozen**), быстрые пресеты в UI. Перф-тюнинг — по факту нагрузки.

ПРИМЕЧАНИЯ К ДЕПЛОЮ: `prisma migrate deploy && prisma generate`, пересобрать `editor` + `orchestrator`.
faster-whisper тянет модель при первом запуске (кэш HF). GPTunnel — ключ `GPTUNNEL_API_KEY`.

---


Новый сервис `apps/editor`. **Два разных продукта** с общим движком анализа/рендера:

- **Продукт 1 — «Нарезка/склейка под уникализацию» (`mode = uniquify_source`).**
  Утилитарный конвейер: режет длинное / склеивает N видео в сырьё → сохраняет как
  `SourceVideo` → исходник в существующей системе уникализации → ферма → публикация.
  Быстро, без субтитров (uniquify добавит свои из TTS-озвучки позже).

- **Продукт 2 — «Интеллектуальный монтаж» (`mode = smart_montage`).**
  Премиум-путь: Whisper считывает голос → **авто-субтитры под оригинальную речь**,
  умный LLM-отбор моментов, красивый монтаж (переходы/грейд/beat-sync), smart-crop →
  **готовое красивое видео** на выход (скачать/опубликовать; опц. тоже как `SourceVideo`).

## Решения (зафиксированы с заказчиком 2026-06-26)

| Вопрос | Решение |
| --- | --- |
| Структура | **Два режима**: `uniquify_source` (сырьё) и `smart_montage` (готовое видео) |
| Интеллект | Полный стек: эвристики + бит/музыка + vision + Whisper-речь |
| Компьют | **Гибрид**: лёгкое локально на CPU; отбор моментов и vision — через GPTunnel |
| LLM/Vision | **Только GPTunnel** (gpt-4o-mini текст + gpt-4o vision на кадрах). Gemini не нужен |
| STT | **Whisper локально** (faster-whisper, RU) — у GPTunnel нет транскрипции |
| Vision | **Opt-in через пресет** (не автоматом), кадры топ-кандидатов → gpt-4o |
| Звук | **Оба режима**: сохранить оригинал ИЛИ заменить на TTS+музыку |
| Контроль | **Авто + превью/правка**; превью = thumbnails + текст транскрипта (без прокси-рендера) |
| Формат | **Настраиваемый**: 9:16 / 1:1 / 16:9 / 4:5 + smart-crop (трекинг лица) |
| Общий код | Монтажные примитивы → **общий Python-пакет**, монтируется в editor и video-processor |
| Размещение | **Новый отдельный сервис** `apps/editor` (FastAPI, порт 8300) |

---

## Архитектура

```
apps/editor (Python/FastAPI :8300) — "мозг + резак"
  POST /analyze   → анализ источников → scored timeline + EDL + раскадровка (превью)
  POST /render    → берёт (возможно отредактированный) EDL → финальные видео в MinIO
  GET  /health

orchestrator (BullMQ):
  editor.analyze.worker  → дергает /analyze, пишет EditPlan + клипы в БД
  editor.render.worker   → дергает /render, создаёт SourceVideo(ы) для uniquify

api (Fastify): /api/v1/editor/* — проекты, загрузка, план, правка, рендер
web (Next.js): загрузка → раскадровка с превью → правка → «в уникализацию»
```

Принцип: **editor отвечает за АНАЛИЗ + РЕШЕНИЕ о монтаже (EDL)**, рендер — на
проверенных ffmpeg-примитивах (портируем из `video-processor`: `ffmpeg.py`,
`subtitle.py`, `beat_detect.py`, логику `montage.py`). Stateless как publisher:
БД/крипту держит orchestrator, editor получает presigned URL и отдаёт результат.

---

## Слой анализа (per source, локально на CPU — «дёшево»)

1. **ffprobe** — длительность/разрешение/fps.
2. **Scene detection** — `select='gt(scene,T)'` (паттерн уже есть в uniquify.py).
3. **Audio energy envelope** — RMS/громкость по времени (находим пики и тишину).
4. **Beat detection** — librosa (для ритмичной нарезки; код есть в beat_detect.py).
5. **Whisper** — faster-whisper (base/small, CPU) — транскрипт со словами+таймингами.
6. **Light CV**:
   - детект лиц (mediapipe / opencv) — для smart-crop и «есть человек в кадре»;
   - motion score (разница соседних кадров, сэмплинг 1–2 fps);
   - (опц.) OCR текста на экране.

Результат: `analysis.json` на каждый источник + единый **scored timeline**
(сегменты с метриками: речь, энергия, движение, лицо, граница сцены).

## Слой выбора моментов (гибрид: эвристика + GPTunnel — «умно»)

- **Эвристический скоринг** (локально): композитный балл сегмента =
  `w1·speech_salience + w2·audio_energy + w3·motion + w4·face + w5·scene_align`.
  Дешёвая эвристика прореживает таймлайн → дорогие вызовы только на топ-кандидатах.
- **LLM-отбор** (GPTunnel gpt-4o-mini): транскрипт + метаданные сегментов →
  ранжированные highlight-диапазоны с заголовками («где хук», «лучшие 30 сек»).
- **Vision** (GPTunnel gpt-4o, **opt-in через пресет**): кадры топ-кандидатов
  (base64) → оценка «интересности»/описание сцены. Для немого b-roll. Без Gemini.
- Итог — **EDL** (Edit Decision List): список выбранных диапазонов с порядком,
  баллом, заголовком, превью-кадром.

Геометрия выбора (общая для обоих продуктов):
- **Highlights**: top-K непересекающихся диапазонов из 1 длинного → K клипов.
- **Mix**: лучшие «биты» по N источникам → одна сборка (скоринг-driven версия
  существующего `build_plan` из montage.py, вместо чистого рандома).

## Слой рендера

- **Smart-crop reframe** под целевой aspect: трекинг лица/салиентной области →
  путь кадрирования (кусочно-статичный per сегмент, чтобы дёшево).
- Переходы (xfade), beat-snap (есть в montage.py).
- **Субтитры**: из Whisper (язык оригинала) — стили из subtitle.py.
- **Звук — 2 режима**: `keep` (оригинал + опц. музыка под duck) / `replace`
  (TTS-озвучка + музыка).

Различие продуктов на рендере:
- **`uniquify_source`**: cut/splice сырья, субтитры по умолчанию **выкл** (uniquify
  навесит свои), звук обычно `keep`. Выход → `SourceVideo` для уникализации.
- **`smart_montage`**: субтитры **всегда вкл** (под оригинальную речь), красивый
  грейд/переходы, smart-crop, музыка. Выход → готовое видео (скачать/опубликовать;
  опц. также `SourceVideo`).

Выход → MinIO; метаданные (duration/wh/phash/transcript/sceneBreaks) → `SourceVideo`.

---

## Модель данных (Prisma, новые)

- `EditProject` (tenantId, name, **mode `uniquify_source|smart_montage`**, geometry
  `highlights|mix`, targetAspect, audioMode, subtitles bool, status, config Json).
- `EditSource` (projectId, storageKey, durationSec, analysis Json).
- `EditClip` (projectId, edl Json, score, title, thumbKey, included Bool, order,
  outputSourceVideoId?) — одна строка = один предложенный/отрендеренный клип.
- На подтверждение клипа создаётся `SourceVideo` (existing) с заполненными
  `transcript/sceneBreaks/audioProfile` → сразу доступен в uniquify.

Миграция: `add_smart_editor`.

---

## Поток превью/правки (UI)

1. Загрузка N видео → `EditProject` (analyze).
2. editor отдаёт **раскадровку**: карточки клипов (thumbnail + сниппет транскрипта +
   балл + длина). Для mix — таймлайн сегментов.
3. Юзер: вкл/выкл клипы, меняет порядок, правит границы/заголовок, выбирает
   aspect/звук/субтитры/пресет.
4. Confirm → render → готовые `SourceVideo` появляются в списке исходников
   уникализации, кнопка «Запустить уникализацию».

---

## Фазы реализации

- **Фаза 0 — Каркас**: общий Python-пакет с монтажными примитивами (вынести из
  video-processor: `ffmpeg`, `subtitle`, `beat_detect`, `montage`), монтируется в
  оба образа. `apps/editor` (FastAPI скелет, Dockerfile, config, /health), порт 8300
  в docker-compose, `.env.example`. Orchestrator: очередь `editor` + config.
  Prisma модели + миграция `add_smart_editor`.
- **Фаза 1 — Анализ**: ingest + все анализаторы (вкл. Whisper-RU) → analysis.json +
  scored timeline. CLI (`cli.py` паттерн) для прогона на сэмплах и отладки качества.
- **Фаза 2 — Выбор + EDL**: эвристический скорер + GPTunnel-отбор (gpt-4o-mini),
  vision opt-in. Оба геометрических режима. Раскадровка (thumbnails + сниппеты).
- **Фаза 3 — Рендер**: smart-crop, переходы, субтитры, оба режима звука; ветвление
  `uniquify_source` vs `smart_montage` → MinIO.
- **Фаза 4 — Интеграция**: orchestrator воркеры, API `/editor/*`, web (загрузка →
  раскадровка → правка → выход в уникализацию / скачать).
- **Фаза 5 — Полировка**: пресеты/шаблоны, quality-gate (паттерн quality_gate.py),
  перф-тюнинг, конкаренси-лимиты.

## Открытые мелочи (решим по ходу)

- Whisper-модель: base vs small (RU). Старт — `small` (баланс точность/скорость).
- Лимиты: макс. длина/кол-во источников, кол-во клипов на проект.
