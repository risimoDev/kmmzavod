-- Account Farm schema: AccountGroup, Proxy, SocialAccount additions

-- Create account_groups table
CREATE TABLE IF NOT EXISTS "account_groups" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "max_posts_per_day" INTEGER NOT NULL DEFAULT 3,
    "stagger_minutes" INTEGER NOT NULL DEFAULT 120,
    "bgm_pool" TEXT[] DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "account_groups_tenant_id_is_active_idx" ON "account_groups"("tenant_id", "is_active");

-- Create proxies table
CREATE TABLE IF NOT EXISTS "proxies" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "country" TEXT,
    "city" TEXT,
    "username" TEXT,
    "password" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "assigned_accounts" INTEGER NOT NULL DEFAULT 0,
    "max_accounts" INTEGER NOT NULL DEFAULT 3,
    "health_check_at" TIMESTAMPTZ,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "proxies_tenant_id_is_active_assigned_accounts_idx" ON "proxies"("tenant_id", "is_active", "assigned_accounts");

-- Add tenant FK on proxies
ALTER TABLE "proxies"
  ADD CONSTRAINT "proxies_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- Add farm fields to social_accounts
ALTER TABLE "social_accounts"
  ADD COLUMN IF NOT EXISTS "account_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "proxy_id" UUID,
  ADD COLUMN IF NOT EXISTS "device_fingerprint" JSONB,
  ADD COLUMN IF NOT EXISTS "warmup_status" TEXT NOT NULL DEFAULT 'cold',
  ADD COLUMN IF NOT EXISTS "health_score" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "daily_post_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_post_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "niche" TEXT,
  ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS "action_limits" JSONB;

-- Add foreign keys
ALTER TABLE "social_accounts"
  ADD CONSTRAINT "social_accounts_account_group_id_fkey"
    FOREIGN KEY ("account_group_id") REFERENCES "account_groups"("id") ON DELETE SET NULL;

ALTER TABLE "social_accounts"
  ADD CONSTRAINT "social_accounts_proxy_id_fkey"
    FOREIGN KEY ("proxy_id") REFERENCES "proxies"("id") ON DELETE SET NULL;

-- Add tenant FK on account_groups
ALTER TABLE "account_groups"
  ADD CONSTRAINT "account_groups_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- Add indexes on social_accounts new columns
CREATE INDEX IF NOT EXISTS "social_accounts_account_group_id_idx" ON "social_accounts"("account_group_id");
CREATE INDEX IF NOT EXISTS "social_accounts_proxy_id_idx" ON "social_accounts"("proxy_id");
CREATE INDEX IF NOT EXISTS "social_accounts_tenant_id_platform_idx" ON "social_accounts"("tenant_id", "platform");
