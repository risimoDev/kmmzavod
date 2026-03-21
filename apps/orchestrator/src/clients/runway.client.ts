/**
 * Runway API client — text-to-video and text-to-image generation.
 * Replaces Kling for b-roll clips and fal/Replicate/ComfyUI for images.
 *
 * Docs: https://docs.dev.runwayml.com/
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
   * Generate a b-roll video clip from a text prompt.
   * Uses Runway Gen-3 Alpha Turbo text_to_video endpoint.
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
   * Generate an image from a text prompt.
   */
  async createImage(opts: {
    prompt: string;
    width?: number;
    height?: number;
  }): Promise<string> {
    const res = await this.http.post<{ id: string }>('/image_to_video', {
      model: 'gen3a_turbo',
      promptText: opts.prompt,
      duration: 5,
      ratio: '9:16',
    });

    return res.data.id;
  }

  /**
   * Poll a task until it reaches a terminal state.
   * Exponential backoff: 10s, 10s, 15s, 20s, 30s... max 60s.
   */
  async pollUntilDone(
    taskId: string,
    opts = { maxAttempts: 60, baseDelayMs: 10_000 },
  ): Promise<{ outputUrl: string; duration: number }> {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      const res = await this.http.get<RunwayTaskResponse>(`/tasks/${taskId}`);
      const task = res.data;

      if (task.status === 'SUCCEEDED') {
        const outputUrl = task.output?.[0];
        if (!outputUrl) throw new Error('Runway: task succeeded but no output URL');
        return { outputUrl, duration: 5 };
      }

      if (task.status === 'FAILED' || task.status === 'CANCELLED') {
        throw new Error(`Runway task ${task.status}: ${task.failure ?? 'unknown error'}`);
      }

      logger.debug(
        { taskId, status: task.status, attempt, maxAttempts: opts.maxAttempts },
        'Runway: ожидаем результат',
      );

      const delay = Math.min(opts.baseDelayMs * Math.ceil(attempt / 2), 60_000);
      await sleep(delay);
    }

    throw new Error(`Runway timeout: задача ${taskId} не готова после ${opts.maxAttempts} попыток`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
