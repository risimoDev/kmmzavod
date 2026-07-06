-- Warmup gate is opt-in per account group (default off so imported accounts post)
ALTER TABLE "account_groups"
    ADD COLUMN "enforce_warmup" BOOLEAN NOT NULL DEFAULT false;
