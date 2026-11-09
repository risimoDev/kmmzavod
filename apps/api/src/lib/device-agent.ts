import axios, { type AxiosRequestConfig } from 'axios';
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

export async function agentGet<T = any>(path: string, options?: AxiosRequestConfig): Promise<T> {
  return requestWithFallback((base) => axios.get(`${base}${path}`, options));
}

export async function agentPost<T = any>(path: string, data?: any, options?: AxiosRequestConfig): Promise<T> {
  return requestWithFallback((base) => axios.post(`${base}${path}`, data, options));
}

export async function requestWithFallbackRaw<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = await getDeviceAgentBaseUrl();
  try {
    return await fn(base);
  } catch (err) {
    const alt = getAlternateUrl(base);
    if (alt && axios.isAxiosError(err) && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH')) {
      try {
        const res = await fn(alt);
        activeBaseUrl = alt;
        lastBaseCheck = Date.now();
        return res;
      } catch {
        // preserve original error
      }
    }
    throw err;
  }
}

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
  trafficSaver?: 'block_media' | 'direct_media' | 'off';
  trafficStandby?: boolean;
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
  const effectiveBase = activeBaseUrl || BASE;
  if (axios.isAxiosError(err)) {
    const code = err.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return `device-agent (${effectiveBase}) не ответил вовремя — операция на плате может ещё выполняться. Обновите статус через несколько секунд.`;
    }
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
      return `device-agent недоступен по адресу ${effectiveBase} (${code}). ` +
        `Убедитесь, что AmneziaWG туннель поднят, в iptables на сервере включен MASQUERADE для awg0, и device-agent запущен на ПК с фермой телефонов.`;
    }
    const status = err.response?.status;
    const data = err.response?.data as { detail?: string; error?: unknown; message?: string } | string | undefined;
    if (status === 404) {
      const routeMsg = typeof data === 'object' && data?.message ? `: ${data.message}` : '';
      return `Эндпоинт ${err.config?.url ?? ''} не найден на device-agent (${effectiveBase})${routeMsg}. Перезапустите apps/device-agent на ПК фермы (pnpm --filter @kmmzavod/device-agent run build && pnpm --filter @kmmzavod/device-agent run start).`;
    }
    const body = typeof data === 'string'
      ? data
      : (data?.detail ?? data?.message ?? (data?.error && data.error !== 'Not Found' ? data.error : undefined) ?? err.message);
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
    apps?: Record<string, any>;
    error?: string;
  }> {
    return agentGet('/devices', { timeout: 30_000 });
  },

  /** Verifies the proxy from the farm PC first, then wires the phone and checks its exit IP. */
  async setProxy(
    deviceId: string,
    proxy: DeviceProxyConfig,
    opts: { activate?: boolean; skipTest?: boolean } = {},
  ): Promise<{ ok: boolean; check?: DeviceIpCheckResult; upstream?: UpstreamTestResult; error?: string }> {
    return agentPost('/proxy/set', { deviceId, ...proxy, ...opts }, { timeout: 120_000 });
  },

  /** Check a proxy from the farm PC without touching any phone. */
  async testProxy(proxy: DeviceProxyConfig): Promise<UpstreamTestResult> {
    return agentPost('/proxy/test', proxy, { timeout: 60_000 });
  },

  async getProxyStatus(): Promise<Record<string, unknown>> {
    return agentGet('/proxy/status', { timeout: 10_000 });
  },

  async clearProxy(deviceId: string): Promise<{ ok: boolean; error?: string }> {
    return agentPost('/proxy/clear', { deviceId }, { timeout: 60_000 });
  },

  async checkDeviceIp(deviceId: string): Promise<DeviceIpCheckResult> {
    return agentPost('/proxy/check', { deviceId }, { timeout: 90_000 });
  },

  async getProxyMode(): Promise<ProxyModeState> {
    return agentGet('/proxy/mode', { timeout: 8_000 });
  },

  async setProxyMode(mode: 'shared_sequential' | 'private_parallel', inactivePolicy?: 'direct' | 'block'): Promise<ProxyModeState> {
    return agentPost('/proxy/mode', { mode, inactivePolicy }, { timeout: 30_000 });
  },

  async getTrafficConfig(): Promise<{ ok: boolean; trafficSaver: 'block_media' | 'direct_media' | 'off'; trafficStandby: boolean }> {
    return agentGet('/proxy/traffic', { timeout: 8_000 });
  },

  async setTrafficConfig(
    trafficSaver?: 'block_media' | 'direct_media' | 'off',
    trafficStandby?: boolean,
  ): Promise<{ ok: boolean; trafficSaver: 'block_media' | 'direct_media' | 'off'; trafficStandby: boolean }> {
    return agentPost('/proxy/traffic', { trafficSaver, trafficStandby }, { timeout: 15_000 });
  },

  async optimizeDataSaver(deviceId?: string): Promise<{ ok: boolean; total?: number; successful?: number; results?: any[] }> {
    return agentPost('/proxy/optimize-data-saver', { deviceId }, { timeout: 60_000 });
  },

  async switchActiveProxyDevice(deviceId: string, force?: boolean): Promise<{ ok: boolean; activeDeviceId: string; previousDeviceId?: string }> {
    return agentPost('/proxy/switch-active', { deviceId, force }, { timeout: 60_000 });
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
    return agentPost('/proxy/rotate-ip', { deviceId, rotateUrl, cooldownMs }, { timeout: 120_000 });
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
    return agentPost('/network/restart-interface', opts, { timeout: 30_000 });
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
    return agentPost('/proxy/batch-set', { assignments }, { timeout: 600_000 });
  },

  async batchCheckDeviceIp(deviceIds: string[]): Promise<Array<{ deviceId: string } & DeviceIpCheckResult>> {
    const data = await agentPost<{ results: Array<{ deviceId: string } & DeviceIpCheckResult> }>('/proxy/batch-check', { deviceIds }, { timeout: 600_000 });
    return data.results;
  },

  async viewTarget(opts: ViewTargetOptions): Promise<ViewTargetResult> {
    return agentPost('/view-target', opts, { timeout: 660_000 });
  },

  async wbWarmup(opts: WbWarmupOptions): Promise<WbWarmupResult> {
    return agentPost('/wb/warmup', opts, { timeout: 660_000 });
  },

  async reboot(deviceId: string): Promise<{ ok: boolean; message?: string }> {
    return agentPost('/device/reboot', { deviceId }, { timeout: 10_000 });
  },

  async wake(deviceId: string): Promise<{ ok: boolean; message?: string }> {
    return agentPost('/device/wake', { deviceId }, { timeout: 10_000 });
  },

  async screenshot(deviceId: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return agentPost('/device/screenshot', { deviceId }, { timeout: 15_000 });
  },

  /** Binary screen frame (JPEG/PNG bytes) + full-resolution screen size. */
  async frame(deviceId: string): Promise<{ image: Buffer; contentType: string; width: number; height: number }> {
    try {
      const res = await requestWithFallbackRaw((base) =>
        axios.post(`${base}/device/frame`, { deviceId }, { timeout: 15_000, responseType: 'arraybuffer' })
      );
      return {
        image: Buffer.from(res.data),
        contentType: String(res.headers['content-type'] ?? 'image/jpeg'),
        width: Number(res.headers['x-screen-width']) || 0,
        height: Number(res.headers['x-screen-height']) || 0,
      };
    } catch (err) {
      // Error bodies arrive as bytes too — decode the agent's JSON so error messages stay readable.
      const body = axios.isAxiosError(err) ? err.response?.data : undefined;
      if (axios.isAxiosError(err) && err.response && (Buffer.isBuffer(body) || body instanceof ArrayBuffer)) {
        const text = Buffer.from(body as Buffer).toString('utf8');
        try { err.response.data = JSON.parse(text); } catch { err.response.data = text; }
      }
      throw err;
    }
  },

  async heal(deviceId: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    return agentPost('/device/heal', { deviceId }, { timeout: 15_000 });
  },

  async getHealth(deviceId: string): Promise<{ deviceId: string; online: boolean; batteryLevel?: number; batteryTemp?: number; freeRamMb?: number; error?: string }> {
    return agentPost('/device/health', { deviceId }, { timeout: 10_000 });
  },

  async optimizeFarm(deviceIds?: string[]): Promise<{ ok: boolean; total?: number; results?: Array<{ deviceId: string; ok: boolean; message: string }> }> {
    return agentPost('/farm/optimize', { deviceIds }, { timeout: 30_000 });
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
    return agentPost('/device/control/tap', opts, { timeout: 15_000 });
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
    return agentPost('/device/control/swipe', opts, { timeout: 15_000 });
  },

  async key(opts: {
    deviceId: string;
    key: 'home' | 'back' | 'recents' | 'power' | 'wake' | 'volup' | 'voldown' | number;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    return agentPost('/device/control/key', opts, { timeout: 15_000 });
  },

  async text(opts: {
    deviceId: string;
    text: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    return agentPost('/device/control/text', opts, { timeout: 15_000 });
  },

  async openApp(opts: {
    deviceId: string;
    packageName: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    return agentPost('/device/control/open-app', opts, { timeout: 15_000 });
  },

  async setOrientation(opts: {
    deviceId: string;
    orientation: 0 | 1;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; orientation?: number; error?: string }> {
    return agentPost('/device/control/orientation', opts, { timeout: 15_000 });
  },

  async acceptDialog(opts: {
    deviceId: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    return agentPost('/device/control/accept-dialog', opts, { timeout: 15_000 });
  },

  async grantPermissions(opts: {
    deviceId: string;
    packageName?: string;
    targetDeviceIds?: string[];
  }): Promise<{ ok: boolean; targetsCount?: number; successful?: number; error?: string }> {
    return agentPost('/device/control/grant-permissions', opts, { timeout: 15_000 });
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
    return agentPost('/device/apps/install', opts, { timeout: 600_000 });
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
    return agentPost(
      '/device/apps/upload-and-install',
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
    return agentPost('/device/apps/batch-action', opts, { timeout: 120_000 });
  },

  async listApps(deviceId: string, thirdPartyOnly = true): Promise<{
    ok: boolean;
    deviceId: string;
    packages: string[];
    count: number;
  }> {
    return agentPost('/device/apps/list', { deviceId, thirdPartyOnly }, { timeout: 20_000 });
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
    return agentPost('/device/scripts/run', opts, { timeout: 600_000 });
  },

  async loginAccount(opts: {
    deviceId: string;
    platform: 'tiktok' | 'instagram';
    username: string;
    password?: string;
    email?: string;
    emailPassword?: string;
    imapHost?: string;
    imapPort?: number;
  }): Promise<{
    ok: boolean;
    deviceId: string;
    platform: 'tiktok' | 'instagram';
    alreadyLoggedIn?: boolean;
    codeRetrieved?: string;
    detail: string;
    error?: string;
  }> {
    return agentPost('/device/account/login', opts, { timeout: 180_000 });
  },

  async testEmail(opts: {
    email: string;
    password: string;
    host?: string;
    port?: number;
  }): Promise<{ ok: boolean; messageCount?: number; error?: string }> {
    return agentPost('/device/account/test-email', opts, { timeout: 20_000 });
  },

  async getEmailCode(opts: {
    email: string;
    password: string;
    host?: string;
    port?: number;
    platform?: 'tiktok' | 'instagram';
    maxWaitSec?: number;
  }): Promise<{ ok: boolean; code?: string; subject?: string; from?: string; date?: string; error?: string }> {
    return agentPost('/device/account/email-code', opts, { timeout: 120_000 });
  },

  async submitVerificationCode(opts: {
    deviceId: string;
    code: string;
    platform?: 'tiktok' | 'instagram';
  }): Promise<{ ok: boolean; detail: string; error?: string }> {
    return agentPost('/device/account/submit-code', opts, { timeout: 30_000 });
  },

  async checkApps(deviceId: string): Promise<{
    ok: boolean;
    deviceId: string;
    apps: Record<string, { installed: boolean; packageName?: string; error?: string }>;
  }> {
    return agentGet(`/device/${encodeURIComponent(deviceId)}/apps-check`, { timeout: 15_000 });
  },
};

