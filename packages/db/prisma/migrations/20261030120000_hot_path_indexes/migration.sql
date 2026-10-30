-- Hot-path indexes for the autopilot/campaign ticks (anti-joins on variants, per-account
-- in-flight and daily-quota lookups) and the editor analysis cache.
-- publish_jobs_unique_variant_id_idx and unique_variants_phash_idx already exist (created by
-- hand-written migrations); they are now declared in schema.prisma so `migrate dev` keeps them.
CREATE INDEX IF NOT EXISTS "distribute_items_unique_variant_id_idx" ON "distribute_items"("unique_variant_id");
CREATE INDEX IF NOT EXISTS "distribute_items_social_account_id_status_idx" ON "distribute_items"("social_account_id", "status");
CREATE INDEX IF NOT EXISTS "publish_jobs_unique_variant_id_idx" ON "publish_jobs"("unique_variant_id");
CREATE INDEX IF NOT EXISTS "publish_jobs_social_account_id_status_published_at_idx" ON "publish_jobs"("social_account_id", "status", "published_at");
CREATE INDEX IF NOT EXISTS "unique_variants_phash_idx" ON "unique_variants"("phash");
CREATE INDEX IF NOT EXISTS "edit_sources_storage_key_idx" ON "edit_sources"("storage_key");
