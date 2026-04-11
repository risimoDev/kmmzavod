/**
 * YouTube Data API v3 client — upload Shorts via resumable upload.
 *
 * Requires OAuth2 access token with `youtube.upload` scope.
 *
 * Flow:
 *  1. POST /youtube/v3/videos?uploadType=resumable (initiate)
 *  2. PUT <upload_url> with video bytes (resumable upload)
 *  3. Returns video ID
 *
 * @see https://developers.google.com/youtube/v3/docs/videos/insert
 */
import fs from 'node:fs';
import axios from 'axios';
import { logger as rootLogger } from '../../logger';
import { axiosProxyConfig } from '../../lib/proxy';

const logger = rootLogger.child({ client: 'youtube' });

const API_BASE = 'https://www.googleapis.com';

export interface YouTubeUploadResult {
  videoId: string;
}

export class YouTubeClient {
  /** Per-account proxy URL override. Set before calling uploadShort/refreshToken. */
  proxyUrl: string | null = null;

  /**
   * Upload a video to YouTube as a Short.
   *
   * @param accessToken  OAuth2 access token with `youtube.upload` scope
   * @param filePath     Path to local .mp4 file
   * @param title        Video title (append " #Shorts" for Shorts classification)
   * @param description  Video description
   * @param tags         Tags array
   */
  async uploadShort(
    accessToken: string,
    filePath: string,
    title: string,
    description: string,
    tags: string[] = [],
  ): Promise<YouTubeUploadResult> {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Ensure #Shorts tag for proper classification
    const shortsTitle = title.includes('#Shorts') ? title : `${title} #Shorts`;
    const shortsTags = tags.includes('Shorts') ? tags : [...tags, 'Shorts'];

    // Step 1: Initiate resumable upload
    const initRes = await axios.post(
      `${API_BASE}/upload/youtube/v3/videos`,
      {
        snippet: {
          title: shortsTitle,
          description,
          tags: shortsTags,
          categoryId: '22', // People & Blogs
          defaultLanguage: 'ru',
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
          embeddable: true,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': fileSize.toString(),
        },
        params: {
          uploadType: 'resumable',
          part: 'snippet,status',
        },
        timeout: 30_000,
        ...axiosProxyConfig(this.proxyUrl),
      },
    );

    const uploadUrl = initRes.headers.location;
    if (!uploadUrl) {
      throw new Error('YouTube: no upload URL in resumable initiation response');
    }

    logger.info({ uploadUrl: uploadUrl.slice(0, 80), fileSize }, 'YouTube: resumable upload initiated');

    // Step 2: Upload file content
    const fileStream = fs.createReadStream(filePath);
    const uploadRes = await axios.put(uploadUrl, fileStream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': fileSize.toString(),
      },
      maxBodyLength: Infinity,
      timeout: 600_000,
      ...axiosProxyConfig(this.proxyUrl),
    });

    const videoId = uploadRes.data?.id;
    if (!videoId) {
      throw new Error('YouTube: upload succeeded but no video ID returned');
    }

    logger.info({ videoId }, 'YouTube: video uploaded successfully');
    return { videoId };
  }

  /**
   * Refresh an OAuth2 access token using a refresh token.
   */
  async refreshToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }, axiosProxyConfig(this.proxyUrl));

    return {
      accessToken: res.data.access_token,
      expiresIn: res.data.expires_in,
    };
  }
}
