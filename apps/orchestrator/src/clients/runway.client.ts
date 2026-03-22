/**
 * Runway API client — video generation via Gen-3 Alpha Turbo.
 *
 * Provides text/image-to-video clip generation for b-roll scenes.
 * NOTE: Runway does NOT offer a standalone image-generation endpoint.
 * Image generation is handled by {@link ImageGenClient} (fal.ai flux-pro fallback).
 *
 * @see https://docs.dev.runwayml.com/guides/creating-tasks — task lifecycle
 * @see https://docs.dev.runwayml.com/reference/create-image-to-video — image_to_video endpoint
 * @see https://docs.dev.runwayml.com/reference/retrieve-task — polling / task status
 */
import axios, { type AxiosInstance } from 'axios';
import { logger } from '../logger';

const RUNWAY_BASE_URL = 'https://api.dev.runwayml.com/v1';
const RUNWAY_API_VERSION = '2024-11-06';

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
   * Create a text-to-video (or image-to-video) task via Runway Gen-3 Alpha Turbo.
   *
   * The Runway API accepts `promptText` for text guidance. When no `promptImage`
   * is supplied the model generates purely from text.
   *
   * @param opts.prompt       — cinematic description of the clip
   * @param opts.durationSec  — desired length: 5 or 10 (Runway only supports these two)
   * @param opts.aspectRatio  — e.g. "9:16" (vertical) or "16:9"
   * @returns Runway task ID for polling
   *
   * @see https://docs.dev.runwayml.com/reference/create-image-to-video
   */
  async createClip(opts: {
    prompt: string;
    durationSec?: number;
    aspectRatio?: string;
  }): Promise<string> {
    const duration = opts.durationSec && opts.durationSec >= 10 ? 10 : 5;

    const res = await this.http.post<{ id: string }>('/image_to_video', {
      model: 'gen3a_turbo',
      promptText: opts.prompt,
      duration,
      ratio: opts.aspectRatio ?? '9:16',
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
