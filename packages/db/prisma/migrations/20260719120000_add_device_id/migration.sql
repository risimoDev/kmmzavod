-- Real phone-farm publishing (authMethod='device'): map a SocialAccount to a
-- Laixi device id.
ALTER TABLE "social_accounts" ADD COLUMN "device_id" TEXT;
