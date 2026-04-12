-- Add new enum values to generation_provider
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum WHERE enumlabel = 'gptunnel'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'generation_provider')
  ) THEN
    ALTER TYPE generation_provider ADD VALUE 'gptunnel';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum WHERE enumlabel = 'runway'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'generation_provider')
  ) THEN
    ALTER TYPE generation_provider ADD VALUE 'runway';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum WHERE enumlabel = 'gemini'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'generation_provider')
  ) THEN
    ALTER TYPE generation_provider ADD VALUE 'gemini';
  END IF;
END$$;

-- Create social_platform enum if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'social_platform') THEN
    CREATE TYPE social_platform AS ENUM ('tiktok', 'instagram', 'youtube_shorts', 'postbridge');
  ELSE
    -- Add new values to existing enum
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum WHERE enumlabel = 'youtube_shorts'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'social_platform')
    ) THEN
      ALTER TYPE social_platform ADD VALUE 'youtube_shorts';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_enum WHERE enumlabel = 'postbridge'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'social_platform')
    ) THEN
      ALTER TYPE social_platform ADD VALUE 'postbridge';
    END IF;
  END IF;
END$$;

-- Create publish_status enum if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'publish_status') THEN
    CREATE TYPE publish_status AS ENUM ('pending', 'scheduled', 'uploading', 'published', 'failed');
  END IF;
END$$;

-- Create social_accounts table if not exists
CREATE TABLE IF NOT EXISTS social_accounts (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform      social_platform NOT NULL,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  account_name  TEXT        NOT NULL,
  ig_user_id    TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS social_accounts_tenant_platform ON social_accounts(tenant_id, platform);
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_tenant_platform_name ON social_accounts(tenant_id, platform, account_name);

-- Create publish_jobs table if not exists
CREATE TABLE IF NOT EXISTS publish_jobs (
  id                UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  video_id          UUID           NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  social_account_id UUID           REFERENCES social_accounts(id) ON DELETE SET NULL,
  platform          social_platform NOT NULL,
  status            publish_status NOT NULL DEFAULT 'pending',
  external_post_id  TEXT,
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  error_message     TEXT,
  metadata          JSONB          NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS publish_jobs_tenant_status ON publish_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS publish_jobs_video ON publish_jobs(video_id);
CREATE INDEX IF NOT EXISTS publish_jobs_scheduled ON publish_jobs(scheduled_at);

-- Create video_schedules table (new for CRON scheduler)
CREATE TABLE IF NOT EXISTS video_schedules (
  id                 UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id         UUID           NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name               TEXT           NOT NULL DEFAULT 'Auto-schedule',
  cron_expression    TEXT           NOT NULL,
  timezone           TEXT           NOT NULL DEFAULT 'Europe/Moscow',
  is_active          BOOLEAN        NOT NULL DEFAULT TRUE,
  auto_publish       BOOLEAN        NOT NULL DEFAULT FALSE,
  publish_platforms  social_platform[] DEFAULT '{}',
  social_account_ids UUID[]         DEFAULT '{}',
  avatar_id          TEXT,
  voice_id           TEXT,
  duration_sec       INTEGER        NOT NULL DEFAULT 30,
  language           TEXT           NOT NULL DEFAULT 'ru',
  bgm_enabled        BOOLEAN        NOT NULL DEFAULT TRUE,
  last_run_at        TIMESTAMPTZ,
  next_run_at        TIMESTAMPTZ,
  total_runs         INTEGER        NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS video_schedules_tenant_active ON video_schedules(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS video_schedules_next_run ON video_schedules(next_run_at);
