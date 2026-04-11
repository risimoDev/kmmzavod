/**
 * PostBridge API client — cross-posting to multiple social platforms.
 *
 * @see https://api.post-bridge.com/reference
 */
import fs from 'node:fs';
import path from 'node:path';
import axios, { type AxiosInstance } from 'axios';
import { logger as rootLogger } from '../../logger';

const logger = rootLogger.child({ client: 'postbridge' });

const API_BASE = 'https://api.post-bridge.com/v1';
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

export interface PostBridgeSocialAccount {
  id: number;
  platform: string;
  username: string;
  display_name?: string;
}

export interface PostBridgePostResult {
  id: string;
  status: string;
  social_accounts: number[];
}

export class PostBridgeClient {
  private readonly http: AxiosInstance;

  constructor(private readonly apiKey: string) {
    this.http = axios.create({
      baseURL: API_BASE,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    });
  }

  /**
   * List connected social accounts (with pagination).
   */
  async listSocialAccounts(platforms?: string[]): Promise<PostBridgeSocialAccount[]> {
    const accounts: PostBridgeSocialAccount[] = [];
    let url: string | null = '/social-accounts';
    let isFirst = true;

    while (url) {
      const params: Record<string, unknown> = isFirst ? { limit: 100 } : {};
      if (isFirst && platforms?.length) {
        params.platform = platforms;
      }

      const res: { data?: PostBridgeSocialAccount[]; meta?: { next?: string } } = await this.requestWithRetry('GET', url, { params: isFirst ? params : undefined });
      isFirst = false;

      const data = res.data ?? res;
      if (Array.isArray(data)) {
        accounts.push(...data);
      }

      url = res.meta?.next ?? null;
    }

    return accounts;
  }

  /**
   * Upload a local media file to PostBridge and return its media ID.
   */
  async uploadMedia(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`PostBridge: file does not exist: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const stat = fs.statSync(filePath);
    const mimeType = fileName.endsWith('.mp4') ? 'video/mp4' : 'video/mp4';

    // 1. Get presigned upload URL
    const upload = await this.requestWithRetry<{ media_id: string; upload_url: string }>(
      'POST',
      '/media/create-upload-url',
      {
        data: {
          name: fileName,
          mime_type: mimeType,
          size_bytes: stat.size,
        },
      },
    );

    if (!upload.media_id || !upload.upload_url) {
      throw new Error('PostBridge: no media_id/upload_url in response');
    }

    // 2. PUT file to presigned URL
    const fileStream = fs.createReadStream(filePath);
    await axios.put(upload.upload_url, fileStream, {
      headers: { 'Content-Type': mimeType },
      maxBodyLength: Infinity,
      timeout: 600_000,
    });

    logger.info({ mediaId: upload.media_id }, 'PostBridge: media uploaded');
    return upload.media_id;
  }

  /**
   * Create a post on selected social accounts.
   */
  async createPost(opts: {
    caption: string;
    socialAccountIds: number[];
    mediaIds?: string[];
    scheduledAt?: string;
  }): Promise<PostBridgePostResult> {
    const payload: Record<string, unknown> = {
      caption: opts.caption,
      social_accounts: opts.socialAccountIds,
      processing_enabled: true,
    };

    if (opts.mediaIds?.length) {
      payload.media = opts.mediaIds;
    }
    if (opts.scheduledAt) {
      payload.scheduled_at = opts.scheduledAt;
    }

    const result = await this.requestWithRetry<PostBridgePostResult>('POST', '/posts', { data: payload });
    logger.info({ postId: result.id, accounts: opts.socialAccountIds.length }, 'PostBridge: post created');
    return result;
  }

  private async requestWithRetry<T>(
    method: string,
    url: string,
    opts?: { data?: unknown; params?: unknown },
    maxRetries = 3,
  ): Promise<T> {
    let lastErr: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.http.request({
          method,
          url,
          data: opts?.data,
          params: opts?.params,
        });
        return res.data as T;
      } catch (err: any) {
        lastErr = err;
        const status = err.response?.status;
        if (status && RETRYABLE_CODES.has(status) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        const detail = err.response?.data?.error ?? err.response?.data?.message ?? err.message;
        throw new Error(`PostBridge API ${method} ${url} failed (HTTP ${status}): ${detail}`);
      }
    }

    throw lastErr;
  }
}
