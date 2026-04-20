-- Add missing indexes on FK fields for query performance

-- Job.projectId — used in project-scoped job listings
CREATE INDEX IF NOT EXISTS "jobs_project_id_idx" ON "jobs" ("project_id");

-- Asset.projectId — used in project-scoped asset listings
CREATE INDEX IF NOT EXISTS "assets_project_id_idx" ON "assets" ("project_id");

-- Generation.jobId — used for per-job cost aggregation
CREATE INDEX IF NOT EXISTS "generations_job_id_idx" ON "generations" ("job_id");

-- CreditTransaction.jobId — used for per-job credit history
CREATE INDEX IF NOT EXISTS "credit_transactions_job_id_idx" ON "credit_transactions" ("job_id");
