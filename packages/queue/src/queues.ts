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
  SCHEDULER: {
    name: 'scheduler',
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
    concurrency: 1,
  },
  // ── Uniquification pipeline ──────────────────────────────────────────────
  UNIQUIFY_ANALYZE: {
    name: 'uniquify-analyze',
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential' as const, delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: false,
    },
    concurrency: 2,
  },
  UNIQUIFY_RENDER: {
    name: 'uniquify-render',
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed' as const, delay: 10000 },
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    },
    concurrency: 3,
  },
  UNIQUIFY_STATE: {
    name: 'uniquify-state',
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 2000 },
      removeOnFail: { count: 500 },
    },
    concurrency: 10,
  },
  UNIQUIFY_DISTRIBUTE: {
    name: 'uniquify-distribute',
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed' as const, delay: 5000 },
      removeOnComplete: { count: 200 },
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
  /** VideoPreset ID — enables idea deduplication and preset-aware generation */
  presetId?: string;
  /** Hashes of previously used ideas (from preset.usedIdeaHashes) */
  usedIdeaHashes?: string[];
}

export interface HeygenRenderJobPayload {
  jobId: string;
  /** Primary/first avatar sceneId (used for logging and single-scene mode) */
  sceneId: string;
  tenantId: string;
  avatarId: string;
  voiceId: string;
  script: string;
  /**
   * Combined mode: when true, `script` is ALL avatar scripts concatenated and
   * `combinedSceneIds` lists ALL avatar scene IDs in scene order.
   * The worker will render ONE HeyGen video and mark all scenes done.
   */
  isCombined?: boolean;
  combinedSceneIds?: string[];
}

export interface RunwayClipJobPayload {
  jobId: string;
  sceneId: string;
  tenantId: string;
  prompt: string;
  durationSec: number;
  /** Presigned HTTPS URL of a product image for image-to-video mode. If set, uses cheaper gen4_turbo. */
  referenceImageUrl?: string;
}

/** @deprecated Use RunwayClipJobPayload */
export type KlingClipJobPayload = RunwayClipJobPayload;

export interface ImageGenJobPayload {
  jobId: string;
  sceneId: string;
  tenantId: string;
  prompt: string;
  referenceImageKeys: string[];
  /** Purpose of image generation */
  purpose?: 'scene-image' | 'runway-frame';
  /** Duration for runway clip (only when purpose=runway-frame) */
  clipDurationSec?: number;
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
  videoId?: string;
  uniqueVariantId?: string;
  tenantId: string;
  platform: 'tiktok' | 'instagram' | 'youtube_shorts' | 'postbridge';
  socialAccountId: string;
  scheduledAt?: string;
}

/** Scheduler tick payload — the repeatable job fires this every minute */
export interface SchedulerTickPayload {
  tick: number;
}

// ── Uniquification payloads ──────────────────────────────────────────────────

export interface UniquifyAnalyzeJobPayload {
  sourceVideoId: string;
  tenantId: string;
  uniquifyJobId: string;
}

/** Configuration for visual transforms applied to each variant */
export interface VariantTransforms {
  // Visual
  cropPercent: number;       // 0.01–0.05 random crop
  cropOffsetX: number;       // normalized 0–1
  cropOffsetY: number;       // normalized 0–1
  hFlip: boolean;            // horizontal mirror
  speed: number;             // 0.95–1.05
  hueShift: number;          // -10 to +10 degrees
  saturationShift: number;   // 0.9–1.1
  brightnessShift: number;   // -0.05 to +0.05
  contrastShift: number;     // 0.95–1.05
  crf: number;               // 19–25 (encoder quality variation)
  // Audio
  bgmTrackKey?: string;      // MinIO key of BGM track
  bgmVolume: number;         // 0.05–0.20
  pitchShift: number;        // -2 to +2 semitones
  // Subtitles
  subtitleStyle: 'tiktok' | 'cinematic' | 'minimal' | 'default' | 'none';
  subtitleFontSize: number;  // 18–32
  subtitleColor: string;     // hex color
  subtitlePosition: 'bottom' | 'top' | 'center';
  // TTS
  ttsVoiceId?: string;
  ttsSpeed?: number;         // 0.9–1.1
  // Intro/outro
  trimStartSec: number;      // 0–2 sec trim from start
  trimEndSec: number;        // 0–2 sec trim from end
}

export interface UniquifyRenderJobPayload {
  uniquifyJobId: string;
  variantId: string;
  tenantId: string;
  sourceVideoStorageKey: string;
  outputKey: string;
  transforms: VariantTransforms;
  /** Whisper transcript for subtitle generation */
  transcript?: unknown;
}

export interface UniquifyStateJobPayload {
  uniquifyJobId: string;
  variantId: string;
  tenantId: string;
  status: 'completed' | 'failed';
  error?: string;
}

export interface DistributeJobPayload {
  distributeJobId: string;
  tenantId: string;
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
  'scheduler':         flatten(QUEUE_DEFS.SCHEDULER),
  'uniquify-analyze':  flatten(QUEUE_DEFS.UNIQUIFY_ANALYZE),
  'uniquify-render':   flatten(QUEUE_DEFS.UNIQUIFY_RENDER),
  'uniquify-state':    flatten(QUEUE_DEFS.UNIQUIFY_STATE),
  'uniquify-distribute': flatten(QUEUE_DEFS.UNIQUIFY_DISTRIBUTE),
};
