-- Add pHash to UniqueVariant and shadow-ban fields to SocialAccount

ALTER TABLE "unique_variants"
  ADD COLUMN IF NOT EXISTS "phash" TEXT;

CREATE INDEX IF NOT EXISTS "unique_variants_phash_idx" ON "unique_variants"("phash");

ALTER TABLE "social_accounts"
  ADD COLUMN IF NOT EXISTS "shadow_ban_detected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "shadow_ban_checked_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "last_error" TEXT;
