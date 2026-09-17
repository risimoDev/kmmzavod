import axios from 'axios';
import { config } from '../config';

const BASE = config.DEVICE_AGENT_URL.replace(/\/+$/, '');

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
    likesGiven?: number;
  };
}

export interface WbWarmupOptions {
  deviceId: string;
  sku: string | number;
  dwellDurationSeconds?: number;
  swipePhotos?: boolean;
  readReviews?: boolean;
  addToFavorites?: boolean;
  checkIpFirst?: boolean;
}

export interface WbWarmupResult {
  ok: boolean;
  sku: string;
  detail?: string;
  ipCheck?: DeviceIpCheckResult;
  stats?: {
    dwellSeconds: number;
    photosSwiped: number;
    addedToFavorites: boolean;
  };
}

export function describeDeviceAgentError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const code = err.code;
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return `device-agent недоступен по адресу ${BASE} (${code}). ` +
        `Убедитесь, что AmneziaWG туннель поднят и device-agent запущен на ПК с фермой телефонов.`;
    }
    const status = err.response?.status;
    const data = err.response?.data as { detail?: string; error?: unknown } | string | undefined;
    const body = typeof data === 'string' ? data : (data?.detail ?? data?.error ?? err.message);
    return `HTTP ${status ?? '?'}: ${JSON.stringify(body).slice(0, 800)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export const deviceAgentClient = {
  async listDevices(): Promise<{ ok: boolean; raw?: unknown; proxies?: Record<string, DeviceProxyConfig>; error?: string }> {
    const res = await axios.get(`${BASE}/devices`, { timeout: 8_000 });
    return res.data;
  },

  async setProxy(deviceId: string, proxy: DeviceProxyConfig): Promise<{ ok: boolean; check?: DeviceIpCheckResult; error?: string }> {
    const res = await axios.post(`${BASE}/proxy/set`, {
      deviceId,
      ...proxy,
    }, { timeout: 25_000 });
    return res.data;
  },

  async clearProxy(deviceId: string): Promise<{ ok: boolean; error?: string }> {
    const res = await axios.post(`${BASE}/proxy/clear`, { deviceId }, { timeout: 10_000 });
    return res.data;
  },

  async checkDeviceIp(deviceId: string): Promise<DeviceIpCheckResult> {
    const res = await axios.post(`${BASE}/proxy/check`, { deviceId }, { timeout: 20_000 });
    return res.data;
  },

  async viewTarget(opts: ViewTargetOptions): Promise<ViewTargetResult> {
    const res = await axios.post(`${BASE}/view-target`, opts, { timeout: 360_000 });
    return res.data;
  },

  async wbWarmup(opts: WbWarmupOptions): Promise<WbWarmupResult> {
    const res = await axios.post(`${BASE}/wb/warmup`, opts, { timeout: 360_000 });
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
