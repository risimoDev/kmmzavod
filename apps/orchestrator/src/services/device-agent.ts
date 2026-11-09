/**
 * Client for apps/device-agent — the bridge running on the home PC that drives the
 * Android phone farm over native ADB, reached over AmneziaWG. See
 * docs/PHONE_FARM_INTEGRATION_PLAN.md.
 *
 * Unlike the private publisher (instagrapi/tiktok-uploader), this path has no
 * session state to persist — the phone's own logged-in app IS the session.
 */
import axios from 'axios';
import { config } from '../config';

const BASE = config.DEVICE_AGENT_URL.replace(/\/+$/, '');

let activeBaseUrl: string | null = null;
let lastBaseCheck = 0;

export async function getDeviceAgentBaseUrl(): Promise<string> {
  const configured = config.DEVICE_AGENT_URL.replace(/\/+$/, '');
  const now = Date.now();
  if (activeBaseUrl && now - lastBaseCheck < 60_000) {
    return activeBaseUrl;
  }

  const candidates: string[] = [configured];
  if (configured.includes('10.66.66.2')) {
    candidates.push(configured.replace('10.66.66.2', '10.13.13.2'));
  } else if (configured.includes('10.13.13.2')) {
    candidates.push(configured.replace('10.13.13.2', '10.66.66.2'));
  }

  for (const c of candidates) {
    try {
      const res = await axios.get(`${c}/health`, { timeout: 2500 });
      if (res.status === 200) {
        activeBaseUrl = c;
        lastBaseCheck = now;
        return c;
      }
    } catch {
      // try next
    }
  }

  return activeBaseUrl || configured;
}

function getAlternateUrl(currentUrl: string): string | null {
  if (currentUrl.includes('10.66.66.2')) return currentUrl.replace('10.66.66.2', '10.13.13.2');
  if (currentUrl.includes('10.13.13.2')) return currentUrl.replace('10.13.13.2', '10.66.66.2');
  return null;
}

export async function requestWithFallback<T>(fn: (base: string) => Promise<{ data: T }>): Promise<T> {
  const base = await getDeviceAgentBaseUrl();
  try {
    const res = await fn(base);
    return res.data;
  } catch (err) {
    const alt = getAlternateUrl(base);
    if (alt && axios.isAxiosError(err) && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH')) {
      try {
        const res = await fn(alt);
        activeBaseUrl = alt;
        lastBaseCheck = Date.now();
        return res.data;
      } catch {
        // preserve original error
      }
    }
    throw err;
  }
}

export interface DevicePublishResult {
  ok: boolean;
  detail?: string;
  stage?: string;
  /** no = nothing reached the platform (retry is safe); unknown = Share tapped, not confirmed. */
  posted?: 'yes' | 'no' | 'unknown';
  retryable?: boolean;
  verified?: { app: boolean; profile: boolean | null };
  captionTyped?: boolean;
  debugSnapshot?: string;
  exitIp?: string;
  country?: string;
}

/**
 * The agent walks the app, waits for the upload and re-checks the profile:
 * up to ~3 min compose + 8 min upload + ~1.5 min verification + download/push.
 */
export const DEVICE_PUBLISH_TIMEOUT_MS = 20 * 60_000;

export interface DeviceProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type?: 'http' | 'https' | 'socks5' | 'residential' | 'mobile';
  rotateUrl?: string;
}

export interface ProxyModeState {
  ok: boolean;
  mode: 'shared_sequential' | 'private_parallel';
  inactivePolicy: 'direct' | 'block';
  trafficSaver?: 'block_media' | 'direct_media' | 'off';
  trafficStandby?: boolean;
  activeDeviceId: string | null;
  busyDeviceId?: string | null;
  hasSharedProxy: boolean;
}

