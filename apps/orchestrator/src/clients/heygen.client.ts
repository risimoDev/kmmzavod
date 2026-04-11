/**
 * HeyGen API client — talking avatar video generation
 * Docs: https://docs.heygen.com/reference/create-an-avatar-video-v2
 */
import axios, { AxiosInstance } from 'axios';
import { logger } from '../logger';

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
    });
    this.httpV1 = axios.create({
      baseURL: 'https://api.heygen.com/v1',
      headers,
      timeout: 30_000,
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
   */
  async pollUntilDone(
    videoId: string,
    opts = { maxAttempts: 80, baseDelayMs: 15_000 }
  ): Promise<{ videoUrl: string; duration: number }> {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      const res = await this.httpV1.get<VideoStatusResponse>('/video_status.get', {
        params: { video_id: videoId },
      });

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
        throw new Error(`HeyGen video failed: ${error ?? 'unknown'}`);
      }

      logger.debug(
        { videoId, status, attempt, maxAttempts: opts.maxAttempts },
        'HeyGen: ожидаем видео'
      );

      // Ждём: 15s, 15s, 30s, 30s, 60s... без бесконечного роста
      const delay = Math.min(opts.baseDelayMs * Math.ceil(attempt / 2), 60_000);
      await sleep(delay);
    }

    throw new Error(`HeyGen timeout: видео ${videoId} не готово после ${opts.maxAttempts} попыток`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
