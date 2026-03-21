/**
 * HeyGen API client — talking avatar video generation
 * Docs: https://docs.heygen.com/reference/create-an-avatar-video-v2
 */
import axios, { AxiosInstance } from 'axios';
import { logger } from '../logger';

interface HeyGenScene {
  avatarId: string;
  script: string;
  voice?: { type: 'text'; input_text: string; voice_id: string };
}

interface CreateVideoResponse {
  data: { video_id: string };
  error: string | null;
}

interface VideoStatusResponse {
  data: {
    video_id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    video_url?: string;
    duration?: number;
    error?: string;
  };
  error: string | null;
}

export class HeyGenClient {
  private http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: 'https://api.heygen.com/v2',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
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
            voice_id: scene.voice?.voice_id ?? 'default',
          },
          background: { type: 'color', value: '#ffffff' },
        },
      ],
      dimension: { width: 1080, height: 1920 },
      aspect_ratio: null,
    };

    const res = await this.http.post<CreateVideoResponse>('/video/generate', payload);

    if (res.data.error) {
      throw new Error(`HeyGen create error: ${res.data.error}`);
    }

    return res.data.data.video_id;
  }

  /**
   * Опрос статуса задачи с экспоненциальной задержкой.
   * Возвращает URL готового видео или бросает ошибку.
   */
  async pollUntilDone(
    videoId: string,
    opts = { maxAttempts: 40, baseDelayMs: 15_000 }
  ): Promise<{ videoUrl: string; duration: number }> {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      const res = await this.http.get<VideoStatusResponse>(`/video/${videoId}`);

      if (res.data.error) {
        throw new Error(`HeyGen poll error: ${res.data.error}`);
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
