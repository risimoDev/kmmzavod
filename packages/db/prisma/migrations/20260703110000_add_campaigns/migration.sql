-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "campaign_content_source" AS ENUM ('uniquify', 'generate', 'montage', 'manual');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "campaign_status" NOT NULL DEFAULT 'draft',
    "product_id" UUID,
    "content_source" "campaign_content_source" NOT NULL DEFAULT 'uniquify',
    "source_config" JSONB NOT NULL DEFAULT '{}',
    "buffer_days" INTEGER NOT NULL DEFAULT 2,
    "max_build_ahead" INTEGER NOT NULL DEFAULT 50,
    "account_group_id" UUID,
    "social_account_ids" UUID[],
    "platforms" "social_platform"[],
    "posts_per_account_per_day" INTEGER NOT NULL DEFAULT 1,
    "cron_expression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "stagger_minutes" INTEGER NOT NULL DEFAULT 15,
    "caption_template" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_health" INTEGER NOT NULL DEFAULT 30,
    "dedup_per_account" BOOLEAN NOT NULL DEFAULT true,
    "respect_warmup" BOOLEAN NOT NULL DEFAULT false,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "variants_ready" INTEGER NOT NULL DEFAULT 0,
    "variants_published" INTEGER NOT NULL DEFAULT 0,
    "posts_published" INTEGER NOT NULL DEFAULT 0,
    "posts_failed" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_runs" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "campaign_runs_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "distribute_jobs" ADD COLUMN "campaign_id" UUID;

-- CreateIndex
CREATE INDEX "campaigns_tenant_id_status_idx" ON "campaigns"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_next_run_at_idx" ON "campaigns"("next_run_at");

-- CreateIndex
CREATE INDEX "campaign_runs_campaign_id_started_at_idx" ON "campaign_runs"("campaign_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "distribute_jobs_campaign_id_idx" ON "distribute_jobs"("campaign_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_runs" ADD CONSTRAINT "campaign_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
