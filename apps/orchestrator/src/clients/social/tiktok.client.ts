/**
 * TikTok Content Posting API v2 client — FILE_UPLOAD flow.
 *
 * Correct flow:
 *  1. POST /v2/post/publish/video/init/ — init with post_info + source_info (FILE_UPLOAD)
 *     → returns { publish_id, upload_url }
 *  2. PUT upload_url — upload raw video bytes (single chunk)
 *     → 201 or 206 = success
 *  3. POST /v2/post/publish/status/fetch/ — poll until SUCCESS or FAILED
 *
 * @see https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 * @see https://developers.tiktok.com/doc/content-posting-api-get-started
 */
import fs from 'node:fs';
import { logger as rootLogger } from '../../logger';
import { proxyFetch } from '../../lib/proxy';

const log = rootLogger.child({ client: 'tiktok' });

const TIKTOK_API = 'https://open.tiktokapis.com/v2';

/** Max TikTok video title length. */
const MAX_TITLE_LENGTH = 2_200;
/** Delay between publish status polls (ms). */
const POLL_INTERVAL_MS = 15_000;
/** Maximum poll attempts (~5 min). */
const MAX_POLL_ATTEMPTS = 20;

export type TikTokPrivacyLevel = 'SELF_ONLY' | 'FOLLOWER_OF_CREATOR' | 'PUBLIC_TO_EVERYONE';

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
  /** Per-account proxy URL override. Set before calling uploadVideo/pollPublishStatus. */
  proxyUrl: string | null = null;

  constructor(clientKey: string, clientSecret: string) {
    this.clientKey = clientKey;
    this.clientSecret = clientSecret;
  }

  /**
   * Refresh an access token via the OAuth refresh_token grant.
   *
   * @see https://developers.tiktok.com/doc/oauth-user-access-token-management
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    log.debug('Refreshing TikTok access token');

    const res = await proxyFetch(`${TIKTOK_API}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    }, this.proxyUrl);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TikTok token refresh failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    log.info({ expiresIn: data.expires_in }, 'TikTok access token refreshed');

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Upload and publish a video via TikTok Content Posting API v2 (FILE_UPLOAD).
   *
   * @param tokens       OAuth tokens for the creator
   * @param videoPath    Local path to the mp4 file
   * @param title        Video title / description (max 2 200 chars)
   * @param privacyLevel Visibility: SELF_ONLY (draft), FOLLOWER_OF_CREATOR, PUBLIC_TO_EVERYONE
   * @returns publish_id for tracking upload status
   */
  async uploadVideo(
    tokens: TikTokTokens,
    videoPath: string,
    title: string,
    privacyLevel: TikTokPrivacyLevel = 'SELF_ONLY',
  ): Promise<TikTokUploadResult> {
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;

    // ── Step 1: Init publish with post_info + FILE_UPLOAD source ──────────
    log.info({ fileSize, privacyLevel }, 'TikTok: initializing video upload');

    const initRes = await proxyFetch(`${TIKTOK_API}/post/publish/video/init/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: title.slice(0, MAX_TITLE_LENGTH),
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_stitch: false,
          disable_comment: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1,
        },
      }),
    }, this.proxyUrl);

    if (!initRes.ok) {
      const body = await initRes.text();
      throw new Error(`TikTok init upload failed (${initRes.status}): ${body}`);
    }

    const initData = (await initRes.json()) as {
      data: { publish_id: string; upload_url: string };
    };

    const { publish_id, upload_url } = initData.data;
    log.info({ publish_id }, 'TikTok: upload initialized, uploading file');

    // ── Step 2: Upload raw video bytes (single chunk) ────────────────────
    const videoBuffer = fs.readFileSync(videoPath);

    const uploadRes = await proxyFetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
        'Content-Length': String(fileSize),
      },
      body: videoBuffer,
    }, this.proxyUrl);

    // TikTok returns 201 Created or 206 Partial Content on successful chunk upload
    if (!uploadRes.ok && uploadRes.status !== 206) {
      const body = await uploadRes.text();
      throw new Error(`TikTok file upload failed (${uploadRes.status}): ${body}`);
    }

    log.info({ publish_id }, 'TikTok: video file uploaded successfully');

    return { publishId: publish_id };
  }

  /**
   * Poll publish status until terminal state (SUCCESS or FAILED).
   *
   * @param accessToken OAuth access token
   * @param publishId   The publish_id from uploadVideo()
   * @returns Final status string
   * @throws If publish fails or polling exceeds MAX_POLL_ATTEMPTS
   */
  async pollPublishStatus(accessToken: string, publishId: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const { status, failReason } = await this.checkPublishStatus(accessToken, publishId);

      if (status === 'PUBLISH_COMPLETE') {
        log.info({ publishId, attempt }, 'TikTok: publish completed');
        return status;
      }

      if (status === 'FAILED') {
        throw new Error(`TikTok publish failed: ${failReason ?? 'unknown reason'}`);
      }

      log.debug({ publishId, status, attempt }, 'TikTok: waiting for publish');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(
      `TikTok publish ${publishId} not complete after ${MAX_POLL_ATTEMPTS} attempts (~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60_000} min)`,
    );
  }

  /**
   * Check the current status of a publish operation (single request).
   *
   * @see https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
   */
  async checkPublishStatus(accessToken: string, publishId: string): Promise<{
    status: string;
    failReason?: string;
  }> {
    const res = await proxyFetch(`${TIKTOK_API}/post/publish/status/fetch/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    }, this.proxyUrl);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TikTok status check failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      data: { status: string; fail_reason?: string };
    };

    return {
      status: data.data.status,
      failReason: data.data.fail_reason,
    };
  }
}
