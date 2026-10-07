-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN     "followers" INTEGER,
ADD COLUMN     "stats_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "publish_jobs" ADD COLUMN     "comments" INTEGER,
ADD COLUMN     "likes" INTEGER,
ADD COLUMN     "metrics_at" TIMESTAMP(3),
ADD COLUMN     "perf_score" DOUBLE PRECISION,
ADD COLUMN     "verified_at" TIMESTAMP(3),
ADD COLUMN     "views" INTEGER;

-- AlterTable
ALTER TABLE "autopilots" ADD COLUMN     "exploration" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
ADD COLUMN     "learning" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "post_metrics" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "publish_job_id" UUID,
    "social_account_id" UUID NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "source" TEXT NOT NULL,
    "position" INTEGER,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "post_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_metrics_publish_job_id_collected_at_idx" ON "post_metrics"("publish_job_id", "collected_at");

-- CreateIndex
CREATE INDEX "post_metrics_social_account_id_collected_at_idx" ON "post_metrics"("social_account_id", "collected_at");

-- AddForeignKey
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_publish_job_id_fkey" FOREIGN KEY ("publish_job_id") REFERENCES "publish_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

