import { z } from 'zod';
import path from 'path';

// Load .env from project root (CWD is apps/orchestrator via pnpm)
try { process.loadEnvFile(path.resolve(process.cwd(), '../../.env')); } catch {}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z.string().default('false').transform(v => v === 'true' || v === '1'),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_BUCKET: z.string().default('kmmzavod'),
  GPTUNNEL_API_KEY: z.string(),
  GPTUNNEL_BASE_URL: z.string().url().default('https://gptunnel.ru/v1'),
  HEYGEN_API_KEY: z.string(),
  RUNWAY_API_KEY: z.string(),
  IMAGE_GEN_PROVIDER: z.enum(['runway', 'fal', 'replicate', 'comfyui']).default('runway'),
  IMAGE_GEN_API_KEY: z.string(),
  VIDEO_PROCESSOR_URL: z.string().url().default('http://localhost:8000'),
  KLING_ACCESS_KEY: z.string().default(''),
  KLING_SECRET_KEY: z.string().default(''),

  // Social publishing (optional — если не заданы, publishing для платформы отключён)
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Некорректные переменные окружения (orchestrator):');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
