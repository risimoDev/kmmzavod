# Кампании — сквозной автопилот контента

Цель: одна сущность, которая связывает **производство контента** (генерация /
уникализация / умный монтаж) и **дистрибуцию** (ферма аккаунтов + публикация) в
единый самоподдерживающийся цикл. Пользователь задаёт «что, куда, как часто и с
какими ограничениями» — система сама держит буфер готовых видео и публикует их по
расписанию на здоровые аккаунты, соблюдая анти-бан правила.

Статус: 🟦 дизайн (этот документ). Реализация — по фазам ниже.

---

## 1. Ментальная модель

**Кампания = SUPPLY (поставка контента) + DEMAND (спрос на публикации), которые
control-loop держит в балансе.**

- **DEMAND** детерминирован: `аккаунтов × постов_в_день` = сколько готовых видео
  нужно ежедневно.
- **SUPPLY** — буфер готовых, ещё не опубликованных `UniqueVariant`. Луп следит,
  чтобы буфер был на N дней вперёд, и при нехватке запускает производство.
- Луп на каждом тике: пополнить буфер → если пора публиковать, взять готовые
  варианты → выбрать пригодные аккаунты → создать DistributeJob → собрать метрики.

Кампания **не дублирует** существующие движки — она ими **дирижирует**:
VideoPreset/pipeline (генерация), UniquifyJob (уникализация), EditProject (монтаж),
DistributeJob/PublishJob (публикация), DistributeSchedule (крон). Всё это уже есть.

---

## 2. Модель данных (Prisma, новое)

```
Campaign
  id, tenantId, name, status(draft|active|paused|completed|archived)
  productId?                      // связь с Product (бренд/ниша/ассеты)
  // ── SUPPLY: откуда берётся контент ─────────────────────────────
  contentSource  enum(generate | uniquify | montage | manual)
  //   generate → крутит VideoPreset-пайплайн (HeyGen/Runway…)
  //   uniquify → берёт SourceVideo и делает UniqueVariant’ы
  //   montage  → EditProject (smart editor) → SourceVideo → uniquify
  //   manual   → пользователь сам заливает готовые варианты в кампанию
  sourceConfig   Json            // preset/heygen/voice/uniquify config снапшот
  bufferDays     Int  @default(2)     // держать готовых на N дней спроса
  maxBuildAhead  Int  @default(50)    // потолок «производить заранее»
  // ── DEMAND: куда и как часто ───────────────────────────────────
  accountGroupId?                 // целевая группа фермы
  socialAccountIds String[]       // и/или явные аккаунты
  platforms      SocialPlatform[] // фильтр платформ
  postsPerAccountPerDay Int @default(1)
  cronExpression String           // окна публикации, e.g. "0 12,18 * * *"
  timezone       String @default("Europe/Moscow")
  staggerMinutes Int  @default(15)
  // ── Гардрейлы ──────────────────────────────────────────────────
  captionTemplate String?         // {{index}},{{platform}},{{product}}
  hashtags        String[]
  minHealth       Int @default(30)
  dedupPerAccount Boolean @default(true)  // не слать похожее одному аккаунту
  respectWarmup   Boolean @default(false) // = AccountGroup.enforceWarmup override
  // ── Жизненный цикл ─────────────────────────────────────────────
  startAt DateTime?  endAt DateTime?
  lastRunAt DateTime?  nextRunAt DateTime?
  // ── Статистика (денормализованный кэш) ─────────────────────────
  variantsReady Int @default(0)  variantsPublished Int @default(0)
  postsPublished Int @default(0)  postsFailed Int @default(0)
  lastError String?
  createdAt, updatedAt

CampaignRun                       // журнал каждого тика (наблюдаемость)
  id, campaignId, tenantId
  kind enum(buffer_topup | distribute | reconcile)
  startedAt, finishedAt
  summary Json  // {produced, distributed, skipped, reasons[...]}
  error String?
```

Связи-обратные ссылки (не обязательные, но полезны для отчётов):
- `UniquifyJob.campaignId?`, `EditProject.campaignId?`, `DistributeJob.campaignId?`
  — чтобы прослеживать, что породила кампания, и агрегировать метрики.

Миграции: `add_campaigns`, `add_campaign_backrefs`.

---

## 3. Control-loop (в scheduler.worker, тик 60с)

Для каждой `active` кампании, где `nextRunAt <= now` **или** нужен top-up буфера:

