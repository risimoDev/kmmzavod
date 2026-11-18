CREATE TABLE "queue_intents" (
  "id" UUID NOT NULL,
  "queue" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "queue_intents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "queue_intents_created_at_idx" ON "queue_intents"("created_at");
