/**
 * Instagram Reels client — publishes videos via Meta Graph API v20.0.
 *
 * Publication flow:
 *  1. POST `/{ig-user-id}/media` — create a Reels media container (video_url must be publicly accessible)
 *  2. Poll `GET /{creation-id}?fields=status_code` until FINISHED or ERROR (max 60 attempts, 10 s delay)
 *  3. POST `/{ig-user-id}/media_publish` — publish with creation_id
 *  4. Return media_id + publish_id
 *
 * Token management:
 *  - `refreshAccessToken()` exchanges a long-lived token for a new one (valid 60 days)
 *
 * @see https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
 * @see https://developers.facebook.com/docs/instagram-api/reference/ig-user/media
 * @see https://developers.facebook.com/docs/instagram-api/reference/ig-user/media_publish
 */
import { logger as rootLogger } from '../../logger';

const log = rootLogger.child({ client: 'instagram' });

const GRAPH_API = 'https://graph.facebook.com/v20.0';

/** Delay between container status polls (ms). */
const POLL_INTERVAL_MS = 10_000;
/** Maximum number of poll attempts before giving up (~10 min). */
const MAX_POLL_ATTEMPTS = 60;
/** Instagram caption hard limit. */
const MAX_CAPTION_LENGTH = 2_200;

export class InstagramClient {
  private appId: string;
  private appSecret: string;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  // ── Token management ──────────────────────────────────────────────────────

  /**
   * Refresh a long-lived Instagram user token.
   *
   * Long-lived tokens are valid for 60 days. Calling this endpoint within the
   * last 24 hours of the token's life returns a fresh 60-day token.
   *
   * @see https://developers.facebook.com/docs/instagram-basic-display-api/guides/long-lived-tokens#refresh-a-long-lived-token
   *
   * @param refreshToken Current long-lived token to refresh
   * @returns New access token and its TTL in seconds
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const url = new URL(`${GRAPH_API}/oauth/access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('client_secret', this.appSecret);
    url.searchParams.set('access_token', refreshToken);

    log.debug('Refreshing Instagram access token');

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Instagram token refresh failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    log.info({ expiresIn: data.expires_in }, 'Instagram access token refreshed');

    return { accessToken: data.access_token, expiresIn: data.expires_in };
  }

  // ── Reel upload ───────────────────────────────────────────────────────────

  /**
   * Upload and publish a video as an Instagram Reel.
   *
   * `videoPath` should be a **publicly accessible URL** (e.g. a presigned MinIO
   * URL with a 1-hour TTL). The Meta API fetches the video from this URL — it
   * does NOT accept direct file uploads for Reels.
   *
   * @param accessToken  Long-lived Instagram user token
   * @param igUserId     Instagram Business Account ID
   * @param videoPath    Public URL to the mp4 file
   * @param caption      Reel caption (max 2 200 chars)
   * @param hashtags     Optional hashtags (appended to caption)
   * @returns mediaId (published post) and publishId (creation container)
   */
  async uploadReel(
    accessToken: string,
    igUserId: string,
    videoPath: string,
    caption: string,
    hashtags?: string[],
  ): Promise<{ mediaId: string; publishId: string }> {
    // ── 1. Build caption with hashtags ────────────────────────────────────
    let fullCaption = caption;
    if (hashtags && hashtags.length > 0) {
      const tagString = hashtags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
      fullCaption = `${caption}\n\n${tagString}`;
    }
    fullCaption = fullCaption.slice(0, MAX_CAPTION_LENGTH);

    // ── 2. Create media container ────────────────────────────────────────
    const createUrl = new URL(`${GRAPH_API}/${igUserId}/media`);
    createUrl.searchParams.set('media_type', 'REELS');
    createUrl.searchParams.set('video_url', videoPath);
    createUrl.searchParams.set('caption', fullCaption);
    createUrl.searchParams.set('share_to_feed', 'true');
    createUrl.searchParams.set('access_token', accessToken);

    log.info({ igUserId }, 'Creating Instagram Reels media container');

    const createRes = await fetch(createUrl.toString(), { method: 'POST' });
    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`Instagram create container failed (${createRes.status}): ${body}`);
    }

    const { id: creationId } = (await createRes.json()) as { id: string };
    log.info({ creationId }, 'Instagram media container created');

    // ── 3. Poll until container is ready ─────────────────────────────────
    await this.pollContainerStatus(accessToken, creationId);

    // ── 4. Publish ───────────────────────────────────────────────────────
    const publishUrl = new URL(`${GRAPH_API}/${igUserId}/media_publish`);
    publishUrl.searchParams.set('creation_id', creationId);
    publishUrl.searchParams.set('access_token', accessToken);

    log.info({ creationId }, 'Publishing Instagram Reel');

    const publishRes = await fetch(publishUrl.toString(), { method: 'POST' });
    if (!publishRes.ok) {
      const body = await publishRes.text();
      throw new Error(`Instagram publish failed (${publishRes.status}): ${body}`);
    }

    const { id: mediaId } = (await publishRes.json()) as { id: string };
    log.info({ mediaId, creationId }, 'Instagram Reel published successfully');

    return { mediaId, publishId: creationId };
  }

  // ── Status check ──────────────────────────────────────────────────────────

  /**
   * Check the processing status of a media container.
   *
   * Possible `status_code` values: IN_PROGRESS, FINISHED, ERROR, EXPIRED.
   *
   * @see https://developers.facebook.com/docs/instagram-api/reference/ig-container
   *
   * @param accessToken  Long-lived Instagram user token
   * @param _igUserId    Instagram Business Account ID (unused, kept for interface symmetry)
   * @param creationId   Media container (creation) ID
   * @returns Current processing status and optional error message
   */
  async checkPublishStatus(
    accessToken: string,
    _igUserId: string,
    creationId: string,
  ): Promise<{ status: string; error?: string }> {
    const url = new URL(`${GRAPH_API}/${creationId}`);
    url.searchParams.set('fields', 'status_code,status');
    url.searchParams.set('access_token', accessToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Instagram status check failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { status_code: string; status?: string };

    return {
      status: data.status_code,
      ...(data.status_code === 'ERROR' && { error: data.status ?? 'Unknown processing error' }),
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Poll container status until FINISHED or ERROR.
   *
   * @throws If container errors out or exceeds MAX_POLL_ATTEMPTS
   */
  private async pollContainerStatus(accessToken: string, creationId: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const { status, error } = await this.checkPublishStatus(accessToken, '', creationId);

      if (status === 'FINISHED') {
        log.info({ creationId, attempt }, 'Instagram container ready');
        return;
      }

      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new Error(`Instagram container ${creationId} failed: ${error ?? status}`);
      }

      log.debug({ creationId, status, attempt }, 'Waiting for Instagram container');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(
      `Instagram container ${creationId} not ready after ${MAX_POLL_ATTEMPTS} attempts (~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60_000} min)`,
    );
  }
}
