-- Add runway_task_id column to scenes table (was in schema but never migrated)
ALTER TABLE "scenes" ADD COLUMN IF NOT EXISTS "runway_task_id" TEXT;

-- Add index for fast lookups by runway task
CREATE INDEX IF NOT EXISTS "scenes_runway_task_id_idx" ON "scenes" ("runway_task_id") WHERE "runway_task_id" IS NOT NULL;
