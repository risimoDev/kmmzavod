-- Warmup tracking for private farm accounts (cold → warming → warm promoter)
ALTER TABLE "social_accounts"
    ADD COLUMN "warmup_started_at" TIMESTAMP(3),
    ADD COLUMN "last_warmup_at" TIMESTAMP(3),
    ADD COLUMN "warmup_count" INTEGER NOT NULL DEFAULT 0;