### 3.1 Buffer top-up (SUPPLY)
1. Посчитать `demandPerDay = eligibleAccounts × postsPerAccountPerDay`.
2. `target = demandPerDay × bufferDays` (не больше `maxBuildAhead`).
3. `ready = count(UniqueVariant completed, unpublished, кампании)`.
4. `inFlight = count(вариантов в очереди/рендере кампании)`.
5. Если `ready + inFlight < target` — произвести `need = target - ready - inFlight`:
   - `generate`: создать Video+Job из `sourceConfig` (как scheduler делает для
     VideoPreset) → пайплайн → на выходе SourceVideo → авто-uniquify на `need`.
   - `uniquify`: взять `sourceConfig.sourceVideoIds` → создать UniquifyJob с
     `variantCount=need`.
   - `montage`: создать EditProject → analyze → авто-render → SourceVideo →
     uniquify. (самый длинный путь; ставим заранее.)
   - `manual`: ничего не производим, только предупреждаем если буфер пуст.
   - Дросселирование: не больше 1 активного производящего джоба на кампанию,
     чтобы не залить очередь.

### 3.2 Distribute (DEMAND)
Срабатывает только когда наступило крон-окно (`nextRunAt<=now`), иначе только top-up.
1. Резолвим аккаунты (group ∪ ids), фильтр по platforms.
2. Через `computeReadiness` (уже есть) отбрасываем непубликующих; причины пишем в
   `CampaignRun.summary`.
3. Для каждого аккаунта берём его дневной остаток:
   `slots = postsPerAccountPerDay − постов_сегодня` (по PublishJob published за
   день). Пропускаем 0-слотовые.
4. Берём `Σslots` свежих готовых вариантов (completed, `publishJobs none`,
   `distributeItems none`), с учётом **дедупа**: не давать аккаунту вариант,
   визуально/по pHash близкий к уже отправленному ему (используем `UniqueVariant.pHash`).
5. Раскладка round-robin по (uniquifyJob → DistributeJob), как в текущем
   `runDistributeSchedulesTick` — переиспользуем его логику.
6. Ставим `nextRunAt = nextCron(...)`; пишем итог в CampaignRun.

### 3.3 Reconcile
- Чинит застрявшие производящие джобы (уже есть `reconcileStuckUniquifyJobs`).
- Обновляет денормализованные счётчики кампании из фактов.
- Тянет метрики опубликованных постов (shadow-ban worker уже ходит за статусом) →
  агрегирует в кампанию для будущего contentScore-контура.

---

## 4. Выбор аккаунтов и анти-бан (переиспользуем существующее)

- **Readiness** (`publish-readiness.ts`) — единственный источник «можно ли постить».
- **Прокси 1-на-платформу** — уже реализовано (`pickProxyForPlatform`).
- **Гейты distribute.worker** — дневной лимит, health<30, 3ч-гэп, warmup — остаются
  как последняя линия; кампания дублирует лёгкие проверки заранее, чтобы не плодить
  заведомо-skipped items.
- **Дедуп** — на уровне кампании (pHash соседство) + уже есть уникальность
  `(distributeJobId, variantId, accountId)`.

---

## 5. Состояния кампании

```
draft ──activate──▶ active ──pause──▶ paused ──resume──▶ active
                      │                                    │
                      └── endAt reached / manual ─────────▶ completed ──▶ archived
```
- `draft`: настраивается, луп не трогает.
- `active`: луп работает (top-up + distribute).
- `paused`: производство и публикация остановлены; in-flight доигрывает.
- `completed`: `endAt` наступил или пользователь завершил; финальные метрики.
- `archived`: скрыта из активного списка.

Edge-cases: нет прокси → предупреждение, не блок; буфер не наполняется (нет
исходников для uniquify) → `lastError` + подсказка; все аккаунты cold при
`respectWarmup` → понятная причина в CampaignRun.

---

## 6. API (Fastify, `/api/v1/campaigns`)

```
POST   /campaigns                 создать (draft)
GET    /campaigns                 список + сводные метрики
GET    /campaigns/:id             деталь: конфиг, буфер, последние CampaignRun,
                                  связанные distribute/uniquify джобы, live-лог
PATCH  /campaigns/:id             правка конфига (в draft/paused)
POST   /campaigns/:id/activate    draft/paused → active (валидация: есть аккаунты,
                                  контент-стратегия консистентна)
POST   /campaigns/:id/pause
POST   /campaigns/:id/complete
DELETE /campaigns/:id             архив
GET    /campaigns/:id/runs        журнал тиков (наблюдаемость)
POST   /campaigns/:id/run-now     ручной прогон одного тика (для отладки)
```

