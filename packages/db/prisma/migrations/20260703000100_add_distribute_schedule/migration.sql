-- CreateTable: distribute_schedules (cron auto-publish of uniquified variants)
CREATE TABLE "distribute_schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Auto-distribute',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "cron_expression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "uniquify_job_id" UUID,
    "social_account_ids" UUID[],
    "account_group_id" UUID,
    "variants_per_account" INTEGER NOT NULL DEFAULT 1,
    "stagger_minutes" INTEGER NOT NULL DEFAULT 15,
    "caption_template" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "total_runs" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribute_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "distribute_schedules_tenant_id_is_active_idx" ON "distribute_schedules"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "distribute_schedules_next_run_at_idx" ON "distribute_schedules"("next_run_at");

-- AddForeignKey
ALTER TABLE "distribute_schedules" ADD CONSTRAINT "distribute_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
