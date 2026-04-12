-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('super_admin', 'user');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "platform_role" "platform_role" NOT NULL DEFAULT 'user';
