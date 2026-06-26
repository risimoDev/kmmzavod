-- Private (non-official-API) publishing support.
-- authMethod selects the publishing path; sessionData stores the encrypted
-- credentials + live session blob used by the private publisher microservice.

ALTER TABLE "social_accounts" ADD COLUMN IF NOT EXISTS "auth_method" TEXT NOT NULL DEFAULT 'official';
ALTER TABLE "social_accounts" ADD COLUMN IF NOT EXISTS "session_data" TEXT;
