import axios from 'axios';
import { config } from '../config';

const BASE = config.DEVICE_AGENT_URL.replace(/\/+$/, '');

export interface DeviceProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type?: 'http' | 'https' | 'socks5' | 'residential' | 'mobile';
  rotateUrl?: string;
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
        `Убедитесь, что AmneziaWG туннель поднят, в iptables на сервере включен MASQUERADE для awg0, и device-agent запущен на ПК с фермой телефонов.`;
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

  async rotateProxyIp(deviceId: string, rotateUrl?: string, cooldownMs?: number): Promise<{
    ok: boolean;
    deviceId: string;
    rotateUrl: string;
    statusCode?: number;
    rotateResponse?: string;
    check: DeviceIpCheckResult;
    error?: string;
  }> {
    const res = await axios.post(`${BASE}/proxy/rotate-ip`, { deviceId, rotateUrl, cooldownMs }, { timeout: 35_000 });
    return res.data;
  },

  async restartNetworkInterface(opts: {
    deviceId: string;
    mode?: 'ethernet' | 'wifi' | 'all';
    targetDeviceIds?: string[];
  }): Promise<{
    ok: boolean;
    total: number;
    successful: number;
    failed: number;
    results: Array<{
      deviceId: string;
      mode: string;
      ok: boolean;
      log: string;
    }>;
  }> {
    const res = await axios.post(`${BASE}/network/restart-interface`, opts, { timeout: 30_000 });
    return res.data;
  },

  async batchSetProxy(assignments: Array<{
    deviceId: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    type?: 'http' | 'https' | 'socks5' | 'residential' | 'mobile';
    rotateUrl?: string;
  }>): Promise<{
    ok: boolean;
    total: number;
    successful: number;
    failed: number;
    results: Array<{
      deviceId: string;
      ok: boolean;
      check?: DeviceIpCheckResult;
      error?: string;
    }>;
  }> {
    const res = await axios.post(`${BASE}/proxy/batch-set`, { assignments }, { timeout: 60_000 });
    return res.data;
  },

  async batchCheckDeviceIp(deviceIds: string[]): Promise<Array<{ deviceId: string } & DeviceIpCheckResult>> {
    const results = await Promise.allSettled(
      deviceIds.map(async (id) => {
        const check = await this.checkDeviceIp(id);
        return { deviceId: id, ...check };
      })
    );
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        deviceId: deviceIds[i],
        ok: false,
        leakDetected: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });
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

  async tap(opts: {
    deviceId: string;
    x?: number;
    y?: number;
    xPercent?: number;
    yPercent?: number;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/tap`, opts, { timeout: 15_000 });
    return res.data;
  },

  async swipe(opts: {
    deviceId: string;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
    x1Percent?: number;
    y1Percent?: number;
    x2Percent?: number;
    y2Percent?: number;
    durationMs?: number;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/swipe`, opts, { timeout: 15_000 });
    return res.data;
  },

  async key(opts: {
    deviceId: string;
    key: 'home' | 'back' | 'recents' | 'power' | 'wake' | 'volup' | 'voldown' | number;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/key`, opts, { timeout: 15_000 });
    return res.data;
  },

  async text(opts: {
    deviceId: string;
    text: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/text`, opts, { timeout: 15_000 });
    return res.data;
  },

  async openApp(opts: {
    deviceId: string;
    packageName: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/open-app`, opts, { timeout: 15_000 });
    return res.data;
  },

  async setOrientation(opts: {
    deviceId: string;
    orientation: 0 | 1;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; orientation?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/orientation`, opts, { timeout: 15_000 });
    return res.data;
  },

  async acceptDialog(opts: {
    deviceId: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/accept-dialog`, opts, { timeout: 15_000 });
    return res.data;
  },

  async grantPermissions(opts: {
    deviceId: string;
    packageName?: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    const res = await axios.post(`${BASE}/device/control/grant-permissions`, opts, { timeout: 15_000 });
    return res.data;
  },

  async installApk(opts: {
    apkUrl: string;
    targetDeviceIds: string[];
    reinstall?: boolean;
    grantPermissions?: boolean;
  }): Promise<{
    ok: boolean;
    total: number;
    successful: number;
    failed: number;
    apkSizeMb?: number;
    results: Array<{
      deviceId: string;
      ok: boolean;
      durationMs: number;
      output: string;
      error?: string;
    }>;
  }> {
    const res = await axios.post(`${BASE}/device/apps/install`, opts, { timeout: 600_000 });
    return res.data;
  },

  async batchAppAction(opts: {
    action: 'uninstall' | 'clear-data' | 'force-stop' | 'launch';
    packageName: string;
    targetDeviceIds: string[];
  }): Promise<{
    ok: boolean;
    action: string;
    packageName: string;
    total: number;
    successful: number;
    failed: number;
    results: Array<{
      deviceId: string;
      ok: boolean;
      output?: string;
      error?: string;
    }>;
  }> {
    const res = await axios.post(`${BASE}/device/apps/batch-action`, opts, { timeout: 120_000 });
    return res.data;
  },

  async listApps(deviceId: string, thirdPartyOnly = true): Promise<{
    ok: boolean;
    deviceId: string;
    packages: string[];
    count: number;
  }> {
    const res = await axios.post(`${BASE}/device/apps/list`, { deviceId, thirdPartyOnly }, { timeout: 20_000 });
    return res.data;
  },

  async runScript(opts: {
    engine: 'adb_flow' | 'autojs';
    steps?: any[];
    jsCode?: string;
    targetDeviceIds: string[];
    variables?: Record<string, string>;
    scriptName?: string;
  }): Promise<{
    ok: boolean;
    engine: 'adb_flow' | 'autojs';
    targetsCount: number;
    successful: number;
    failed: number;
    devices: Record<string, {
      serial: string;
      ok: boolean;
      stepsExecuted: number;
      totalSteps: number;
      totalDurationMs: number;
      stepLogs: Array<{
        stepIndex: number;
        type: string;
        description: string;
        status: 'success' | 'failed' | 'skipped';
        durationMs: number;
        error?: string;
      }>;
      error?: string;
    }>;
  }> {
    const res = await axios.post(`${BASE}/device/scripts/run`, opts, { timeout: 600_000 });
    return res.data;
  },
};

