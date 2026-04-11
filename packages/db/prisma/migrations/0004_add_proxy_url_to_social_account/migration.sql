-- AlterTable: add per-account proxy URL to social_accounts
ALTER TABLE "social_accounts" ADD COLUMN "proxy_url" TEXT;
