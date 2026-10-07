import axios from 'axios';
import { config } from '../config';

const BASE = config.DEVICE_AGENT_URL.replace(/\/+$/, '');

export type ProxyType = 'http' | 'https' | 'socks5' | 'residential' | 'mobile';

export interface DeviceProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type?: ProxyType;
  rotateUrl?: string;
}

/** Proxy config as returned by the agent — passwords never leave the farm PC. */
export interface MaskedDeviceProxyConfig extends Omit<DeviceProxyConfig, 'password'> {
  hasPassword?: boolean;
}

export type DeviceRoute = 'proxy' | 'direct' | 'block' | 'none';

export interface DeviceIpCheckResult {
  ok: boolean;
  ip?: string;
  country?: string;
  city?: string;
  isp?: string;
  /** Must be proxied but exits via the farm PC's own IP. */
  leakDetected: boolean;
  /** Exits via the farm PC's own IP (expected when route is direct/none). */
  exposesHostIp?: boolean;
  hostIp?: string;
  route?: DeviceRoute;
  method?: 'transparent' | 'system_proxy';
  error?: string;
}

export interface UpstreamTestResult {
  ok: boolean;
  upstream?: string;
  protocol?: 'http' | 'socks5';
  ip?: string;
  latencyMs: number;
  error?: string;
  code?: string;
}

export interface ProxyModeState {
  ok: boolean;
  mode: 'shared_sequential' | 'private_parallel';
  inactivePolicy: 'direct' | 'block';
  activeDeviceId: string | null;
  busyDeviceId?: string | null;
  hasSharedProxy: boolean;
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
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return `device-agent (${BASE}) не ответил вовремя — операция на плате может ещё выполняться. Обновите статус через несколько секунд.`;
    }
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
      return `device-agent недоступен по адресу ${BASE} (${code}). ` +
        `Убедитесь, что AmneziaWG туннель поднят, в iptables на сервере включен MASQUERADE для awg0, и device-agent запущен на ПК с фермой телефонов.`;
    }
    const status = err.response?.status;
    const data = err.response?.data as { detail?: string; error?: unknown; message?: string } | string | undefined;
    const body = typeof data === 'string' ? data : (data?.detail ?? data?.error ?? data?.message ?? err.message);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return status && status >= 500 ? `device-agent: ${text.slice(0, 800)}` : text.slice(0, 800);
  }
  return err instanceof Error ? err.message : String(err);
}

/** HTTP status to relay to the browser: agent validation/proxy errors stay 4xx, transport errors become 502. */
export function deviceAgentErrorStatus(err: unknown): number {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status && status >= 400 && status < 500) return status;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 504;
  }
  return 502;
}

export const deviceAgentClient = {
  async listDevices(): Promise<{
    ok: boolean;
    raw?: unknown;
    proxies?: Record<string, MaskedDeviceProxyConfig>;
    proxyStatus?: Record<string, { route: DeviceRoute; method: string | null; applyError?: string; transparentError?: string; gateway?: { activeConnections: number; lastError?: string } }>;
    proxyMode?: Omit<ProxyModeState, 'ok'>;
    error?: string;
  }> {
    const res = await axios.get(`${BASE}/devices`, { timeout: 8_000 });
    return res.data;
  },

  /** Verifies the proxy from the farm PC first, then wires the phone and checks its exit IP. */
  async setProxy(
    deviceId: string,
    proxy: DeviceProxyConfig,
    opts: { activate?: boolean; skipTest?: boolean } = {},
  ): Promise<{ ok: boolean; check?: DeviceIpCheckResult; upstream?: UpstreamTestResult; error?: string }> {
    const res = await axios.post(`${BASE}/proxy/set`, { deviceId, ...proxy, ...opts }, { timeout: 120_000 });
    return res.data;
  },

  /** Check a proxy from the farm PC without touching any phone. */
  async testProxy(proxy: DeviceProxyConfig): Promise<UpstreamTestResult> {
    const res = await axios.post(`${BASE}/proxy/test`, proxy, { timeout: 60_000 });
    return res.data;
  },

  async getProxyStatus(): Promise<Record<string, unknown>> {
    const res = await axios.get(`${BASE}/proxy/status`, { timeout: 10_000 });
    return res.data;
  },

  async clearProxy(deviceId: string): Promise<{ ok: boolean; error?: string }> {
    const res = await axios.post(`${BASE}/proxy/clear`, { deviceId }, { timeout: 60_000 });
    return res.data;
  },

  async checkDeviceIp(deviceId: string): Promise<DeviceIpCheckResult> {
    const res = await axios.post(`${BASE}/proxy/check`, { deviceId }, { timeout: 90_000 });
    return res.data;
  },

  async getProxyMode(): Promise<ProxyModeState> {
    const res = await axios.get(`${BASE}/proxy/mode`, { timeout: 8_000 });
    return res.data;
  },

  async setProxyMode(mode: 'shared_sequential' | 'private_parallel', inactivePolicy?: 'direct' | 'block'): Promise<ProxyModeState> {
    const res = await axios.post(`${BASE}/proxy/mode`, { mode, inactivePolicy }, { timeout: 30_000 });
    return res.data;
  },

  async switchActiveProxyDevice(deviceId: string, force?: boolean): Promise<{ ok: boolean; activeDeviceId: string; previousDeviceId?: string }> {
    const res = await axios.post(`${BASE}/proxy/switch-active`, { deviceId, force }, { timeout: 60_000 });
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
    const res = await axios.post(`${BASE}/proxy/rotate-ip`, { deviceId, rotateUrl, cooldownMs }, { timeout: 120_000 });
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

  async batchSetProxy(assignments: Array<{ deviceId: string } & DeviceProxyConfig>): Promise<{
    ok: boolean;
    total: number;
    successful: number;
    failed: number;
    results: Array<{
      deviceId: string;
      ok: boolean;
      error?: string;
      upstream?: { ip?: string; protocol?: 'http' | 'socks5' };
    }>;
  }> {
    const res = await axios.post(`${BASE}/proxy/batch-set`, { assignments }, { timeout: 600_000 });
    return res.data;
  },

  async batchCheckDeviceIp(deviceIds: string[]): Promise<Array<{ deviceId: string } & DeviceIpCheckResult>> {
    const res = await axios.post(`${BASE}/proxy/batch-check`, { deviceIds }, { timeout: 600_000 });
    return res.data.results;
  },

  async viewTarget(opts: ViewTargetOptions): Promise<ViewTargetResult> {
    const res = await axios.post(`${BASE}/view-target`, opts, { timeout: 660_000 });
    return res.data;
  },

  async wbWarmup(opts: WbWarmupOptions): Promise<WbWarmupResult> {
    const res = await axios.post(`${BASE}/wb/warmup`, opts, { timeout: 660_000 });
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
    targetX?: number;
    targetY?: number;
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

  async uploadAndInstallApk(opts: {
    fileData: Buffer | NodeJS.ReadableStream;
    filename?: string;
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
    const { fileData, filename = 'app.apk', targetDeviceIds, reinstall = true, grantPermissions = true } = opts;
    const res = await axios.post(
      `${BASE}/device/apps/upload-and-install`,
      fileData,
      {
        params: {
          targetDeviceIds: targetDeviceIds.join(','),
          filename,
          reinstall: String(reinstall),
          grantPermissions: String(grantPermissions),
        },
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 900_000,
      }
    );
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

