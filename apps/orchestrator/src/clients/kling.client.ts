/**
 * Kling AI client — short video clip generation (2-5 sec)
 * Auth: HMAC-SHA256 signed JWT (Kling API v1)
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../logger';
import { axiosProxyConfig } from '../lib/proxy';

interface CreateClipOpts {
  prompt: string;
  durationSec: number; // 2 | 3 | 5
  aspectRatio?: '16:9' | '9:16' | '1:1';
}

interface CreateClipResponse {
  code: number;
  message: string;
  data: { task_id: string };
}

interface ClipStatusResponse {
  code: number;
  data: {
    task_id: string;
    task_status: 'submitted' | 'processing' | 'succeed' | 'failed';
    task_result?: {
      videos: Array<{ id: string; url: string; duration: string }>;
    };
    task_status_msg?: string;
  };
}

export class KlingClient {
  private http: AxiosInstance;
  private accessKey: string;
  private secretKey: string;

  constructor(accessKey: string, secretKey: string) {
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.http = axios.create({
      baseURL: 'https://api.klingai.com/v1',
      timeout: 30_000,
      ...axiosProxyConfig(),
    });

    // Добавляем HMAC JWT ко всем запросам
    this.http.interceptors.request.use((cfg) => {
      cfg.headers['Authorization'] = `Bearer ${this.buildJwt()}`;
      return cfg;
    });
  }

  /** Kling использует HMAC-SHA256 подписанный JWT без exp */
  private buildJwt(): string {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({ iss: this.accessKey, exp: Math.floor(Date.now() / 1000) + 1800 })
    );
    const sig = base64url(
      crypto.createHmac('sha256', this.secretKey).update(`${header}.${payload}`).digest()
    );
    return `${header}.${payload}.${sig}`;
  }

  async createClip(opts: CreateClipOpts): Promise<string> {
    const res = await this.http.post<CreateClipResponse>('/videos/text2video', {
      prompt: opts.prompt,
      duration: String(opts.durationSec),
      aspect_ratio: opts.aspectRatio ?? '9:16',
      mode: 'std',
    });

    if (res.data.code !== 0) {
      throw new Error(`Kling create error: ${res.data.message}`);
    }

    return res.data.data.task_id;
  }

  async pollUntilDone(
    taskId: string,
    opts = { maxAttempts: 30, baseDelayMs: 10_000 }
  ): Promise<{ videoUrl: string; duration: number }> {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      const res = await this.http.get<ClipStatusResponse>(`/videos/text2video/${taskId}`);

      const { task_status, task_result, task_status_msg } = res.data.data;

      if (task_status === 'succeed' && task_result?.videos?.[0]) {
        const v = task_result.videos[0];
        return { videoUrl: v.url, duration: parseFloat(v.duration) };
      }

      if (task_status === 'failed') {
        throw new Error(`Kling clip failed: ${task_status_msg ?? 'unknown'}`);
      }

      logger.debug(
        { taskId, task_status, attempt },
        'Kling: ожидаем клип'
      );

      await sleep(Math.min(opts.baseDelayMs * Math.ceil(attempt / 3), 30_000));
    }

    throw new Error(`Kling timeout: задача ${taskId} не завершена`);
  }
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
