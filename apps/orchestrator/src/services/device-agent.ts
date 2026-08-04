/**
 * Client for apps/device-agent — the bridge running on the home PC that talks to
 * Laixi Master (real Android phone farm) over AmneziaWG. See
 * docs/PHONE_FARM_INTEGRATION_PLAN.md.
 *
 * Unlike the private publisher (instagrapi/tiktok-uploader), this path has no
 * session state to persist — the phone's own logged-in app IS the session.
 */
import axios from 'axios';
import { config } from '../config';

const BASE = config.DEVICE_AGENT_URL.replace(/\/+$/, '');

export interface DevicePublishResult {
  ok: boolean;
  detail?: string;
}

/** Extract a precise, actionable message from an axios/other error. */
export function describeDeviceAgentError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const code = err.code;
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return `device-agent unreachable at ${BASE} (${code}). ` +
        `Is the AmneziaWG tunnel up and device-agent running on the home PC? See infra/amneziawg/README.md`;
    }
    const status = err.response?.status;
    const data = err.response?.data as { detail?: string; error?: unknown } | string | undefined;
    const body = typeof data === 'string' ? data : (data?.detail ?? data?.error ?? err.message);
    return `HTTP ${status ?? '?'}: ${JSON.stringify(body).slice(0, 800)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function checkDeviceAgentHealth(): Promise<string | null> {
  try {
    await axios.get(`${BASE}/health`, { timeout: 5_000 });
    return null;
  } catch (err: unknown) {
    return describeDeviceAgentError(err);
  }
}

export const deviceAgentService = {
  async publish(opts: {
    deviceId: string;
    platform: 'instagram' | 'tiktok';
    videoUrl: string;
    caption: string;
  }): Promise<DevicePublishResult> {
    const res = await axios.post(`${BASE}/publish`, {
      deviceId: opts.deviceId,
      platform: opts.platform,
      videoUrl: opts.videoUrl,
      caption: opts.caption,
    }, { timeout: 300_000 });
    return { ok: res.data.ok, detail: res.data.detail };
  },
};
