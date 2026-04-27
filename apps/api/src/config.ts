import { z } from 'zod';
import path from 'path';

// Load .env from project root when running in dev (tsx watch)
// CWD is apps/api when running via pnpm, so ../../.env = project root
try { process.loadEnvFile(path.resolve(process.cwd(), '../../.env')); } catch {}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z.string().default('false').transform(v => v === 'true' || v === '1'),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_BUCKET: z.string().default('kmmzavod'),
  MINIO_PUBLIC_URL: z.string().optional(),

  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),

  // Encryption key for social tokens at rest (32 hex bytes = 64 chars)
  ENCRYPTION_KEY: z.preprocess(v => (v === '' ? undefined : v), z.string().length(64).regex(/^[0-9a-fA-F]+$/).optional()),

  VIDEO_PROCESSOR_URL: z.string().url().default('http://localhost:8000'),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),

  // Social OAuth (optional)
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),

  // Allowed CORS origin(s) in production (comma-separated, e.g. https://k-m-m.online)
  CORS_ORIGIN: z.preprocess(v => (v === '' ? undefined : v), z.string().optional()),

  // AI API keys (optional — used for admin health checks)
  HEYGEN_API_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),
  GPTUNNEL_API_KEY: z.string().optional(),
  GPTUNNEL_BASE_URL: z.string().url().default('https://gptunnel.ru/v1'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Некорректные переменные окружения:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production' && !parsed.data.ENCRYPTION_KEY) {
  console.error('❌ ENCRYPTION_KEY is required in production (32 hex bytes = 64 chars)');
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
