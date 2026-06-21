-- Shared per-job creative assets for the montage-based uniquify pipeline.
-- The script, voiceover and subtitle transcript are generated ONCE per job and
-- reused by every variant (uniqueness lives in the montage + per-variant music),
-- so they belong on the job, not the variant.

ALTER TABLE "uniquify_jobs" ADD COLUMN IF NOT EXISTS "script" TEXT;
ALTER TABLE "uniquify_jobs" ADD COLUMN IF NOT EXISTS "voiceover_key" TEXT;
ALTER TABLE "uniquify_jobs" ADD COLUMN IF NOT EXISTS "voice_id" TEXT;
ALTER TABLE "uniquify_jobs" ADD COLUMN IF NOT EXISTS "language" TEXT DEFAULT 'ru';
ALTER TABLE "uniquify_jobs" ADD COLUMN IF NOT EXISTS "transcript" JSONB;
