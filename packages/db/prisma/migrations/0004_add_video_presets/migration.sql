-- CreateEnum
CREATE TYPE "preset_status" AS ENUM ('draft', 'preview', 'active', 'paused');

-- CreateTable
CREATE TABLE "video_presets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "status" "preset_status" NOT NULL DEFAULT 'draft',
    "heygen_avatar_id" TEXT NOT NULL DEFAULT 'Anna_public_20240108',
    "heygen_voice_id" TEXT NOT NULL DEFAULT '70856236390f4d0392d00187143d3900',
    "edit_style" TEXT NOT NULL DEFAULT 'dynamic',
    "target_duration_sec" INTEGER NOT NULL DEFAULT 30,
    "custom_prompt" TEXT,
    "language" TEXT NOT NULL DEFAULT 'ru',
    "bgm_enabled" BOOLEAN NOT NULL DEFAULT true,
    "cron_expression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "auto_publish" BOOLEAN NOT NULL DEFAULT false,
    "publish_platforms" "social_platform"[] DEFAULT ARRAY[]::"social_platform"[],
    "social_account_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "preview_video_id" UUID,
    "used_idea_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_runs" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ,
    "next_run_at" TIMESTAMPTZ,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "video_presets_pkey" PRIMARY KEY ("id")
);

-- AlterTable: videos
ALTER TABLE "videos" ADD COLUMN "preset_id" UUID;
ALTER TABLE "videos" ADD COLUMN "idea_text" TEXT;
ALTER TABLE "videos" ADD COLUMN "idea_fingerprint" TEXT;

-- AlterTable: scenes
ALTER TABLE "scenes" ADD COLUMN "frame_url" TEXT;

-- CreateIndex
CREATE INDEX "video_presets_tenant_id_status_idx" ON "video_presets"("tenant_id", "status");
CREATE INDEX "video_presets_tenant_id_is_archived_idx" ON "video_presets"("tenant_id", "is_archived");
CREATE INDEX "video_presets_next_run_at_idx" ON "video_presets"("next_run_at");
CREATE UNIQUE INDEX "video_presets_preview_video_id_key" ON "video_presets"("preview_video_id");
CREATE INDEX "videos_preset_id_idx" ON "videos"("preset_id");

-- AddForeignKey
ALTER TABLE "video_presets" ADD CONSTRAINT "video_presets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "video_presets" ADD CONSTRAINT "video_presets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "video_presets" ADD CONSTRAINT "video_presets_preview_video_id_fkey" FOREIGN KEY ("preview_video_id") REFERENCES "videos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "videos" ADD CONSTRAINT "videos_preset_id_fkey" FOREIGN KEY ("preset_id") REFERENCES "video_presets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
