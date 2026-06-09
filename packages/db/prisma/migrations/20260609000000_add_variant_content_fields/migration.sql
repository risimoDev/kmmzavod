-- Add auto-generated content fields to unique_variants
ALTER TABLE "unique_variants"
  ADD COLUMN IF NOT EXISTS "tts_storage_key" TEXT,
  ADD COLUMN IF NOT EXISTS "generated_caption" TEXT,
  ADD COLUMN IF NOT EXISTS "generated_hashtags" TEXT[] DEFAULT '{}';