Валидация активации: контент-источник задан и осмыслен, есть хотя бы 1 пригодный
аккаунт, крон валиден. Иначе — 400 с конкретной причиной.

---

## 7. UI (`/campaigns`)

- **Список**: карточки кампаний со статусом, прогресс-баром «буфер vs спрос»,
  постов сегодня/всего, health-сводкой аккаунтов, ошибками.
- **Мастер создания** (4 шага, по паттерну редактора):
  1. Продукт + контент-стратегия (generate/uniquify/montage/manual) с превью
     конфигурации;
  2. Аудитория: группа/аккаунты + платформы + readiness-предпросмотр (сколько
     готовы постить прямо сейчас);
  3. Ритм: постов/аккаунт/день, крон-окна, стаггер, буфер на N дней;
  4. Гардрейлы: подпись/хэштеги, health-порог, дедуп, warmup, даты.
- **Деталь кампании** = командный центр:
  - «Пульс»: буфер (готово/в производстве/нужно), спрос/день, ETA следующей
    публикации;
  - **Live-лог** (переиспользуем `PublishLogRow`): ссылки на аккаунт и видео,
    статус, ошибки, автообновление;
  - Журнал CampaignRun: что произвёл/разложил/пропустил и почему;
  - Кнопки activate/pause/complete/run-now.

---

## 8. Метрики и обратная связь (Фаза поздняя)

- Shadow-ban worker уже тянет статус постов → расширить до просмотров/лайков.
- Привязка `метрика → UniqueVariant/EditClip → sourceConfig` даёт контур обучения:
  со временем кампания предпочитает стили/моменты/аккаунты, которые «заходят».
  Старт — простые агрегаты в UI; ML-калибровка весов отбора — отдельным этапом.

---

## 9. Фазы реализации

- **Фаза 0 — модель+API**: Campaign/CampaignRun + миграции, CRUD, состояния,
  back-refs. Без лупа. UI: список + мастер + деталь (read-only пульс).
- **Фаза 1 — distribute-loop**: тик берёт готовые варианты и публикует (обобщение
  текущего `runDistributeSchedulesTick`), CampaignRun-журнал, live-лог. Кампания
  типа `manual`/`uniquify` с уже готовым контентом работает end-to-end.
- **Фаза 2 — buffer top-up**: авто-производство под спрос (generate/uniquify),
  дросселирование, ETA. `montage` — следом.
- **Фаза 3 — дедуп + метрики**: pHash-дедуп на аккаунт, агрегация результатов,
  сводки в UI.
- **Фаза 4 — обучение**: контур «метрика → отбор», авто-пауза деградирующих
  аккаунтов, перенос спроса на здоровые.

Каждая фаза самодостаточна и приносит ценность; после Фазы 1 пользователь уже
получает «одну кнопку» для существующего готового контента.

---

## 10. Решения (зафиксированы с заказчиком 2026-07-03)

1. **Контент-стратегия по умолчанию — `uniquify`** (исходники → N вариантов).
2. **Один продукт на кампанию** (проще, чище метрики, аккаунты-под-нишу).
3. **Буфер с запасом — `bufferDays=2`** (надёжнее к всплескам/сбоям).
4. **Порядок фаз: сначала распределение (Фаза 1)**, автопроизводство — Фаза 2.

### Фаза 1 — что строим сейчас
Кампания публикует УЖЕ готовые (completed, неопубликованные) `UniqueVariant`
по расписанию на пригодные аккаунты фермы. Буфер/производство (Фаза 2) — позже,
но модель проектируем сразу под них. Реализация Фазы 1:
- `Campaign` + `CampaignRun` + миграция (все поля, включая supply-поля для Ф2).
- API `/campaigns` CRUD + activate/pause/complete + runs + run-now.
- Distribute-loop в scheduler: per-account дневные слоты
  (`postsPerAccountPerDay − постов_сегодня`), readiness-фильтр, pHash-дедуп на
  аккаунт, DistributeJob по (uniquifyJob), журнал CampaignRun.
- UI `/campaigns`: список + мастер + деталь с «пульсом» и live-логом.
- Источник вариантов Ф1: `sourceConfig.uniquifyJobIds[]` (если заданы) либо любые
  completed-unpublished варианты тенанта.
