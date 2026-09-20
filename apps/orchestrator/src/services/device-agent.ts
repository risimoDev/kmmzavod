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

export interface DeviceProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type?: 'http' | 'https' | 'socks5' | 'residential' | 'mobile';
}

export interface DeviceIpCheckResult {
  ok: boolean;
  ip?: string;
  country?: string;
  city?: string;
  isp?: string;
  leakDetected: boolean;
  hostIp?: string;
  error?: string;
}

export interface ViewTargetOptions {
  deviceId: string;
  platform: 'instagram' | 'tiktok';
  targetUsername: string;
  watchDurationSeconds?: number;
  scrollCount?: number;
  likeProbability?: number;
  checkIpFirst?: boolean;
}

export interface ViewTargetResult {
  ok: boolean;
  detail?: string;
  ipCheck?: DeviceIpCheckResult;
  stats?: {
    platform: string;
    targetUsername: string;
    scrollCount: number;
    baseWatchSeconds: number;
  };
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
    platform: 'instagram' | 'tiktok' | 'youtube_shorts';
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

  async listDevices(): Promise<{ ok: boolean; raw?: unknown; proxies?: Record<string, DeviceProxyConfig>; error?: string }> {
    const res = await axios.get(`${BASE}/devices`, { timeout: 10_000 });
    return res.data;
  },

  async setProxy(deviceId: string, proxy: DeviceProxyConfig): Promise<{ ok: boolean; check?: DeviceIpCheckResult; error?: string }> {
    const res = await axios.post(`${BASE}/proxy/set`, {
      deviceId,
      ...proxy,
    }, { timeout: 20_000 });
    return res.data;
  },

  async clearProxy(deviceId: string): Promise<{ ok: boolean; error?: string }> {
    const res = await axios.post(`${BASE}/proxy/clear`, { deviceId }, { timeout: 10_000 });
    return res.data;
  },

  async checkDeviceIp(deviceId: string): Promise<DeviceIpCheckResult> {
    const res = await axios.post(`${BASE}/proxy/check`, { deviceId }, { timeout: 15_000 });
    return res.data;
  },

  async viewTarget(opts: ViewTargetOptions): Promise<ViewTargetResult> {
    const res = await axios.post(`${BASE}/view-target`, opts, { timeout: 360_000 });
    return res.data;
  },

  async reboot(deviceId: string): Promise<{ ok: boolean; message?: string }> {
    const res = await axios.post(`${BASE}/device/reboot`, { deviceId }, { timeout: 10_000 });
    return res.data;
  },

  async wake(deviceId: string): Promise<{ ok: boolean; message?: string }> {
    const res = await axios.post(`${BASE}/device/wake`, { deviceId }, { timeout: 10_000 });
    return res.data;
  },

  async screenshot(deviceId: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const res = await axios.post(`${BASE}/device/screenshot`, { deviceId }, { timeout: 15_000 });
    return res.data;
  },

  async heal(deviceId: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    const res = await axios.post(`${BASE}/device/heal`, { deviceId }, { timeout: 15_000 });
    return res.data;
  },

  async getHealth(deviceId: string): Promise<{ deviceId: string; online: boolean; batteryLevel?: number; batteryTemp?: number; freeRamMb?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/health`, { deviceId }, { timeout: 10_000 });
    return res.data;
  },

  async optimizeFarm(deviceIds?: string[]): Promise<{ ok: boolean; total?: number; results?: Array<{ deviceId: string; ok: boolean; message: string }> }> {
    const res = await axios.post(`${BASE}/farm/optimize`, { deviceIds }, { timeout: 30_000 });
    return res.data;
  },
};

