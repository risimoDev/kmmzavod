/**
 * Client for the private publisher microservice (apps/publisher).
 *
 * The publisher is stateless: we pass the account's decrypted session blob, proxy
 * and a presigned video URL; it returns the external post id and a refreshed
 * session blob that the caller must persist (re-encrypted) on the SocialAccount.
 */
import axios from 'axios';
import { config } from '../config';

const BASE = config.PUBLISHER_URL.replace(/\/+$/, '');

export interface PublishResult {
  ok: boolean;
  externalId: string | null;
  sessionData: Record<string, unknown>;
}

export interface WarmupResult {
  ok: boolean;
  actions: number;
  sessionData: Record<string, unknown>;
}

/** Extract a precise message from an axios/other error (status + body). */
export function describePublisherError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { detail?: string } | string | undefined;
    const body = typeof data === 'string' ? data : data?.detail ?? err.message;
    return `HTTP ${status ?? '?'}: ${String(body).slice(0, 800)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export const publisherService = {
  async instagramPublish(opts: {
    videoUrl: string;
    caption: string;
    proxyUrl?: string | null;
    deviceFingerprint?: Record<string, unknown> | null;
    sessionData: Record<string, unknown>;
  }): Promise<PublishResult> {
    const res = await axios.post(`${BASE}/instagram/publish`, {
      video_url: opts.videoUrl,
      caption: opts.caption,
      proxy_url: opts.proxyUrl ?? null,
      device_fingerprint: opts.deviceFingerprint ?? null,
      session_data: opts.sessionData,
    }, { timeout: 600_000 });
    return {
      ok: res.data.ok,
      externalId: res.data.external_id ?? null,
      sessionData: res.data.session_data ?? {},
    };
  },

  async tiktokPublish(opts: {
    videoUrl: string;
    caption: string;
    proxyUrl?: string | null;
    sessionData: Record<string, unknown>;
  }): Promise<PublishResult> {
    const res = await axios.post(`${BASE}/tiktok/publish`, {
      video_url: opts.videoUrl,
      caption: opts.caption,
      proxy_url: opts.proxyUrl ?? null,
      session_data: opts.sessionData,
    }, { timeout: 900_000 });
    return {
      ok: res.data.ok,
      externalId: res.data.external_id ?? null,
      sessionData: res.data.session_data ?? {},
    };
  },

  async instagramWarmup(opts: {
    proxyUrl?: string | null;
    deviceFingerprint?: Record<string, unknown> | null;
    sessionData: Record<string, unknown>;
    likeCount?: number;
  }): Promise<WarmupResult> {
    const res = await axios.post(`${BASE}/instagram/warmup`, {
      proxy_url: opts.proxyUrl ?? null,
      device_fingerprint: opts.deviceFingerprint ?? null,
      session_data: opts.sessionData,
      like_count: opts.likeCount ?? 3,
    }, { timeout: 300_000 });
    return {
      ok: res.data.ok,
      actions: res.data.actions ?? 0,
      sessionData: res.data.session_data ?? {},
    };
  },
};
