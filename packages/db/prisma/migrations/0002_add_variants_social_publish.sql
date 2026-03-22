-- =============================================================================
-- МИГРАЦИЯ 0002: VideoVariant, SocialAccount, PublishJob
-- Добавляет таблицы для вариантов монтажа, соц-аккаунтов и публикаций
-- PostgreSQL 15+
-- =============================================================================

BEGIN;

-- =============================================================================
-- ENUM ТИПЫ
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE variant_status AS ENUM ('rendering', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE social_platform AS ENUM ('tiktok', 'instagram', 'youtube_shorts');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE publish_status AS ENUM ('pending', 'scheduled', 'uploading', 'published', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Also add 'reserve' to credit_tx_type if it doesn't exist yet
DO $$ BEGIN
  ALTER TYPE credit_tx_type ADD VALUE IF NOT EXISTS 'reserve';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- VIDEO VARIANTS (варианты монтажа для выбора клиентом)
-- =============================================================================

CREATE TABLE IF NOT EXISTS video_variants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID         NOT NULL,
  video_id      UUID         NOT NULL,
  tenant_id     UUID         NOT NULL,
  preset        TEXT         NOT NULL,        -- dynamic | smooth | minimal
  output_key    TEXT         NOT NULL,
  output_url    TEXT,
  duration_sec  DECIMAL(6,2),
  file_size_mb  DECIMAL(8,2),
  status        variant_status NOT NULL DEFAULT 'rendering',
  error         TEXT,
  selected_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT fk_variant_video FOREIGN KEY (video_id)
    REFERENCES videos(id) ON DELETE CASCADE
);

-- Unique: only one variant per preset per video
CREATE UNIQUE INDEX IF NOT EXISTS video_variants_video_id_preset_key
  ON video_variants (video_id, preset);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS video_variants_job_id_idx
  ON video_variants (job_id);

CREATE INDEX IF NOT EXISTS video_variants_video_id_idx
  ON video_variants (video_id);

CREATE INDEX IF NOT EXISTS video_variants_tenant_id_status_idx
  ON video_variants (tenant_id, status);

-- =============================================================================
-- SOCIAL ACCOUNTS (подключённые соцсети для автопубликации)
-- =============================================================================

CREATE TABLE IF NOT EXISTS social_accounts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID           NOT NULL,
  platform      social_platform NOT NULL,
  access_token  TEXT           NOT NULL,      -- encrypted at app layer
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  account_name  TEXT           NOT NULL,
  is_active     BOOLEAN        NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT fk_social_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE
);

-- Unique: one account per platform per tenant
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_tenant_platform_name_key
  ON social_accounts (tenant_id, platform, account_name);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS social_accounts_tenant_id_idx
  ON social_accounts (tenant_id);

CREATE INDEX IF NOT EXISTS social_accounts_tenant_id_platform_idx
  ON social_accounts (tenant_id, platform);

-- =============================================================================
-- PUBLISH JOBS (задачи публикации видео в соцсети)
-- =============================================================================

CREATE TABLE IF NOT EXISTS publish_jobs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id          UUID           NOT NULL,
  tenant_id         UUID           NOT NULL,
  social_account_id UUID           NOT NULL,
  variant_id        UUID,
  platform          social_platform NOT NULL,
  status            publish_status  NOT NULL DEFAULT 'pending',
  caption           TEXT,
  hashtags          TEXT[]         NOT NULL DEFAULT '{}',
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  external_post_id  TEXT,
  error             TEXT,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT fk_publish_video FOREIGN KEY (video_id)
    REFERENCES videos(id) ON DELETE CASCADE,
  CONSTRAINT fk_publish_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_publish_social FOREIGN KEY (social_account_id)
    REFERENCES social_accounts(id)
);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS publish_jobs_video_id_idx
  ON publish_jobs (video_id);

CREATE INDEX IF NOT EXISTS publish_jobs_tenant_id_status_idx
  ON publish_jobs (tenant_id, status);

-- Partial index: only scheduled jobs
CREATE INDEX IF NOT EXISTS publish_jobs_scheduled_at_idx
  ON publish_jobs (scheduled_at)
  WHERE scheduled_at IS NOT NULL;

-- =============================================================================
-- UPDATED_AT TRIGGERS (auto-set updated_at on row modification)
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_video_variants_updated_at
    BEFORE UPDATE ON video_variants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_social_accounts_updated_at
    BEFORE UPDATE ON social_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_publish_jobs_updated_at
    BEFORE UPDATE ON publish_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
