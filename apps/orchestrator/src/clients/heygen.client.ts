/**
 * HeyGen API client — talking avatar video generation
 * Docs: https://docs.heygen.com/reference/create-an-avatar-video-v2
 */
import axios, { AxiosInstance } from 'axios';
import { logger } from '../logger';
import { axiosProxyConfig } from '../lib/proxy';
import { PollFailureTracker, ProviderTaskFailedError, retryAfterMs } from '../lib/provider-errors';

interface HeyGenScene {
  avatarId: string;
  voiceId: string;
  script: string;
}

interface CreateVideoResponse {
  data: { video_id: string };
  error: string | null;
}

interface VideoStatusResponse {
  data: {
    video_id: string;
    status: 'waiting' | 'pending' | 'processing' | 'completed' | 'failed';
    video_url?: string;
    duration?: number;
    error?: string;
  };
  error: string | null;
}

export class HeyGenClient {
  private http: AxiosInstance;
  /** Separate instance for v1 endpoints (e.g. video_status) */
  private httpV1: AxiosInstance;

  constructor(apiKey: string) {
    const headers = {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    };
    this.http = axios.create({
      baseURL: 'https://api.heygen.com/v2',
      headers,
      timeout: 30_000,
      ...axiosProxyConfig(),
    });
    this.httpV1 = axios.create({
      baseURL: 'https://api.heygen.com/v1',
      headers,
      timeout: 30_000,
      ...axiosProxyConfig(),
    });
  }

  async createAvatarVideo(scene: HeyGenScene): Promise<string> {
    const payload = {
      video_inputs: [
        {
          character: {
            type: 'avatar',
            avatar_id: scene.avatarId,
            avatar_style: 'normal',
          },
          voice: {
            type: 'text',
            input_text: scene.script,
            voice_id: scene.voiceId,
          },
          background: { type: 'color', value: '#00FF00' },
        },
      ],
      dimension: { width: 1080, height: 1920 },
      aspect_ratio: null,
    };

    const res = await this.http.post<CreateVideoResponse>('/video/generate', payload);

    if (res.data.error) {
      const errMsg = typeof res.data.error === 'string'
        ? res.data.error
        : ((res.data.error as any)?.message ?? JSON.stringify(res.data.error));
      throw new Error(`HeyGen create error: ${errMsg}`);
    }

    return res.data.data.video_id;
  }

  /**
   * Опрос статуса задачи с экспоненциальной задержкой.
   * Возвращает URL готового видео или бросает ошибку.
   *
   * Временные сбои запроса статуса (сеть, 5xx, 429) НЕ прерывают опрос: задача уже оплачена,
   * а ретрай воркера пересоздал бы её. Сдаёмся после maxConsecutiveErrors подряд.
   */
  async pollUntilDone(
    videoId: string,
    opts: {
      maxAttempts?: number;
      baseDelayMs?: number;
      maxConsecutiveErrors?: number;
      errorBackoffMs?: number;
    } = {},
  ): Promise<{ videoUrl: string; duration: number }> {
    const maxAttempts = opts.maxAttempts ?? 80;
    const baseDelayMs = opts.baseDelayMs ?? 15_000;
    const failures = new PollFailureTracker(opts.maxConsecutiveErrors ?? 8, opts.errorBackoffMs ?? 5_000);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await this.httpV1.get<VideoStatusResponse>('/video_status.get', {
          params: { video_id: videoId },
        });
        failures.onSuccess();
      } catch (err) {
        const waitMs = failures.onError(err); // rethrows non-transient / exhausted
        logger.warn(
          { videoId, attempt, consecutiveErrors: failures.failures, waitMs, err: (err as Error).message, retryAfterMs: retryAfterMs(err) },
          'HeyGen: сбой запроса статуса, повторяем',
        );
        await sleep(waitMs);
        continue;
      }

      if (res.data.error) {
        const errMsg = typeof res.data.error === 'string'
          ? res.data.error
          : ((res.data.error as any)?.message ?? JSON.stringify(res.data.error));
        throw new Error(`HeyGen poll error: ${errMsg}`);
      }

      const { status, video_url, duration, error } = res.data.data;

      if (status === 'completed' && video_url) {
        return { videoUrl: video_url, duration: duration ?? 0 };
      }

      if (status === 'failed') {
        const errMsg = typeof error === 'string' ? error : (error != null ? JSON.stringify(error) : 'unknown');
        throw new ProviderTaskFailedError(`HeyGen video failed: ${errMsg}`);
      }

      logger.debug(
        { videoId, status, attempt, maxAttempts },
        'HeyGen: ожидаем видео'
      );

      // Ждём: 15s, 15s, 30s, 30s, 60s... без бесконечного роста
      const delay = Math.min(baseDelayMs * Math.ceil(attempt / 2), 60_000);
      await sleep(delay);
    }

    throw new Error(`HeyGen timeout: видео ${videoId} не готово после ${maxAttempts} попыток`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
