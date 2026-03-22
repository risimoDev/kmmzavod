/**
 * TikTok Content Posting API v2 клиент.
 * Поддерживает upload видео через file-upload flow и refresh token rotation.
 *
 * @see https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 */
import fs from 'node:fs';
import { logger as rootLogger } from '../../logger';

const logger = rootLogger.child({ client: 'tiktok' });

const TIKTOK_API = 'https://open.tiktokapis.com/v2';

interface TikTokTokens {
  accessToken: string;
  refreshToken: string;
}

export interface TikTokUploadResult {
  publishId: string;
  newAccessToken?: string;
  newRefreshToken?: string;
  newExpiresAt?: Date;
}

export class TikTokClient {
  private clientKey: string;
  private clientSecret: string;

  constructor(clientKey: string, clientSecret: string) {
    this.clientKey = clientKey;
    this.clientSecret = clientSecret;
  }

  /**
   * Обновляет access token через refresh token flow.
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const res = await fetch(`${TIKTOK_API}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`TikTok refresh token failed: ${res.status} ${text}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Загружает видео на TikTok через Content Posting API v2 (FILE_UPLOAD).
   * Возвращает publish_id для отслеживания статуса.
   */
  async uploadVideo(
    tokens: TikTokTokens,
    videoPath: string,
    caption: string,
  ): Promise<TikTokUploadResult> {
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;

    // Step 1 — init upload
    const initRes = await fetch(`${TIKTOK_API}/post/publish/inbox/video/init/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1,
        },
      }),
    });

    if (!initRes.ok) {
      const text = await initRes.text();
      throw new Error(`TikTok init upload failed: ${initRes.status} ${text}`);
    }

    const initData = await initRes.json() as {
      data: { publish_id: string; upload_url: string };
    };

    const { publish_id, upload_url } = initData.data;
    logger.info({ publish_id }, 'TikTok upload initialized');

    // Step 2 — upload file chunk
    const videoBuffer = fs.readFileSync(videoPath);
    const uploadRes = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
        'Content-Length': String(fileSize),
      },
      body: videoBuffer,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`TikTok file upload failed: ${uploadRes.status} ${text}`);
    }

    logger.info({ publish_id }, 'TikTok video uploaded');

    // Step 3 — publish with caption
    const publishRes = await fetch(`${TIKTOK_API}/post/publish/video/init/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 2200),
          privacy_level: 'SELF_ONLY', // по-умолчанию — draft, затем пользователь публикует
          disable_duet: false,
          disable_stitch: false,
          disable_comment: false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: upload_url,
        },
      }),
    });

    if (!publishRes.ok) {
      const text = await publishRes.text();
      throw new Error(`TikTok publish failed: ${publishRes.status} ${text}`);
    }

    const publishData = await publishRes.json() as {
      data: { publish_id: string };
    };

    return { publishId: publishData.data.publish_id };
  }

  /**
   * Проверяет статус публикации.
   */
  async checkPublishStatus(accessToken: string, publishId: string): Promise<{
    status: string;
    failReason?: string;
  }> {
    const res = await fetch(`${TIKTOK_API}/post/publish/status/fetch/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`TikTok status check failed: ${res.status} ${text}`);
    }

    const data = await res.json() as {
      data: { status: string; fail_reason?: string };
    };

    return {
      status: data.data.status,
      failReason: data.data.fail_reason,
    };
  }
}