export interface DeviceIpCheckResult {
  ok: boolean;
  ip?: string;
  country?: string;
  city?: string;
  isp?: string;
  leakDetected: boolean;
  exposesHostIp?: boolean;
  hostIp?: string;
  route?: 'proxy' | 'direct' | 'block' | 'none';
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
  const effectiveBase = activeBaseUrl || BASE;
  if (axios.isAxiosError(err)) {
    const code = err.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return `device-agent at ${effectiveBase} did not answer in time (${code}) — the phone may still be busy`;
    }
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
      return `device-agent unreachable at ${effectiveBase} (${code}). ` +
        `Is the AmneziaWG tunnel up and device-agent running on the home PC? See infra/amneziawg/README.md`;
    }
    const status = err.response?.status;
    const data = err.response?.data as { detail?: string; error?: unknown } | string | undefined;
    const body = typeof data === 'string' ? data : (data?.detail ?? data?.error ?? err.message);
    return `HTTP ${status ?? '?'}: ${(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 800)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function checkDeviceAgentHealth(): Promise<string | null> {
  try {
    await requestWithFallback((base) => axios.get(`${base}/health`, { timeout: 5_000 }));
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
    username?: string;
  }): Promise<DevicePublishResult> {
    return requestWithFallback((base) =>
      axios.post(`${base}/publish`, {
        deviceId: opts.deviceId,
        platform: opts.platform,
        videoUrl: opts.videoUrl,
        caption: opts.caption,
        username: opts.username,
        // The agent refuses to open the app if the phone would post from the farm's own IP.
        checkIpFirst: true,
      }, { timeout: DEVICE_PUBLISH_TIMEOUT_MS })
    );
  },

  async listDevices(): Promise<{ ok: boolean; raw?: unknown; proxies?: Record<string, DeviceProxyConfig>; apps?: Record<string, any>; error?: string }> {
    return requestWithFallback((base) => axios.get(`${base}/devices`, { timeout: 30_000 }));
  },

  async setProxy(deviceId: string, proxy: DeviceProxyConfig): Promise<{ ok: boolean; check?: DeviceIpCheckResult; error?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/proxy/set`, {
      deviceId,
      ...proxy,
    }, { timeout: 120_000 }));
  },

  async clearProxy(deviceId: string): Promise<{ ok: boolean; error?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/proxy/clear`, { deviceId }, { timeout: 60_000 }));
  },

  async checkDeviceIp(deviceId: string): Promise<DeviceIpCheckResult> {
    return requestWithFallback((base) => axios.post(`${base}/proxy/check`, { deviceId }, { timeout: 90_000 }));
  },

  async viewTarget(opts: ViewTargetOptions): Promise<ViewTargetResult> {
    return requestWithFallback((base) => axios.post(`${base}/view-target`, opts, { timeout: 660_000 }));
  },

  async reboot(deviceId: string): Promise<{ ok: boolean; message?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/device/reboot`, { deviceId }, { timeout: 10_000 }));
  },

  async wake(deviceId: string): Promise<{ ok: boolean; message?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/device/wake`, { deviceId }, { timeout: 10_000 }));
  },

  async screenshot(deviceId: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/device/screenshot`, { deviceId }, { timeout: 15_000 }));
  },

  async heal(deviceId: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/device/heal`, { deviceId }, { timeout: 15_000 }));
  },

  async getHealth(deviceId: string): Promise<{ deviceId: string; online: boolean; batteryLevel?: number; batteryTemp?: number; freeRamMb?: number; error?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/device/health`, { deviceId }, { timeout: 10_000 }));
  },

  async optimizeFarm(deviceIds?: string[]): Promise<{ ok: boolean; total?: number; results?: Array<{ deviceId: string; ok: boolean; message: string }> }> {
    return requestWithFallback((base) => axios.post(`${base}/farm/optimize`, { deviceIds }, { timeout: 30_000 }));
  },

  async checkApps(deviceId: string): Promise<{
    ok: boolean;
    deviceId: string;
    apps: Record<string, { installed: boolean; packageName?: string; error?: string }>;
  }> {
    return requestWithFallback((base) => axios.get(`${base}/device/${encodeURIComponent(deviceId)}/apps-check`, { timeout: 15_000 }));
  },

  async getProxyMode(): Promise<ProxyModeState> {
    return requestWithFallback((base) => axios.get(`${base}/proxy/mode`, { timeout: 8_000 }));
  },

  async switchActiveDevice(deviceId: string, force = true): Promise<{ ok: boolean; activeDeviceId: string; previousDeviceId?: string }> {
    return requestWithFallback((base) => axios.post(`${base}/proxy/switch-active`, { deviceId, force }, { timeout: 60_000 }));
  },

  async rotateProxyIp(deviceId: string, rotateUrl?: string, cooldownMs?: number): Promise<{
    ok: boolean;
    deviceId: string;
    rotateUrl: string;
    statusCode?: number;
    rotateResponse?: string;
    check: DeviceIpCheckResult;
    error?: string;
  }> {
    return requestWithFallback((base) => axios.post(`${base}/proxy/rotate-ip`, { deviceId, rotateUrl, cooldownMs }, { timeout: 120_000 }));
  },
};

