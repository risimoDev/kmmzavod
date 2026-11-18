ALTER TABLE "credit_transactions" ADD COLUMN "operation_key" TEXT;
CREATE UNIQUE INDEX "credit_transactions_operation_key_key" ON "credit_transactions"("operation_key");
