/**
 * Instagram Reels клиент через Meta Graph API.
 * Публикает видео как Рилс через двухэтапный процесс:
 *   1) POST /me/media  — создаёт контейнер
 *   2) POST /me/media_publish — финализирует публикацию
 *
 * @see https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
 */
import { logger as rootLogger } from '../../logger';

const logger = rootLogger.child({ client: 'instagram' });

const GRAPH_API = 'https://graph.instagram.com/v21.0';

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 60; // 5 мин макс

export interface InstagramUploadResult {
  mediaId: string;
}

export class InstagramClient {
  /**
   * Загружает видео как Reel в Instagram.
   *
   * @param accessToken — долгоживущий токен (Long-Lived User Token)
   * @param igUserId    — Instagram Business account ID
   * @param videoUrl    — публично доступный URL видео (presigned MinIO или CDN)
   * @param caption     — подпись к Рилс
   */
  async uploadReel(
    accessToken: string,
    igUserId: string,
    videoUrl: string,
    caption: string,
  ): Promise<InstagramUploadResult> {
    // Step 1 — создаём media container
    const createUrl = new URL(`${GRAPH_API}/${igUserId}/media`);
    createUrl.searchParams.set('media_type', 'REELS');
    createUrl.searchParams.set('video_url', videoUrl);
    createUrl.searchParams.set('caption', caption.slice(0, 2200));
    createUrl.searchParams.set('access_token', accessToken);

    const createRes = await fetch(createUrl.toString(), { method: 'POST' });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Instagram create container failed: ${createRes.status} ${text}`);
    }

    const createData = await createRes.json() as { id: string };
    const containerId = createData.id;
    logger.info({ containerId }, 'Instagram media container created');

    // Step 2 — poll until container is ready
    await this.waitForContainer(accessToken, containerId);

    // Step 3 — publish
    const publishUrl = new URL(`${GRAPH_API}/${igUserId}/media_publish`);
    publishUrl.searchParams.set('creation_id', containerId);
    publishUrl.searchParams.set('access_token', accessToken);

    const publishRes = await fetch(publishUrl.toString(), { method: 'POST' });
    if (!publishRes.ok) {
      const text = await publishRes.text();
      throw new Error(`Instagram publish failed: ${publishRes.status} ${text}`);
    }

    const publishData = await publishRes.json() as { id: string };
    logger.info({ mediaId: publishData.id }, 'Instagram Reel published');

    return { mediaId: publishData.id };
  }

  /**
   * Ожидает готовности media container (статус FINISHED).
   */
  private async waitForContainer(accessToken: string, containerId: string): Promise<void> {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const url = new URL(`${GRAPH_API}/${containerId}`);
      url.searchParams.set('fields', 'status_code');
      url.searchParams.set('access_token', accessToken);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Instagram status check failed: ${res.status} ${text}`);
      }

      const data = await res.json() as { status_code: string };

      if (data.status_code === 'FINISHED') {
        return;
      }

      if (data.status_code === 'ERROR') {
        throw new Error('Instagram media container processing failed');
      }

      logger.debug({ containerId, status: data.status_code, attempt: i + 1 }, 'Waiting for container');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(`Instagram container ${containerId} not ready after ${MAX_POLL_ATTEMPTS} attempts`);
  }

  /**
   * Обменивает short-lived token на long-lived (60 дней).
   */
  async exchangeForLongLivedToken(
    shortLivedToken: string,
    appSecret: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = new URL(`${GRAPH_API}/access_token`);
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('access_token', shortLivedToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Instagram long-lived token exchange failed: ${res.status} ${text}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  }
}
