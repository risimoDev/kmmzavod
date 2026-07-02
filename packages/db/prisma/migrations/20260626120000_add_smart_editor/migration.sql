-- CreateEnum
CREATE TYPE "edit_mode" AS ENUM ('uniquify_source', 'smart_montage');

-- CreateEnum
CREATE TYPE "edit_geometry" AS ENUM ('highlights', 'mix');

-- CreateEnum
CREATE TYPE "edit_audio_mode" AS ENUM ('keep', 'replace');

-- CreateEnum
CREATE TYPE "edit_project_status" AS ENUM ('draft', 'analyzing', 'ready', 'rendering', 'completed', 'failed');

-- CreateTable
CREATE TABLE "edit_projects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "mode" "edit_mode" NOT NULL DEFAULT 'smart_montage',
    "geometry" "edit_geometry" NOT NULL DEFAULT 'highlights',
    "status" "edit_project_status" NOT NULL DEFAULT 'draft',
    "aspect" TEXT NOT NULL DEFAULT '9:16',
    "fps" INTEGER NOT NULL DEFAULT 30,
    "smart_crop" BOOLEAN NOT NULL DEFAULT true,
    "audio_mode" "edit_audio_mode" NOT NULL DEFAULT 'keep',
    "subtitle_style" TEXT NOT NULL DEFAULT 'tiktok',
    "use_vision" BOOLEAN NOT NULL DEFAULT false,
    "target_clip_count" INTEGER NOT NULL DEFAULT 5,
    "target_clip_seconds" DECIMAL(6,2) NOT NULL DEFAULT 30,
    "config" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edit_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edit_sources" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "duration_sec" DECIMAL(8,2),
    "width" INTEGER,
    "height" INTEGER,
    "fps" DECIMAL(5,2),
    "analysis" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edit_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edit_clips" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "edl" JSONB NOT NULL DEFAULT '{}',
    "transcript_snippet" TEXT,
    "thumbnail_key" TEXT,
    "output_key" TEXT,
    "output_source_video_id" UUID,
    "duration_sec" DECIMAL(8,2),
    "phash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edit_clips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "edit_projects_tenant_id_status_idx" ON "edit_projects"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "edit_sources_project_id_idx" ON "edit_sources"("project_id");

-- CreateIndex
CREATE INDEX "edit_clips_project_id_included_idx" ON "edit_clips"("project_id", "included");

-- AddForeignKey
ALTER TABLE "edit_projects" ADD CONSTRAINT "edit_projects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edit_sources" ADD CONSTRAINT "edit_sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "edit_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edit_clips" ADD CONSTRAINT "edit_clips_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "edit_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
