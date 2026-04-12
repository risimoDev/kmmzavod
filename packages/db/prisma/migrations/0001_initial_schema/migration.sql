-- =============================================================================
-- НАЧАЛЬНАЯ МИГРАЦИЯ: мультитенантная AI платформа генерации видео
-- PostgreSQL 15+
-- =============================================================================

BEGIN;

-- Расширения
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- ENUM ТИПЫ
-- =============================================================================

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TYPE video_status AS ENUM (
  'draft', 'pending', 'processing', 'composing', 'completed', 'failed', 'cancelled'
);

CREATE TYPE job_status AS ENUM (
  'pending', 'running', 'scenes_ready', 'processing', 'composing',
  'completed', 'failed', 'cancelled'
);

CREATE TYPE scene_type AS ENUM ('avatar', 'clip', 'image', 'text');

CREATE TYPE scene_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TYPE asset_type AS ENUM (
  'product_image', 'logo', 'audio', 'avatar_ref', 'font', 'other'
);

CREATE TYPE generation_provider AS ENUM (
  'openai', 'heygen', 'kling', 'fal', 'replicate', 'comfyui', 'elevenlabs'
);

CREATE TYPE generation_status AS ENUM (
  'pending', 'processing', 'completed', 'failed', 'cancelled'
);

CREATE TYPE credit_tx_type AS ENUM (
  'purchase', 'monthly', 'charge', 'refund', 'admin_grant', 'expiry'
);

CREATE TYPE notification_type AS ENUM (
  'system', 'billing', 'job_failed', 'credits_low', 'plan_expiring'
);

-- =============================================================================
-- TENANTS (организации / аккаунты)
-- =============================================================================

CREATE TABLE tenants (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  plan        TEXT        NOT NULL DEFAULT 'starter',
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  credits     INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tenants_slug_unique UNIQUE (slug),
  CONSTRAINT tenants_credits_non_negative CHECK (credits >= 0)
);

COMMENT ON TABLE  tenants             IS 'Организации — первый уровень изоляции данных';
COMMENT ON COLUMN tenants.slug        IS 'Уникальный URL-идентификатор (my-company)';
COMMENT ON COLUMN tenants.credits     IS 'Текущий баланс кредитов. Никогда не отрицательный.';

-- =============================================================================
-- USERS (пользователи)
-- =============================================================================

CREATE TABLE users (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email             TEXT        NOT NULL,
  role              user_role   NOT NULL DEFAULT 'member',
  password_hash     TEXT,
  display_name      TEXT,
  avatar_url        TEXT,
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at     TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_email_unique UNIQUE (email)
);

COMMENT ON COLUMN users.role IS 'owner=полный доступ, admin=управление, member=свои проекты, viewer=только чтение';

CREATE INDEX idx_users_tenant     ON users(tenant_id);
CREATE INDEX idx_users_email      ON users(email);
CREATE INDEX idx_users_tenant_role ON users(tenant_id, role);

-- =============================================================================
-- USER SESSIONS
-- =============================================================================

CREATE TABLE user_sessions (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT        NOT NULL,
  user_agent    TEXT,
  ip_address    INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT user_sessions_token_unique UNIQUE (refresh_token)
);

CREATE INDEX idx_user_sessions_user    ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

-- Автоматически удалять просроченные сессии (pg_cron или приложение)
COMMENT ON TABLE user_sessions IS 'Refresh-токены. Записи с expires_at < NOW() удаляются ежедневно.';

-- =============================================================================
-- PROJECTS (рабочие пространства)
-- =============================================================================

