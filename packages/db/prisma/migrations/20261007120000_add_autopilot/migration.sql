-- CreateEnum
CREATE TYPE "autopilot_status" AS ENUM ('draft', 'active', 'paused', 'error');

-- CreateEnum
CREATE TYPE "autopilot_batch_status" AS ENUM ('pending', 'scripting', 'analyzing', 'rendering', 'uniquifying', 'ready', 'failed');

-- AlterTable
ALTER TABLE "source_videos" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'upload';

-- AlterTable
ALTER TABLE "distribute_jobs" ADD COLUMN     "autopilot_id" UUID;

-- CreateTable
CREATE TABLE "autopilots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "autopilot_status" NOT NULL DEFAULT 'draft',
    "montage_mode" TEXT NOT NULL DEFAULT 'multi',
    "sources_per_montage" INTEGER NOT NULL DEFAULT 3,
    "source_strategy" TEXT NOT NULL DEFAULT 'fresh_first',
    "target_seconds" INTEGER NOT NULL DEFAULT 30,
    "aspect" TEXT NOT NULL DEFAULT '9:16',
    "subtitle_style" TEXT NOT NULL DEFAULT 'tiktok',
    "smart_crop" BOOLEAN NOT NULL DEFAULT true,
    "bgm_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "product_info" TEXT,
    "script_styles" TEXT[] DEFAULT ARRAY['blogger']::TEXT[],
    "cta_type" TEXT NOT NULL DEFAULT 'article',
    "direct_word" TEXT,
    "voice_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "voice_speed" DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    "uniquify_mode" TEXT NOT NULL DEFAULT 'preserve_context',
    "stealth_level" TEXT NOT NULL DEFAULT 'maximum',
    "variants_per_montage" INTEGER,
    "account_group_id" UUID,
    "social_account_ids" UUID[],
    "platforms" "social_platform"[],
    "publish_times" TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "jitter_minutes" INTEGER NOT NULL DEFAULT 20,
    "stagger_minutes" INTEGER NOT NULL DEFAULT 7,
    "min_health" INTEGER NOT NULL DEFAULT 30,
    "caption_template" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "buffer_windows" INTEGER NOT NULL DEFAULT 2,
    "max_parallel_batches" INTEGER NOT NULL DEFAULT 2,
    "next_window_at" TIMESTAMP(3),
    "last_window_at" TIMESTAMP(3),
    "last_tick_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "force_produce" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "montages_produced" INTEGER NOT NULL DEFAULT 0,
    "variants_produced" INTEGER NOT NULL DEFAULT 0,
    "posts_scheduled" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "autopilots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autopilot_batches" (
    "id" UUID NOT NULL,
    "autopilot_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "autopilot_batch_status" NOT NULL DEFAULT 'pending',
    "source_video_ids" UUID[],
    "script" TEXT,
    "script_style" TEXT,
    "caption" TEXT,
    "voice_id" TEXT,
    "voiceover_key" TEXT,
    "voice_duration" DECIMAL(8,2),
    "variant_count" INTEGER NOT NULL DEFAULT 0,
    "edit_project_id" UUID,
    "uniquify_job_id" UUID,
    "error" TEXT,
    "stage_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "autopilot_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autopilot_runs" (
    "id" UUID NOT NULL,
    "autopilot_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autopilot_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "autopilots_tenant_id_status_idx" ON "autopilots"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "autopilots_status_next_window_at_idx" ON "autopilots"("status", "next_window_at");

-- CreateIndex
CREATE INDEX "autopilot_batches_autopilot_id_status_idx" ON "autopilot_batches"("autopilot_id", "status");

-- CreateIndex
CREATE INDEX "autopilot_batches_status_idx" ON "autopilot_batches"("status");

-- CreateIndex
CREATE INDEX "autopilot_runs_autopilot_id_created_at_idx" ON "autopilot_runs"("autopilot_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "distribute_jobs_autopilot_id_idx" ON "distribute_jobs"("autopilot_id");

-- AddForeignKey
ALTER TABLE "autopilots" ADD CONSTRAINT "autopilots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopilots" ADD CONSTRAINT "autopilots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopilot_batches" ADD CONSTRAINT "autopilot_batches_autopilot_id_fkey" FOREIGN KEY ("autopilot_id") REFERENCES "autopilots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopilot_runs" ADD CONSTRAINT "autopilot_runs_autopilot_id_fkey" FOREIGN KEY ("autopilot_id") REFERENCES "autopilots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing smart-editor masters are not user footage, keep them out of
-- the autopilot source pool.
UPDATE "source_videos" SET "origin" = 'editor'
WHERE "id" IN (SELECT "output_source_video_id" FROM "edit_clips" WHERE "output_source_video_id" IS NOT NULL);
