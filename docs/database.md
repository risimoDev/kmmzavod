# Schema Reference: Схема базы данных

## Диаграмма связей

```
tenants (1)──────────────────────────────────────────────────────────┐
   │                                                                  │
   ├──(N) users ──────────────────────────────( N) user_sessions      │
   │        │                                                         │
   │        ├──(N) videos ◄────────────────── jobs (1:1)             │
   │        │        │                          │                     │
   │        │        └──(N) scenes ◄────────────┤                    │
   │        │                  │                │                     │
   │        │                  └──(N) generations                     │
   │        │                                   │                     │
   │        └──(N) generations                  │                     │
   │                                            │                     │
   ├──(N) projects ──────(N) videos            job_events             │
   │        └──(N) assets                                             │
   │                                                                  │
   ├──(N) tenant_billing_plans ─────────── billing_plans             │
   ├──(N) credit_transactions                                         │
   ├──(N) usage_records                                               │
   └──(N) notifications                                               │
                                                                      │
admin_settings (глобальные)                                           │
admin_audit_logs ─────────────────────────── users (admin_id) ───────┘
```

## Таблицы и их назначение

| Таблица                | Строк (ожидаемо)  | Назначение                                  |
| ---------------------- | ----------------- | ------------------------------------------- |
| `tenants`              | тысячи            | Организации, первый уровень изоляции        |
| `users`                | десятки тысяч     | Пользователи, строго привязаны к tenant     |
| `user_sessions`        | сотни тысяч       | Refresh-токены, очищаются по TTL            |
| `projects`             | сотни тысяч       | Рабочие пространства внутри tenant          |
| `videos`               | миллионы          | Финальные видео — главная сущность продукта |
| `jobs`                 | миллионы          | 1:1 с видео, трекинг очереди обработки      |
| `job_events`           | десятки миллионов | Аудит лог, append-only                      |
| `scenes`               | десятки миллионов | Сцены внутри видео, 3-10 на видео           |
| `assets`               | миллионы          | Загруженные файлы пользователей             |
| `generations`          | сотни миллионов   | Каждый AI API вызов — отдельная строка      |
| `credit_transactions`  | десятки миллионов | Движение кредитов                           |
| `usage_records`        | миллионы          | Дневные агрегаты (1 строка / tenant / день) |
| `billing_plans`        | единицы           | Описание тарифов                            |
| `tenant_billing_plans` | тысячи            | История смен тарифа                         |
| `admin_settings`       | десятки           | Ключ-значение конфигурации                  |
| `admin_audit_logs`     | миллионы          | Действия администраторов                    |
| `notifications`        | десятки миллионов | Уведомления пользователей                   |

## Стратегия индексирования

### Принцип: каждый WHERE всегда содержит tenant_id первым

Все запросы в приложении имеют паттерн:

```sql
WHERE tenant_id = $1 AND <условие>
```

Поэтому все составные индексы начинаются с `tenant_id`.

### Критичные индексы объяснены

```sql
-- videos: главный дашборд пользователя
idx_videos_tenant_status    (tenant_id, status)
-- Запрос: "покажи все видео со статусом completed"

idx_videos_tenant_created   (tenant_id, created_at DESC)
-- Запрос: "последние 20 видео пользователя" — LIMIT 20 без сортировки на диске

-- generations: самая объёмная таблица
idx_gen_tenant_provider_ts  (tenant_id, provider, created_at DESC)
-- Запрос: "сколько потрачено на HeyGen за последний месяц"
-- Покрывающий индекс — не трогает heap при агрегации

idx_gen_external_task       (external_task_id) WHERE NOT NULL
-- Запрос: воркер ищет generation по ID задачи у провайдера
-- Partial index — исключает NULL строки, индекс в 10x меньше

-- scenes: поиск по ID провайдера (для webhook/polling)
idx_scenes_heygen_id        (heygen_video_id) WHERE NOT NULL
idx_scenes_kling_id         (kling_task_id)   WHERE NOT NULL
-- Воркер получает webhook от HeyGen → ищет сцену за O(1)

-- assets: мягкое удаление
idx_assets_tenant_live      (tenant_id) WHERE is_deleted = FALSE
-- Partial index: "живые" assets — 95% запросов, индекс компактный

-- user_sessions: очистка просроченных
idx_user_sessions_expires   (expires_at)
-- Cron: DELETE FROM user_sessions WHERE expires_at < NOW()
-- Без этого индекса — seq scan по миллионам строк
```

## Стратегия масштабирования

### Фаза 1 — одна БД (до 100K видео)

- Всё в одной PostgreSQL 15 инстанции
- `pg_bouncer` для пулинга соединений (target: 10-20 соединений на воркер)
- `VACUUM` и `ANALYZE` настроены агрессивно для `generations` и `job_events`
- `work_mem = 64MB` для аналитических запросов usage

### Фаза 2 — read replica (100K – 1M видео)

```
Primary  ──WAL──► Replica 1 (аналитика, usage_records, admin дашборд)
         ──WAL──► Replica 2 (воркеры — чтение статусов jobs/scenes)
```

- Все SELECT в воркерах → replica
- Все INSERT/UPDATE → primary
- Разделение реализуется в ORM через два connection pool

### Фаза 3 — партиционирование (1M+ видео)

```sql
-- generations партиционируем по дате (самая быстрорастущая таблица)
CREATE TABLE generations (...)
PARTITION BY RANGE (created_at);

CREATE TABLE generations_2026_01 PARTITION OF generations
FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- Старые партиции архивируем в cold storage (TimescaleDB или pg_partman)

-- job_events — аналогично
CREATE TABLE job_events PARTITION BY RANGE (created_at);
```

- `pg_partman` для автоматического создания партиций
- Индексы создаются на каждой партиции отдельно
- `pg_cron` для архивации партиций старше 6 месяцев

### Фаза 4 — шардирование по tenant_id (10M+ видео)

- Citus (расширение PostgreSQL) — горизонтальный шардинг
- `tenant_id` = шардинг ключ
- Каждый тенант целиком на одном шарде → нет cross-shard запросов
- Большие enterprise тенанты → dedicated шард

## Безопасность изоляции данных

### Уровень 1: FK + middleware (обязательно)

```typescript
// В каждом репозитории:
async findVideo(id: string, tenantId: string) {
  return db.video.findFirst({
    where: { id, tenant_id: tenantId }  // tenant_id всегда в WHERE
  });
}
```

### Уровень 2: PostgreSQL RLS (опционально, для Supabase)

```sql
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON videos
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

### Уровень 3: тестирование изоляции

```typescript
// Интеграционный тест:
it("не возвращает видео другого тенанта", async () => {
  const other = await createTenant();
  const video = await createVideo(other.id);
  const result = await videoRepo.find(video.id, myTenantId);
  expect(result).toBeNull(); // должно быть null
});
```
