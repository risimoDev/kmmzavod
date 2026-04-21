-- Add product_id column to videos table
ALTER TABLE "videos" ADD COLUMN "product_id" UUID;

-- Add foreign key constraint
ALTER TABLE "videos" ADD CONSTRAINT "videos_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add index
CREATE INDEX "videos_product_id_idx" ON "videos"("product_id");
