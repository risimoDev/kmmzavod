import { Queue } from 'bullmq';
import { QUEUE_DEFS } from '@kmmzavod/queue';
import { getRedis } from './redis';

// Один singleton на процесс — не создаём новые Queue объекты при каждом запросе
const connection = getRedis();

export const pipelineQueue = new Queue(QUEUE_DEFS.PIPELINE.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.PIPELINE.defaultJobOptions,
});

export const gptScriptQueue = new Queue(QUEUE_DEFS.GPT_SCRIPT.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.GPT_SCRIPT.defaultJobOptions,
});

export const heygenQueue = new Queue(QUEUE_DEFS.HEYGEN_RENDER.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.HEYGEN_RENDER.defaultJobOptions,
});

export const runwayQueue = new Queue(QUEUE_DEFS.RUNWAY_CLIP.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.RUNWAY_CLIP.defaultJobOptions,
});

export const imageGenQueue = new Queue(QUEUE_DEFS.IMAGE_GEN.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.IMAGE_GEN.defaultJobOptions,
});

export const videoComposeQueue = new Queue(QUEUE_DEFS.VIDEO_COMPOSE.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.VIDEO_COMPOSE.defaultJobOptions,
});

export const pipelineStateQueue = new Queue(QUEUE_DEFS.PIPELINE_STATE.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.PIPELINE_STATE.defaultJobOptions,
});

export const publishQueue = new Queue(QUEUE_DEFS.PUBLISH.name, {
  connection,
  defaultJobOptions: QUEUE_DEFS.PUBLISH.defaultJobOptions,
});

// All queues for unified stats
export const ALL_QUEUES = {
  pipeline:       pipelineQueue,
  'gpt-script':   gptScriptQueue,
  'heygen-render': heygenQueue,
  'runway-clip':  runwayQueue,
  'image-gen':    imageGenQueue,
  'video-compose': videoComposeQueue,
  'pipeline-state': pipelineStateQueue,
  'publish':         publishQueue,
} as const;
