-- =============================================================================
-- Создание таблицы products (товары для генерации видео)
-- Должна быть применена ДО 0003 (video_schedules ссылается на products.id)
-- =============================================================================

CREATE TABLE IF NOT EXISTS products (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id       UUID        REFERENCES projects(id),
  created_by       UUID        REFERENCES users(id),
  name             TEXT        NOT NULL,
  description      TEXT,
  features         TEXT[]      NOT NULL DEFAULT '{}',
  target_audience  TEXT,
  brand_voice      TEXT,
  category         TEXT,
  price            TEXT,
  website_url      TEXT,
  images           TEXT[]      NOT NULL DEFAULT '{}',
  metadata         JSONB       NOT NULL DEFAULT '{}',
  is_archived      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_tenant_id       ON products(tenant_id);
CREATE INDEX IF NOT EXISTS products_tenant_archived ON products(tenant_id, is_archived);
