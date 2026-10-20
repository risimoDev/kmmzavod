-- CreateTable
CREATE TABLE "tenant_voices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "voice_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_voices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_voices_tenant_id_voice_id_key" ON "tenant_voices"("tenant_id", "voice_id");

-- AddForeignKey
ALTER TABLE "tenant_voices" ADD CONSTRAINT "tenant_voices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
