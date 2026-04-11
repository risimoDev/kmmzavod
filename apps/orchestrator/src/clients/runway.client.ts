/**
 * Runway API client — video generation via Gen-4.5 / Gen-4 Turbo + image-to-video.
 *
 * Provides:
 * - text-to-video clip generation for b-roll scenes
 * - image-to-video generation from product images (cheaper, more relevant)
 *
 * @see https://docs.dev.runwayml.com/guides/using-the-api — getting started
 * @see https://docs.dev.runwayml.com/api#tag/Start-generating/paths/~1v1~1text_to_video/post — text_to_video
 * @see https://docs.dev.runwayml.com/api#tag/Start-generating/paths/~1v1~1image_to_video/post — image_to_video
 * @see https://docs.dev.runwayml.com/api#tag/Task-management/paths/~1v1~1tasks~1{id}/get — polling / task status
 */
import axios, { type AxiosInstance } from 'axios';
import { logger } from '../logger';

const RUNWAY_BASE_URL = 'https://api.dev.runwayml.com/v1';
const RUNWAY_API_VERSION = '2024-11-06';

export type RunwayVideoModel = 'gen4.5' | 'gen4_turbo';

interface RunwayTaskResponse {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  output?: string[];
  failure?: string;
  createdAt?: string;
  /** Seconds — returned by the API for completed video tasks. */
  duration?: number;
}

export class RunwayClient {
  private http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: RUNWAY_BASE_URL,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': RUNWAY_API_VERSION,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
  }

  /**
   * Create a text-to-video task.
   *
   * @param opts.prompt       — cinematic description of the clip
   * @param opts.durationSec  — desired length: 2–10 (integer)
   * @param opts.aspectRatio  — e.g. "720:1280" (vertical) or "1280:720" (horizontal)
   * @param opts.model        — "gen4.5" (12 credits/sec) or "gen4_turbo" (5 credits/sec)
   * @returns Runway task ID for polling
   */
  async createClip(opts: {
    prompt: string;
    durationSec?: number;
    aspectRatio?: string;
    model?: RunwayVideoModel;
  }): Promise<string> {
    const duration = Math.max(2, Math.min(opts.durationSec ?? 5, 10));
    const model = opts.model ?? 'gen4_turbo';

    let ratio = opts.aspectRatio ?? '720:1280';
    if (ratio === '9:16') ratio = '720:1280';
    else if (ratio === '16:9') ratio = '1280:720';
    else if (ratio === '1:1') ratio = '960:960';

    // gen4_turbo doesn't support text_to_video — only gen4.5 does
    if (model === 'gen4_turbo') {
      throw new Error('gen4_turbo does not support text-to-video; use createImageToVideo() or gen4.5');
    }

    const res = await this.http.post<{ id: string }>('/text_to_video', {
      model,
      promptText: opts.prompt,
      duration,
      ratio,
    });

    return res.data.id;
  }

  /**
   * Create an image-to-video task.
   * Takes a source image (e.g. generated product shot) and animates it.
   *
   * gen4_turbo: 5 credits/sec ($0.05/sec) — 2.4× cheaper than gen4.5
   * gen4.5:    12 credits/sec ($0.12/sec) — higher quality
   *
   * @param opts.promptImage  — HTTPS URL or data URI of the source image
   * @param opts.prompt       — motion/animation description
   * @param opts.durationSec  — 2–10 seconds
   * @param opts.aspectRatio  — pixel ratio (e.g. "720:1280")
   * @param opts.model        — gen4_turbo (default, cheap) or gen4.5
   * @returns Runway task ID for polling
   */
  async createImageToVideo(opts: {
    promptImage: string;
    prompt: string;
    durationSec?: number;
    aspectRatio?: string;
    model?: RunwayVideoModel;
  }): Promise<string> {
    const duration = Math.max(2, Math.min(opts.durationSec ?? 5, 10));
    const model = opts.model ?? 'gen4_turbo';

    let ratio = opts.aspectRatio ?? '720:1280';
    if (ratio === '9:16') ratio = '720:1280';
    else if (ratio === '16:9') ratio = '1280:720';
    else if (ratio === '1:1') ratio = '960:960';

    const res = await this.http.post<{ id: string }>('/image_to_video', {
      model,
      promptImage: [{ uri: opts.promptImage, position: 'first' }],
      promptText: opts.prompt,
      duration,
      ratio,
    });

    return res.data.id;
  }

  /**
   * Poll a Runway task until it reaches a terminal state.
   *
   * Uses progressive backoff: 10 s → 15 s → 20 s → … capped at 60 s.
   * On success returns the first output URL and the **actual** clip duration
   * reported by the API (falls back to the requested duration if absent).
   *
   * @param taskId       — ID returned by {@link createClip}
   * @param opts.maxAttempts  — max poll iterations (default 60 ≈ 10–15 min)
   * @param opts.baseDelayMs  — initial delay between polls
   * @param opts.requestedDurationSec — fallback duration if API doesn't report one
   * @returns `{ outputUrl, duration }` — presigned URL + clip length in seconds
   *
   * @see https://docs.dev.runwayml.com/reference/retrieve-task
   */
  async pollUntilDone(
    taskId: string,
    opts: { maxAttempts?: number; baseDelayMs?: number; requestedDurationSec?: number } = {},
  ): Promise<{ outputUrl: string; duration: number }> {
    const maxAttempts = opts.maxAttempts ?? 60;
    const baseDelayMs = opts.baseDelayMs ?? 10_000;
    const fallbackDuration = opts.requestedDurationSec ?? 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.http.get<RunwayTaskResponse>(`/tasks/${taskId}`);
      const task = res.data;

      if (task.status === 'SUCCEEDED') {
        const outputUrl = task.output?.[0];
        if (!outputUrl) throw new Error('Runway: task succeeded but no output URL');
        const duration = task.duration && task.duration > 0 ? task.duration : fallbackDuration;
        return { outputUrl, duration };
      }

      if (task.status === 'FAILED' || task.status === 'CANCELLED') {
        throw new Error(`Runway task ${task.status}: ${task.failure ?? 'unknown error'}`);
      }

      logger.debug(
        { taskId, status: task.status, attempt, maxAttempts },
        'Runway: ожидаем результат',
      );

      const delay = Math.min(baseDelayMs * Math.ceil(attempt / 2), 60_000);
      await sleep(delay);
    }

    throw new Error(`Runway timeout: задача ${taskId} не готова после ${maxAttempts} попыток`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
