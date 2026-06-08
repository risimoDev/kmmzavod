-- Create missing uniquify tables and update publish_jobs to support uniqueVariantId.
-- Replaces the failed 20260608100000_fix_source_video_fps_decimal migration.

BEGIN;

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE source_video_status AS ENUM ('uploading', 'analyzing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE uniquify_job_status AS ENUM ('pending', 'analyzing', 'generating', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE unique_variant_status AS ENUM ('pending', 'rendering', 'tts', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE distribute_job_status AS ENUM ('pending', 'distributing', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE distribute_item_status AS ENUM ('pending', 'scheduled', 'publishing', 'published', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- SOURCE VIDEOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS source_videos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES projects(id),
  uploaded_by   UUID,
  title         TEXT NOT NULL,
  description   TEXT,
  status        source_video_status NOT NULL DEFAULT 'uploading',
  storage_key   TEXT NOT NULL,
  mime_type     TEXT,
  file_size_bytes BIGINT,
  duration_sec  DECIMAL(8,2),
  width         INT,
  height        INT,
  fps           DECIMAL(5,2),
  transcript    JSONB,
  scene_breaks  JSONB,
  audio_profile JSONB,
  error         TEXT,
  is_archived   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_videos_tenant_id_status_idx ON source_videos(tenant_id, status);
CREATE INDEX IF NOT EXISTS source_videos_tenant_id_is_archived_idx ON source_videos(tenant_id, is_archived);
CREATE INDEX IF NOT EXISTS source_videos_project_id_idx ON source_videos(project_id);

-- =============================================================================
-- UNIQUIFY JOBS
-- =============================================================================

CREATE TABLE IF NOT EXISTS uniquify_jobs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_video_id  UUID NOT NULL REFERENCES source_videos(id),
  created_by       UUID,
  status           uniquify_job_status NOT NULL DEFAULT 'pending',
  variant_count    INT NOT NULL DEFAULT 10,
  target_platforms social_platform[] NOT NULL DEFAULT '{}',
  config           JSONB NOT NULL DEFAULT '{}',
  completed_count  INT NOT NULL DEFAULT 0,
  failed_count     INT NOT NULL DEFAULT 0,
  credits_used     INT NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS uniquify_jobs_tenant_id_status_idx ON uniquify_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS uniquify_jobs_source_video_id_idx ON uniquify_jobs(source_video_id);
CREATE INDEX IF NOT EXISTS uniquify_jobs_created_at_idx ON uniquify_jobs(created_at DESC);

-- =============================================================================
-- UNIQUE VARIANTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS unique_variants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  uniquify_job_id UUID NOT NULL REFERENCES uniquify_jobs(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_index   SMALLINT NOT NULL,
  status          unique_variant_status NOT NULL DEFAULT 'pending',
  transforms      JSONB NOT NULL DEFAULT '{}',
  output_key      TEXT,
  output_url      TEXT,
  thumbnail_key   TEXT,
  duration_sec    DECIMAL(8,2),
  file_size_bytes BIGINT,
  width           INT,
  height          INT,
  subtitle_style  TEXT,
  tts_voice_id    TEXT,
  bgm_track_key   TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_variants_uniquify_job_id_variant_index_key ON unique_variants(uniquify_job_id, variant_index);
CREATE INDEX IF NOT EXISTS unique_variants_uniquify_job_id_status_idx ON unique_variants(uniquify_job_id, status);
CREATE INDEX IF NOT EXISTS unique_variants_tenant_id_status_idx ON unique_variants(tenant_id, status);

-- =============================================================================
-- DISTRIBUTE JOBS
-- =============================================================================

CREATE TABLE IF NOT EXISTS distribute_jobs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  uniquify_job_id  UUID NOT NULL REFERENCES uniquify_jobs(id),
  created_by       UUID,
  status           distribute_job_status NOT NULL DEFAULT 'pending',
  stagger_minutes  INT NOT NULL DEFAULT 15,
  caption_template TEXT,
  hashtags         TEXT[] NOT NULL DEFAULT '{}',
  total_items      INT NOT NULL DEFAULT 0,
  published_count  INT NOT NULL DEFAULT 0,
  failed_count     INT NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS distribute_jobs_tenant_id_status_idx ON distribute_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS distribute_jobs_uniquify_job_id_idx ON distribute_jobs(uniquify_job_id);

-- =============================================================================
-- DISTRIBUTE ITEMS
-- =============================================================================

CREATE TABLE IF NOT EXISTS distribute_items (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  distribute_job_id UUID NOT NULL REFERENCES distribute_jobs(id) ON DELETE CASCADE,
  unique_variant_id UUID NOT NULL REFERENCES unique_variants(id),
  social_account_id UUID NOT NULL REFERENCES social_accounts(id),
  publish_job_id    UUID REFERENCES publish_jobs(id),
  status            distribute_item_status NOT NULL DEFAULT 'pending',
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  caption           TEXT,
  hashtags          TEXT[] NOT NULL DEFAULT '{}',
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS distribute_items_distribute_job_id_unique_variant_id_social_account_id_key
  ON distribute_items(distribute_job_id, unique_variant_id, social_account_id);
CREATE INDEX IF NOT EXISTS distribute_items_distribute_job_id_status_idx ON distribute_items(distribute_job_id, status);
CREATE INDEX IF NOT EXISTS distribute_items_scheduled_at_idx ON distribute_items(scheduled_at);

-- =============================================================================
-- UPDATE PUBLISH JOBS (nullable videoId + uniqueVariantId FK)
-- =============================================================================

ALTER TABLE publish_jobs
  ALTER COLUMN video_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS unique_variant_id UUID REFERENCES unique_variants(id);

CREATE INDEX IF NOT EXISTS publish_jobs_unique_variant_id_idx ON publish_jobs(unique_variant_id);

-- =============================================================================
-- UPDATED_AT TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_source_videos_updated_at
    BEFORE UPDATE ON source_videos FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_uniquify_jobs_updated_at
    BEFORE UPDATE ON uniquify_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_unique_variants_updated_at
    BEFORE UPDATE ON unique_variants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_distribute_jobs_updated_at
    BEFORE UPDATE ON distribute_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_distribute_items_updated_at
    BEFORE UPDATE ON distribute_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
