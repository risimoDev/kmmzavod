ALTER TABLE "publish_jobs" ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;

UPDATE "publish_jobs"
SET "needs_review" = true
WHERE "status" = 'failed'
  AND "error" ~* 'не подтвержд|появление в профиле ожидается|не удалось проверить профиль|проверьте профиль вручную';
