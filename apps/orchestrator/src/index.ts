/**
 * Главная точка входа оркестратора.
 * Запускает все BullMQ workers и обслуживает pipeline AI-задач.
 *
 * Порядок завершения: SIGTERM → graceful close workers → закрыть Redis/DB
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import OpenAI from 'openai';

import { config } from './config';
import { logger } from './logger';
import { getRedisConnection } from './lib/redis';
import { db } from './lib/db';

import { HeyGenClient, RunwayClient, ImageGenClient, type ImageGenProvider } from './clients';
import { MinioStorageClient } from '@kmmzavod/storage';
import { QUEUES } from '@kmmzavod/queue';
import type {
  GptScriptJobPayload,
  HeygenRenderJobPayload,
  RunwayClipJobPayload,
  ImageGenJobPayload,
  VideoComposeJobPayload,
  PipelineStateJobPayload,
  PipelineJobPayload,
  PublishJobPayload,
} from '@kmmzavod/queue';

import { createGptScriptWorker } from './workers/gpt-script.worker';
import { createHeygenRenderWorker } from './workers/heygen-render.worker';
import { createRunwayClipWorker } from './workers/runway-clip.worker';
import { createImageGenWorker } from './workers/image-gen.worker';
import { createVideoComposeWorker } from './workers/video-compose.worker';
import { createPipelineStateWorker } from './workers/pipeline-state.worker';
import { createPublishWorker } from './workers/publish.worker';
import { startPipeline } from './pipeline/coordinator';

async function main() {
  logger.info('Orchestrator запускается...');

  // ── Внешние зависимости ───────────────────────────────────────────────────
  const connection = getRedisConnection();

  const openai = new OpenAI({
    apiKey: config.GPTUNNEL_API_KEY,
    baseURL: config.GPTUNNEL_BASE_URL,
  });
  const heygen = new HeyGenClient(config.HEYGEN_API_KEY);
  const runway = new RunwayClient(config.RUNWAY_API_KEY);
  const imageGen = new ImageGenClient(
    config.IMAGE_GEN_PROVIDER as ImageGenProvider,
    config.IMAGE_GEN_API_KEY
  );

  const storage = new MinioStorageClient({
    endPoint: config.MINIO_ENDPOINT,
    port: config.MINIO_PORT,
    useSSL: config.MINIO_USE_SSL,
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
    bucket: config.MINIO_BUCKET,
  });

  // ── Очереди для fan-out ───────────────────────────────────────────────────
  const gptScriptQueue = new Queue<GptScriptJobPayload>(QUEUES['gpt-script'].name, { connection });
  const heygenQueue = new Queue<HeygenRenderJobPayload>(QUEUES['heygen-render'].name, { connection });
  const runwayQueue = new Queue<RunwayClipJobPayload>(QUEUES['runway-clip'].name, { connection });
  const imageGenQueue = new Queue<ImageGenJobPayload>(QUEUES['image-gen'].name, { connection });
  const videoComposeQueue = new Queue<VideoComposeJobPayload>(QUEUES['video-compose'].name, { connection });
  const pipelineStateQueue = new Queue<PipelineStateJobPayload>(QUEUES['pipeline-state'].name, { connection });
  const publishQueue = new Queue<PublishJobPayload>(QUEUES['publish'].name, { connection });
  const pipelineQueue = new Queue<PipelineJobPayload>(QUEUES['pipeline'].name, { connection });

  // ── Workers ───────────────────────────────────────────────────────────────
  const gptWorker = createGptScriptWorker({
    db,
    openai,
    heygenQueue,
    runwayQueue,
    imageGenQueue,
    connection,
  });

  const heygenWorker = createHeygenRenderWorker({
    db,
    heygen,
    storage,
    pipelineStateQueue,
    connection,
  });

  const runwayWorker = createRunwayClipWorker({
    db,
    runway,
    storage,
    pipelineStateQueue,
    connection,
  });

  const imageGenWorker = createImageGenWorker({
    db,
    imageGen,
    storage,
    pipelineStateQueue,
    connection,
    provider: config.IMAGE_GEN_PROVIDER,
  });

  const videoComposeWorker = createVideoComposeWorker({
    db,
    videoProcessorUrl: config.VIDEO_PROCESSOR_URL,
    connection,
  });

  const pipelineStateWorker = createPipelineStateWorker({
    db,
    videoComposeQueue,
    connection,
  });

  const publishWorker = createPublishWorker({
    db,
    storage,
    connection,
    tiktokClientKey: config.TIKTOK_CLIENT_KEY,
    tiktokClientSecret: config.TIKTOK_CLIENT_SECRET,
  });

  // Pipeline-worker — точка входа пайплайна (enqueue из API)
  const { Worker } = await import('bullmq');
  const pipelineWorker = new Worker<PipelineJobPayload>(
    QUEUES['pipeline'].name,
    async (job) => {
      const { jobId, tenantId } = job.data;
      logger.info({ jobId, tenantId }, 'Pipeline: старт задачи');
      await startPipeline(jobId, tenantId, { db, gptQueue: gptScriptQueue, storage });
    },
    { connection, concurrency: QUEUES['pipeline'].concurrency }
  );

  // ── Failed event handlers — permanent failure after all retries exhausted ─
  const handleSceneFailure = async (
    bullJob: { data: { jobId: string; sceneId: string; tenantId: string } } | undefined,
    err:     Error,
    stage:   string,
  ) => {
    if (!bullJob) return;
    const { jobId, sceneId, tenantId } = bullJob.data;
    try {
      const jobRow = await db.job.findUnique({ where: { id: jobId }, select: { videoId: true } });
      await db.$transaction([
        db.scene.update({ where: { id: sceneId }, data: { status: 'failed', error: err.message } }),
        db.job.update({ where: { id: jobId }, data: { status: 'failed' } }),
        ...(jobRow?.videoId ? [
          db.video.update({ where: { id: jobRow.videoId }, data: { status: 'failed' } }),
        ] : []),
      ]);
      await db.jobEvent.create({
        data: { jobId, tenantId, stage, status: 'failed', message: err.message },
      });
    } catch (dbErr) {
      logger.error({ dbErr, jobId, sceneId }, 'handleSceneFailure: DB error');
    }
  };

  heygenWorker.on('failed',   (j, err) => handleSceneFailure(j, err, 'heygen-render'));
  runwayWorker.on('failed',   (j, err) => handleSceneFailure(j, err, 'runway-clip'));
  imageGenWorker.on('failed', (j, err) => handleSceneFailure(j, err, 'image-gen'));

  const allWorkers = [
    pipelineWorker,
    gptWorker,
    heygenWorker,
    runwayWorker,
    imageGenWorker,
    videoComposeWorker,
    pipelineStateWorker,
    publishWorker,
  ];

  // Логируем активные воркеры
  logger.info(
    {
      workers: allWorkers.map((w) => w.name),
      concurrencies: {
        pipeline: QUEUES['pipeline'].concurrency,
        'gpt-script': QUEUES['gpt-script'].concurrency,
        'heygen-render': QUEUES['heygen-render'].concurrency,
        'runway-clip': QUEUES['runway-clip'].concurrency,
        'image-gen': QUEUES['image-gen'].concurrency,
        'video-compose': QUEUES['video-compose'].concurrency,
        'pipeline-state': QUEUES['pipeline-state'].concurrency,
        'publish': QUEUES['publish'].concurrency,
      },
    },
    'Все workers запущены'
  );

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Получен сигнал завершения, закрываем workers...');

    await Promise.all(allWorkers.map((w) => w.close()));
    await Promise.all([
      gptScriptQueue.close(),
      heygenQueue.close(),
      runwayQueue.close(),
      imageGenQueue.close(),
      videoComposeQueue.close(),
      pipelineStateQueue.close(),
      publishQueue.close(),
      pipelineQueue.close(),
    ]);
    await db.$disconnect();
    connection.disconnect();

    logger.info('Orchestrator остановлен');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Необработанные ошибки — логируем, но не падаем (BullMQ сам переставляет задачи)
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Необработанный Promise rejection');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Orchestrator: критическая ошибка при старте');
  process.exit(1);
});