CREATE TABLE projects (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  settings    JSONB       NOT NULL DEFAULT '{}',
  is_archived BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN projects.settings IS 'Дефолтный аватар, разрешение, язык субтитров';

CREATE INDEX idx_projects_tenant           ON projects(tenant_id);
CREATE INDEX idx_projects_tenant_archived  ON projects(tenant_id, is_archived);

-- =============================================================================
-- VIDEOS (финальные видео)
-- =============================================================================

CREATE TABLE videos (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      UUID         REFERENCES projects(id),
  created_by      UUID         REFERENCES users(id),
  title           TEXT         NOT NULL,
  description     TEXT,
  status          video_status NOT NULL DEFAULT 'draft',
  output_url      TEXT,            -- ключ объекта в MinIO/S3
  thumbnail_url   TEXT,
  duration_sec    NUMERIC(6,2),
  file_size_bytes BIGINT,
  resolution      TEXT         DEFAULT '1080x1920',
  fps             SMALLINT     DEFAULT 30,
  error           TEXT,
  credits_used    INTEGER      NOT NULL DEFAULT 0,
  metadata        JSONB        NOT NULL DEFAULT '{}',
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_videos_tenant_status  ON videos(tenant_id, status);
CREATE INDEX idx_videos_tenant_created ON videos(tenant_id, created_at DESC);
CREATE INDEX idx_videos_project        ON videos(project_id);

-- =============================================================================
-- BILLING PLANS (тарифные планы)
-- =============================================================================

CREATE TABLE billing_plans (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT        NOT NULL,   -- starter, pro, enterprise
  display_name          TEXT        NOT NULL,
  price_monthly_usd     NUMERIC(10,2) NOT NULL,
  price_yearly_usd      NUMERIC(10,2),
  credits_per_month     INTEGER     NOT NULL,
  max_videos_per_month  INTEGER,                -- NULL = unlimited
  max_scenes_per_video  INTEGER,
  max_resolution        TEXT        NOT NULL DEFAULT '1080x1920',
  features              JSONB       NOT NULL DEFAULT '{}',
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT billing_plans_name_unique UNIQUE (name)
);

-- Дефолтные тарифы
INSERT INTO billing_plans (name, display_name, price_monthly_usd, price_yearly_usd, credits_per_month, max_videos_per_month, max_scenes_per_video, features)
VALUES
  ('starter',    'Старт',       29.00,  290.00,   200,  10,  5,  '{"watermark": true,  "priority_queue": false, "api_access": false}'),
  ('pro',        'Про',         79.00,  790.00,   800,  50,  15, '{"watermark": false, "priority_queue": false, "api_access": true}'),
  ('enterprise', 'Корпоратив', 299.00, 2990.00,  9999, NULL, NULL,'{"watermark": false, "priority_queue": true,  "api_access": true}');

-- =============================================================================
-- TENANT BILLING PLANS (текущий и исторический тариф тенанта)
-- =============================================================================

CREATE TABLE tenant_billing_plans (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id      UUID        NOT NULL REFERENCES billing_plans(id),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  is_current   BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_tbp_tenant_current ON tenant_billing_plans(tenant_id, is_current);
-- Гарантируем только один активный тариф на тенанта
CREATE UNIQUE INDEX idx_tbp_tenant_active ON tenant_billing_plans(tenant_id) WHERE is_current = TRUE;

-- =============================================================================
-- JOBS (очередь задач обработки)
-- =============================================================================

CREATE TABLE jobs (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  video_id      UUID        UNIQUE REFERENCES videos(id),
  project_id    UUID        REFERENCES projects(id),
  created_by    UUID        REFERENCES users(id),
  status        job_status  NOT NULL DEFAULT 'pending',
  payload       JSONB       NOT NULL,
  error         TEXT,
  credits_used  INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX idx_jobs_tenant_status  ON jobs(tenant_id, status);
CREATE INDEX idx_jobs_created_at     ON jobs(created_at DESC);
CREATE INDEX idx_jobs_tenant_created ON jobs(tenant_id, created_at DESC);

-- =============================================================================
-- JOB EVENTS (аудит лог — только добавление, без изменений)
-- =============================================================================

CREATE TABLE job_events (
  id         BIGSERIAL   PRIMARY KEY,
  job_id     UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id  UUID        NOT NULL,
  stage      TEXT        NOT NULL,
  status     TEXT        NOT NULL,   -- started | completed | failed
  message    TEXT,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Партиционирование job_events по месяцам рекомендуется при >10M строк
CREATE INDEX idx_job_events_job        ON job_events(job_id, created_at);
CREATE INDEX idx_job_events_tenant_ts  ON job_events(tenant_id, created_at DESC);

-- =============================================================================
-- SCENES (сцены видео)
-- =============================================================================

CREATE TABLE scenes (
  id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id           UUID         NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  video_id         UUID         REFERENCES videos(id),
  tenant_id        UUID         NOT NULL,
  scene_index      SMALLINT     NOT NULL,
  type             scene_type   NOT NULL,
  status           scene_status NOT NULL DEFAULT 'pending',
  -- Промпты
  script           TEXT,
  b_roll_prompt    TEXT,
  -- Длительность
  duration_sec     NUMERIC(5,2),
  -- Флаги завершения
  avatar_done      BOOLEAN      NOT NULL DEFAULT FALSE,
  clip_done        BOOLEAN      NOT NULL DEFAULT FALSE,
  image_done       BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Ключи артефактов в хранилище
  avatar_url       TEXT,
  clip_url         TEXT,
  image_url        TEXT,
  -- ID задач у внешних провайдеров
  heygen_video_id  TEXT,
  kling_task_id    TEXT,
  image_gen_task_id TEXT,
  -- Стоимость
  cost_usd         NUMERIC(10,6) NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT scenes_job_index_unique UNIQUE (job_id, scene_index)
);

CREATE INDEX idx_scenes_job          ON scenes(job_id);
CREATE INDEX idx_scenes_video        ON scenes(video_id);
CREATE INDEX idx_scenes_tenant       ON scenes(tenant_id);
CREATE INDEX idx_scenes_heygen_id    ON scenes(heygen_video_id) WHERE heygen_video_id IS NOT NULL;
CREATE INDEX idx_scenes_kling_id     ON scenes(kling_task_id)   WHERE kling_task_id IS NOT NULL;

-- =============================================================================
-- ASSETS (загружаемые файлы)
-- =============================================================================

CREATE TABLE assets (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      UUID        REFERENCES projects(id),
  uploaded_by     UUID        REFERENCES users(id),
  type            asset_type  NOT NULL,
  filename        TEXT        NOT NULL,
  storage_key     TEXT        NOT NULL,
  mime_type       TEXT,
  file_size_bytes BIGINT,
  width           INTEGER,
  height          INTEGER,
  duration_sec    NUMERIC(6,2),
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assets_tenant      ON assets(tenant_id, type);
CREATE INDEX idx_assets_project     ON assets(project_id);
CREATE INDEX idx_assets_tenant_live ON assets(tenant_id) WHERE is_deleted = FALSE;
-- Полнотекстовый поиск по имени файла и тегам
CREATE INDEX idx_assets_tags        ON assets USING GIN(tags);

-- =============================================================================
-- GENERATIONS (трекинг каждого AI API вызова)
-- =============================================================================

CREATE TABLE generations (
  id                BIGSERIAL           PRIMARY KEY,  -- BigInt для объёмных таблиц
  tenant_id         UUID                NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           UUID                REFERENCES users(id),
  job_id            UUID                REFERENCES jobs(id),
  scene_id          UUID                REFERENCES scenes(id),
  provider          generation_provider NOT NULL,
  model             TEXT                NOT NULL,
  status            generation_status   NOT NULL DEFAULT 'pending',
  -- Токены (для GPT / LLM)
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  -- Сырые данные запроса/ответа (для отладки)
  request_payload   JSONB,
  response_payload  JSONB,
  -- Внешний ID задачи у провайдера
  external_task_id  TEXT,
  -- Стоимость
  cost_usd          NUMERIC(10,6) NOT NULL DEFAULT 0,
  credits_charged   INTEGER       NOT NULL DEFAULT 0,
  -- Метрики времени
  latency_ms        INTEGER,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  error             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Частые запросы: "сколько потрачено тенантом за период по провайдеру"
CREATE INDEX idx_gen_tenant_provider_ts ON generations(tenant_id, provider, created_at DESC);
CREATE INDEX idx_gen_tenant_status      ON generations(tenant_id, status);
CREATE INDEX idx_gen_scene              ON generations(scene_id);
CREATE INDEX idx_gen_external_task      ON generations(external_task_id) WHERE external_task_id IS NOT NULL;

-- Партиционирование по месяцам при >50M строк:
-- ALTER TABLE generations PARTITION BY RANGE (created_at);

-- =============================================================================
-- CREDIT TRANSACTIONS (движение кредитов)
-- =============================================================================

CREATE TABLE credit_transactions (
  id            BIGSERIAL       PRIMARY KEY,
  tenant_id     UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          credit_tx_type  NOT NULL,
  amount        INTEGER         NOT NULL,         -- + начисление, - списание
  balance_after INTEGER         NOT NULL,
  description   TEXT,
  job_id        UUID            REFERENCES jobs(id),
  invoice_id    TEXT,                             -- ID в платёжной системе
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT credit_tx_balance_non_negative CHECK (balance_after >= 0)
);

CREATE INDEX idx_credit_tx_tenant_ts   ON credit_transactions(tenant_id, created_at DESC);
CREATE INDEX idx_credit_tx_tenant_type ON credit_transactions(tenant_id, type);
CREATE INDEX idx_credit_tx_job         ON credit_transactions(job_id) WHERE job_id IS NOT NULL;

-- =============================================================================
-- USAGE RECORDS (дневные агрегаты для аналитики)
-- =============================================================================

CREATE TABLE usage_records (
  id                   BIGSERIAL   PRIMARY KEY,
  tenant_id            UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date                 DATE        NOT NULL,
  videos_created       INTEGER     NOT NULL DEFAULT 0,
  scenes_generated     INTEGER     NOT NULL DEFAULT 0,
  credits_used         INTEGER     NOT NULL DEFAULT 0,
  total_cost_usd       NUMERIC(10,4) NOT NULL DEFAULT 0,
  storage_used_bytes   BIGINT      NOT NULL DEFAULT 0,
  api_calls_count      INTEGER     NOT NULL DEFAULT 0,
  cost_by_provider     JSONB       NOT NULL DEFAULT '{}',

  CONSTRAINT usage_records_tenant_date_unique UNIQUE (tenant_id, date)
);

CREATE INDEX idx_usage_tenant_date ON usage_records(tenant_id, date DESC);

-- =============================================================================
-- ADMIN SETTINGS (глобальные настройки платформы)
-- =============================================================================

CREATE TABLE admin_settings (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT,
  is_public   BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_by  UUID        REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Дефолтные настройки
INSERT INTO admin_settings (key, value, description, is_public) VALUES
  ('platform.name',              '"AI Video Factory"',     'Название платформы',                   TRUE),
  ('platform.maintenance_mode',  'false',                  'Режим обслуживания — блокирует новые задачи', FALSE),
  ('limits.max_file_size_mb',    '500',                    'Максимальный размер загружаемого файла', FALSE),
  ('limits.max_scenes_free',     '3',                      'Лимит сцен для бесплатного тарифа',     FALSE),
  ('ai.openai_model',            '"gpt-4o"',               'Модель GPT для генерации сценариев',    FALSE),
  ('ai.heygen_avatar_default',   '"default"',              'Дефолтный аватар HeyGen',               FALSE),
  ('billing.credits_per_scene_avatar', '10',               'Стоимость генерации аватара в кредитах',FALSE),
  ('billing.credits_per_scene_clip',   '5',                'Стоимость генерации клипа в кредитах',  FALSE),
  ('billing.credits_per_image',        '2',                'Стоимость генерации изображения',       FALSE);

-- =============================================================================
-- ADMIN AUDIT LOG (журнал действий администратора)
-- =============================================================================

CREATE TABLE admin_audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  admin_id    UUID        NOT NULL REFERENCES users(id),
  action      TEXT        NOT NULL,   -- tenant.suspend | user.ban | plan.change | etc.
  target_type TEXT,                   -- tenant | user | job | billing_plan
  target_id   TEXT,
  before      JSONB,
  after       JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_audit_admin    ON admin_audit_logs(admin_id, created_at DESC);
CREATE INDEX idx_admin_audit_target   ON admin_audit_logs(target_type, target_id);

-- =============================================================================
-- NOTIFICATIONS
-- =============================================================================

CREATE TABLE notifications (
  id          UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID              REFERENCES users(id),
  type        notification_type NOT NULL,
  title       TEXT              NOT NULL,
  body        TEXT              NOT NULL,
  is_read     BOOLEAN           NOT NULL DEFAULT FALSE,
  action_url  TEXT,
  created_at  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX idx_notif_tenant_unread ON notifications(tenant_id, is_read, created_at DESC);
CREATE INDEX idx_notif_user_unread   ON notifications(user_id, is_read) WHERE user_id IS NOT NULL;

-- =============================================================================
-- ТРИГГЕРЫ: автоматическое обновление updated_at
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','projects','videos','jobs','scenes']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t
    );
  END LOOP;
END;
$$;

-- =============================================================================
-- СТРОЧНАЯ БЕЗОПАСНОСТЬ (Row Level Security) — дополнительный слой изоляции
-- =============================================================================
-- Включается только если используете Supabase или прямое подключение клиентов.
-- При работе через API-сервис (рекомендуется) RLS необязателен —
-- изоляция обеспечивается middleware-слоем.

-- ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY videos_tenant_isolation ON videos
--   USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- =============================================================================
-- ФУНКЦИЯ: списать кредиты атомарно (используется в транзакции)
-- =============================================================================

CREATE OR REPLACE FUNCTION deduct_credits(
  p_tenant_id     UUID,
  p_amount        INTEGER,
  p_description   TEXT,
  p_job_id        UUID DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  -- Блокируем строку тенанта
  SELECT credits INTO v_balance
  FROM tenants
  WHERE id = p_tenant_id
  FOR UPDATE;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Недостаточно кредитов: баланс %, требуется %', v_balance, p_amount;
  END IF;

  UPDATE tenants SET credits = credits - p_amount WHERE id = p_tenant_id;
  v_balance := v_balance - p_amount;

  INSERT INTO credit_transactions (tenant_id, type, amount, balance_after, description, job_id)
  VALUES (p_tenant_id, 'charge', -p_amount, v_balance, p_description, p_job_id);

  RETURN v_balance;
END;
$$;

COMMENT ON FUNCTION deduct_credits IS
  'Атомарное списание кредитов с защитой от гонки (SELECT FOR UPDATE). '
  'Вызывать внутри транзакции приложения.';

-- =============================================================================
-- ФУНКЦИЯ: агрегировать usage_records за день (вызывается воркером)
-- =============================================================================

CREATE OR REPLACE FUNCTION upsert_usage_record(
  p_tenant_id        UUID,
  p_date             DATE,
  p_videos_delta     INTEGER DEFAULT 0,
  p_scenes_delta     INTEGER DEFAULT 0,
  p_credits_delta    INTEGER DEFAULT 0,
  p_cost_usd_delta   NUMERIC DEFAULT 0,
  p_storage_delta    BIGINT  DEFAULT 0,
  p_api_calls_delta  INTEGER DEFAULT 0,
  p_provider         TEXT    DEFAULT NULL,
  p_provider_cost    NUMERIC DEFAULT 0
) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO usage_records (
    tenant_id, date,
    videos_created, scenes_generated, credits_used,
    total_cost_usd, storage_used_bytes, api_calls_count,
    cost_by_provider
  ) VALUES (
    p_tenant_id, p_date,
    p_videos_delta, p_scenes_delta, p_credits_delta,
    p_cost_usd_delta, p_storage_delta, p_api_calls_delta,
    CASE WHEN p_provider IS NOT NULL
         THEN jsonb_build_object(p_provider, p_provider_cost)
         ELSE '{}'::jsonb END
  )
  ON CONFLICT (tenant_id, date) DO UPDATE SET
    videos_created    = usage_records.videos_created    + EXCLUDED.videos_created,
    scenes_generated  = usage_records.scenes_generated  + EXCLUDED.scenes_generated,
    credits_used      = usage_records.credits_used      + EXCLUDED.credits_used,
    total_cost_usd    = usage_records.total_cost_usd    + EXCLUDED.total_cost_usd,
    storage_used_bytes= usage_records.storage_used_bytes+ EXCLUDED.storage_used_bytes,
    api_calls_count   = usage_records.api_calls_count   + EXCLUDED.api_calls_count,
    cost_by_provider  = usage_records.cost_by_provider  ||
                        EXCLUDED.cost_by_provider;
END;
$$;

COMMIT;
