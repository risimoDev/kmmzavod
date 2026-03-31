// Queue names, concurrency config, and BullMQ job payload types
// Shared by orchestrator (producers) and workers (consumers)

export const QUEUE_DEFS = {
  PIPELINE: {
    name: 'pipeline',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    },
    concurrency: 20,
  },
  GPT_SCRIPT: {
    name: 'gpt-script',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 3000 },
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
    concurrency: 5,
  },
  HEYGEN_RENDER: {
    name: 'heygen-render',
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'fixed' as const, delay: 15000 },
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
    concurrency: 3,
  },
  RUNWAY_CLIP: {
    name: 'runway-clip',
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'fixed' as const, delay: 10000 },
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
    concurrency: 5,
  },
  IMAGE_GEN: {
    name: 'image-gen',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 5000 },
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
    concurrency: 4,
  },
  VIDEO_COMPOSE: {
    name: 'video-compose',
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed' as const, delay: 30000 },
      removeOnComplete: { count: 200 },
      removeOnFail: false,
    },
    concurrency: 2,
  },
  PIPELINE_STATE: {
    name: 'pipeline-state',
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 2000 },
      removeOnFail: { count: 500 },
    },
    concurrency: 20,
  },
  PUBLISH: {
    name: 'publish',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed' as const, delay: 30000 },
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
    concurrency: 2,
  },
} as const;

export type QueueName = typeof QUEUE_DEFS[keyof typeof QUEUE_DEFS]['name'];

// ── Job Payloads ──────────────────────────────────────────────────────────────

export interface PipelineJobPayload {
  jobId: string;
  tenantId: string;
}

export interface ProductContext {
  name: string;
  description?: string;
  features: string[];
  targetAudience?: string;
  brandVoice?: string;
  imageUrls: string[];
}

export interface GptScriptJobPayload {
  jobId: string;
  tenantId: string;
  prompt: string;
  projectSettings: Record<string, unknown>;
  productContext?: ProductContext;
}

export interface HeygenRenderJobPayload {
  jobId: string;
  sceneId: string;
  tenantId: string;
  avatarId: string;
  voiceId: string;
  script: string;
}

export interface RunwayClipJobPayload {
  jobId: string;
  sceneId: string;
  tenantId: string;
  prompt: string;
  durationSec: number;
}

/** @deprecated Use RunwayClipJobPayload */
export type KlingClipJobPayload = RunwayClipJobPayload;

export interface ImageGenJobPayload {
  jobId: string;
  sceneId: string;
  tenantId: string;
  prompt: string;
  referenceImageKeys: string[];
}

export interface VideoComposeJobPayload {
  jobId: string;
  tenantId: string;
  variants?: string[];
}

export interface PipelineStateJobPayload {
  jobId: string;
  sceneId: string;
  tenantId: string;
  completedStage: 'avatar' | 'clip' | 'image';
}

export interface PublishJobPayload {
  publishJobId: string;
  videoId: string;
  tenantId: string;
  platform: 'tiktok' | 'instagram' | 'youtube_shorts';
  socialAccountId: string;
  scheduledAt?: string;
}

// ── QUEUES — flat lookup keyed by queue-name string ───────────────────────────
// Workers and index.ts use QUEUES['name'].foo to access config.

interface QueueEntry {
  name: string;
  concurrency: number;
  /** Default max retry attempts */
  attempts: number;
  /** BullMQ backoff strategy (undefined → no backoff) */
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
  /** Full defaultJobOptions for Queue.add() calls */
  defaultJobOptions: Record<string, unknown>;
}

function flatten(
  q: { name: string; concurrency: number; defaultJobOptions: { attempts: number; backoff?: { type: 'exponential' | 'fixed'; delay: number }; [k: string]: unknown } }
): QueueEntry {
  return {
    name:               q.name,
    concurrency:        q.concurrency,
    attempts:           q.defaultJobOptions.attempts,
    backoff:            q.defaultJobOptions.backoff,
    defaultJobOptions:  q.defaultJobOptions as Record<string, unknown>,
  };
}

export const QUEUES: Record<string, QueueEntry> = {
  'pipeline':       flatten(QUEUE_DEFS.PIPELINE),
  'gpt-script':     flatten(QUEUE_DEFS.GPT_SCRIPT),
  'heygen-render':  flatten(QUEUE_DEFS.HEYGEN_RENDER),
  'runway-clip':    flatten(QUEUE_DEFS.RUNWAY_CLIP),
  'image-gen':      flatten(QUEUE_DEFS.IMAGE_GEN),
  'video-compose':  flatten(QUEUE_DEFS.VIDEO_COMPOSE),
  'pipeline-state': flatten(QUEUE_DEFS.PIPELINE_STATE),
  'publish':        flatten(QUEUE_DEFS.PUBLISH),
};
