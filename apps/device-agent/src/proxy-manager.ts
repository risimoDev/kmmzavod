/**
 * ProxyManager — wires every phone of the rack to its mobile/residential proxy.
 *
 *   app on phone ──► 127.0.0.1:8888 (phone) ──adb reverse──► DeviceProxyListener (PC, per phone)
 *                                                            ├─► upstream proxy (HTTP or SOCKS5, auth)
 *                                                            ├─► direct from the PC
 *                                                            └─► blocked
 *
 * Capture on the phone:
 *   - every phone: Android global HTTP proxy = 127.0.0.1:8888 (apps that honour system proxy);
 *   - rooted phones: additionally iptables → sing-box → 127.0.0.1:8888 for ALL TCP (see root-proxy.ts).
 *
 * Modes:
 *   - private_parallel  — every configured phone goes through its own upstream at the same time;
 *   - shared_sequential — one "active" phone uses the proxy, the rest are routed `direct` or
 *     `block`ed (inactivePolicy). Switching happens inside the PC gateway: no ADB churn.
 *
 * Self-healing: a watchdog re-creates lost `adb reverse` mappings (reboot / USB re-plug),
 * re-applies the system proxy and restarts sing-box when needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import type { Logger } from 'pino';
import { config } from './config';
import type { AdbClient } from './adb-client';
import {
  DeviceProxyListener,
  ProxyError,
  UpstreamProxy,
  extractIp,
  upstreamKey,
  type ListenerStats,
  type ProxyType,
  type RouteDecision,
  type UpstreamProtocol,
  type UpstreamTestResult,
} from './proxy-forwarder';
import { RootTransparentProxy } from './root-proxy';

export { ProxyError } from './proxy-forwarder';

export interface DeviceProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type?: ProxyType;
  rotateUrl?: string;
}

/** Proxy config as exposed over HTTP — never contains the password. */
export interface MaskedProxyConfig extends Omit<DeviceProxyConfig, 'password'> {
  hasPassword: boolean;
}

export type ProxyMode = 'shared_sequential' | 'private_parallel';
/** What non-active phones do in shared_sequential mode. */
export type InactivePolicy = 'direct' | 'block';
/** Where a phone's proxied traffic currently goes. `none` = no proxy configured for it. */
export type DeviceRoute = 'proxy' | 'direct' | 'block' | 'none';
export type CaptureMethod = 'transparent' | 'system_proxy';

export interface DeviceIpCheckResult {
  ok: boolean;
  ip?: string;
  country?: string;
  city?: string;
  isp?: string;
  /** The phone must be proxied but leaves via the farm PC's own public IP. */
  leakDetected: boolean;
  /** The phone leaves via the farm PC's public IP (expected for `direct`/`none` routes). */
  exposesHostIp: boolean;
  hostIp?: string;
  route: DeviceRoute;
  method?: CaptureMethod;
  error?: string;
}

export interface DeviceProxyStatus {
  deviceId: string;
  configured: boolean;
  route: DeviceRoute;
  method: CaptureMethod | null;
  proxy?: MaskedProxyConfig;
  protocol?: UpstreamProtocol | null;
  gatewayPort?: number;
  gateway?: ListenerStats;
  appliedAt?: string;
  applyError?: string;
  transparentError?: string;
}

interface DeviceEntry {
  proxy: DeviceProxyConfig;
  listenPort?: number;
}

interface DeviceRuntime {
  method: CaptureMethod | null;
  appliedAt?: number;
  applyError?: string;
  transparentError?: string;
  nextRetryAt?: number;
}

interface PersistedStateV2 {
  version: 2;
  mode: ProxyMode;
  inactivePolicy: InactivePolicy;
  activeDeviceId: string | null;
  sharedProxy: DeviceProxyConfig | null;
  devices: Record<string, DeviceEntry>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sameEndpoint(a: DeviceProxyConfig | undefined, b: DeviceProxyConfig): boolean {
  return Boolean(a && a.host === b.host && a.port === b.port && (a.username ?? '') === (b.username ?? ''));
}

export function maskProxy(p: DeviceProxyConfig): MaskedProxyConfig {
  const { password, ...rest } = p;
  return { ...rest, hasPassword: Boolean(password) };
}

export class ProxyManager {
  mode: ProxyMode = 'shared_sequential';
  inactivePolicy: InactivePolicy = 'direct';
  activeDeviceId: string | null = null;
  sharedProxy: DeviceProxyConfig | null = null;

  private devices = new Map<string, DeviceEntry>();
  private runtimes = new Map<string, DeviceRuntime>();
  private listeners = new Map<string, DeviceProxyListener>();
  private listenerStarts = new Map<string, Promise<DeviceProxyListener>>();
  private upstreams = new Map<string, UpstreamProxy>();
  private locks = new Map<string, Promise<unknown>>();
  private readonly root: RootTransparentProxy;

  /** Shared-mode lease: a running task (publish / warmup) owns the shared proxy until it finishes. */
  private lease: { deviceId: string; count: number } | null = null;
  private leaseWaiters: Array<() => void> = [];

  private hostPublicIp: string | null = null;
  private lastHostIpCheck = 0;
  private geoCache = new Map<string, { country?: string; city?: string; isp?: string }>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private watchdogRunning = false;

  constructor(
    private readonly adb: AdbClient,
    private readonly logger: Logger,
  ) {
    this.root = new RootTransparentProxy(adb, logger);
    this.loadState();
    this.refreshHostIp().catch(() => {});
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start gateways, wait for USB enumeration, wire every online phone, start the watchdog. */
  async init(): Promise<void> {
    for (const id of this.devices.keys()) {
      await this.ensureListener(id).catch((err) =>
        this.logger.warn({ deviceId: id, err: String(err) }, 'proxy-manager: gateway start failed'),
      );
    }

    if (this.devices.size > 0) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const online = (await this.adb.listDevices()).filter((d) => d.state === 'device');
        if (online.length > 0) break;
        this.logger.info('proxy-manager: waiting for ADB USB device enumeration (2s)...');
        await delay(2000);
      }
      const res = await this.reapplyAll();
      this.logger.info({ mode: this.mode, activeDeviceId: this.activeDeviceId, ...res }, 'proxy-manager: proxies restored');
    }

    this.startWatchdog();
  }

  startWatchdog(): void {
    if (this.watchdogTimer || config.PROXY_WATCHDOG_INTERVAL_MS <= 0) return;
    this.watchdogTimer = setInterval(() => {
      this.watchdogTick().catch((err) => this.logger.warn({ err: String(err) }, 'proxy-manager: watchdog tick failed'));
    }, config.PROXY_WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
  }

  private async watchdogTick(): Promise<void> {
    if (this.watchdogRunning || this.devices.size === 0) return;
    this.watchdogRunning = true;
    try {
      const online = new Set((await this.adb.listDevices()).filter((d) => d.state === 'device').map((d) => d.serial));
      for (const deviceId of this.devices.keys()) {
        if (!online.has(deviceId)) continue;
        const rt = this.runtime(deviceId);
        if (rt.nextRetryAt && Date.now() < rt.nextRetryAt) continue;
        if (await this.isWiringHealthy(deviceId)) continue;
        this.logger.warn({ deviceId }, 'proxy-manager: phone lost its proxy wiring (reboot/USB re-plug?) — re-applying');
        await this.applyDevice(deviceId).catch(() => {});
      }
    } finally {
      this.watchdogRunning = false;
    }
  }

  /** Cheap check without `su`: reverse mapping, system proxy setting, sing-box process. */
  private async isWiringHealthy(deviceId: string): Promise<boolean> {
    const listener = this.listeners.get(deviceId);
    const rt = this.runtime(deviceId);
    if (!listener || !rt.method) return false;
    try {
      const reverse = await this.adb.exec(['-s', deviceId, 'reverse', '--list'], 10_000);
      if (!reverse.includes(`tcp:${config.PROXY_DEVICE_PORT} tcp:${listener.port}`)) return false;
      const out = await this.adb.shell(
        deviceId,
        `settings get global http_proxy; ${rt.method === 'transparent' ? 'pidof sing-box >/dev/null || echo KMM_NO_SINGBOX' : 'true'}`,
        10_000,
      );
      if (!out.includes(`127.0.0.1:${config.PROXY_DEVICE_PORT}`)) return false;
      return !out.includes('KMM_NO_SINGBOX');
    } catch {
      return false;
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private loadState(): void {
    const file = config.PROXY_STATE_FILE;
    try {
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '').trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;

      if (data.version === 2) {
        const s = data as PersistedStateV2;
        if (s.mode === 'shared_sequential' || s.mode === 'private_parallel') this.mode = s.mode;
        if (s.inactivePolicy === 'direct' || s.inactivePolicy === 'block') this.inactivePolicy = s.inactivePolicy;
        this.activeDeviceId = typeof s.activeDeviceId === 'string' ? s.activeDeviceId : null;
        this.sharedProxy = s.sharedProxy ?? null;
        for (const [id, entry] of Object.entries(s.devices ?? {})) {
          if (entry?.proxy?.host && entry.proxy.port) this.devices.set(id, entry);
        }
      } else {
        // v1: { _mode, _activeDeviceId, _sharedProxy, [deviceId]: proxy }
        if (data._mode === 'shared_sequential' || data._mode === 'private_parallel') this.mode = data._mode;
        if (typeof data._activeDeviceId === 'string') this.activeDeviceId = data._activeDeviceId;
        if (data._sharedProxy && typeof data._sharedProxy === 'object') this.sharedProxy = data._sharedProxy;
        for (const [id, cfg] of Object.entries(data)) {
          if (id.startsWith('_')) continue;
          const proxy = cfg as DeviceProxyConfig;
          if (proxy?.host && proxy.port) this.devices.set(id, { proxy });
        }
        this.logger.info({ devices: this.devices.size }, 'proxy-manager: migrated proxy state file to v2');
      }
      if (!this.sharedProxy && this.devices.size > 0) {
        this.sharedProxy = this.devices.values().next().value!.proxy;
      }
    } catch (err) {
      this.logger.warn({ err: String(err), file }, 'proxy-manager: failed to load state file, starting fresh');
    }
  }

  private saveState(): void {
    const state: PersistedStateV2 = {
      version: 2,
      mode: this.mode,
      inactivePolicy: this.inactivePolicy,
      activeDeviceId: this.activeDeviceId,
      sharedProxy: this.sharedProxy,
      devices: Object.fromEntries(this.devices),
    };
    const file = config.PROXY_STATE_FILE;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.error({ err: String(err), file }, 'proxy-manager: failed to save state file');
    }
  }

  private runtime(deviceId: string): DeviceRuntime {
    let rt = this.runtimes.get(deviceId);
    if (!rt) {
      rt = { method: null };
      this.runtimes.set(deviceId, rt);
    }
    return rt;
  }

  /** Serialise ADB-side operations per phone (watchdog vs API calls). */
  private withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(deviceId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(deviceId, tail);
    tail.then(() => {
      if (this.locks.get(deviceId) === tail) this.locks.delete(deviceId);
    });
    return run;
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private getUpstream(proxy: DeviceProxyConfig): UpstreamProxy {
    const key = upstreamKey(proxy);
    let up = this.upstreams.get(key);
    if (!up) {
      up = new UpstreamProxy(
        { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password, type: proxy.type },
        this.logger,
        { maxConnections: config.PROXY_MAX_CONNECTIONS },
      );
      this.upstreams.set(key, up);
    }
    return up;
  }

  private pruneUpstreams(): void {
    const used = new Set([...this.devices.values()].map((e) => upstreamKey(e.proxy)));
    for (const [key, up] of this.upstreams) {
      if (!used.has(key) && up.activeConnections === 0) this.upstreams.delete(key);
    }
  }

  private routeFor(deviceId: string): RouteDecision {
    const entry = this.devices.get(deviceId);
    if (!entry) return { kind: 'block', reason: 'Для этой платы прокси не настроен' };
    if (this.mode === 'private_parallel' || this.activeDeviceId === deviceId) {
      return { kind: 'proxy', upstream: this.getUpstream(entry.proxy) };
    }
    if (this.inactivePolicy === 'block') {
      return {
        kind: 'block',
        reason: `Режим Shared: общий прокси сейчас у платы ${this.activeDeviceId ?? '—'}, трафик этой платы заблокирован`,
      };
    }
    return { kind: 'direct' };
  }

  routeKind(deviceId: string): DeviceRoute {
    if (!this.devices.has(deviceId)) return 'none';
    return this.routeFor(deviceId).kind;
  }

  private async ensureListener(deviceId: string): Promise<DeviceProxyListener> {
    const existing = this.listeners.get(deviceId);
    if (existing) return existing;
    const pending = this.listenerStarts.get(deviceId);
    if (pending) return pending;

    const start = (async () => {
      const entry = this.devices.get(deviceId);
      const listener = new DeviceProxyListener(deviceId, () => this.routeFor(deviceId), this.logger, {
        bindHost: config.PROXY_BIND_HOST,
        idleTimeoutMs: config.PROXY_IDLE_TIMEOUT_MS,
      });
      const port = await listener.start(entry?.listenPort ?? this.allocatePort());
      this.listeners.set(deviceId, listener);
      if (entry && entry.listenPort !== port) {
        entry.listenPort = port;
        this.saveState();
      }
      return listener;
    })().finally(() => this.listenerStarts.delete(deviceId));
    this.listenerStarts.set(deviceId, start);
    return start;
  }

  private allocatePort(): number {
    const used = new Set<number>();
    for (const e of this.devices.values()) if (e.listenPort) used.add(e.listenPort);
    for (const l of this.listeners.values()) used.add(l.port);
    let port = config.PROXY_BASE_PORT;
    while (used.has(port)) port++;
    return port;
  }

  /** Wire the phone to its gateway: adb reverse + system proxy (+ transparent redirect if rooted). */
  private applyDevice(deviceId: string): Promise<void> {
    const rt = this.runtime(deviceId);
    return this.withDeviceLock(deviceId, async () => {
      if (!this.devices.has(deviceId)) return;
      const listener = await this.ensureListener(deviceId);
      const devicePort = config.PROXY_DEVICE_PORT;

      await this.adb.exec(['-s', deviceId, 'reverse', `tcp:${devicePort}`, `tcp:${listener.port}`], 15_000);

      let method: CaptureMethod = 'system_proxy';
      if (config.PROXY_ROOT_MODE !== 'off' && (await this.root.isRooted(deviceId))) {
        try {
          await this.root.start(deviceId, devicePort);
          method = 'transparent';
          rt.transparentError = undefined;
        } catch (err) {
          rt.transparentError = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            { deviceId, err: rt.transparentError },
            'proxy-manager: transparent mode failed on rooted board — falling back to system proxy',
          );
          await this.root.stop(deviceId);
        }
      }

      await this.adb.shell(
        deviceId,
        [
          `settings put global global_http_proxy_exclusion_list "${config.PROXY_BYPASS_LIST}"`,
          `settings put global http_proxy 127.0.0.1:${devicePort}`,
          `settings put global global_http_proxy_host 127.0.0.1`,
          `settings put global global_http_proxy_port ${devicePort}`,
        ].join(' && '),
        15_000,
      );

      rt.method = method;
      rt.appliedAt = Date.now();
      rt.applyError = undefined;
      rt.nextRetryAt = undefined;
      this.logger.info({ deviceId, gatewayPort: listener.port, method }, 'proxy-manager: phone wired to proxy gateway');
    }).catch((err) => {
      rt.applyError = err instanceof Error ? err.message : String(err);
      rt.nextRetryAt = Date.now() + 60_000;
      this.logger.warn({ deviceId, err: rt.applyError }, 'proxy-manager: failed to wire phone to gateway');
      throw err;
    });
  }

  /** Remove every trace of our proxy from the phone. */
  private unwireDevice(deviceId: string): Promise<void> {
    return this.withDeviceLock(deviceId, async () => {
      await this.adb.exec(['-s', deviceId, 'reverse', '--remove', `tcp:${config.PROXY_DEVICE_PORT}`], 10_000).catch(() => {});
      if (this.root.knownRooted(deviceId) ?? this.runtime(deviceId).method === 'transparent') {
        await this.root.stop(deviceId);
      }
      await this.adb
        .shell(
          deviceId,
          [
            'settings put global http_proxy :0',
            'settings delete global http_proxy',
            'settings delete global global_http_proxy_host',
            'settings delete global global_http_proxy_port',
            'settings delete global global_http_proxy_exclusion_list',
          ].join('; '),
          15_000,
        )
        .catch(() => {});
      const rt = this.runtime(deviceId);
      rt.method = null;
      rt.appliedAt = undefined;
    });
  }

  private setActive(deviceId: string | null): void {
    const previous = this.activeDeviceId;
    this.activeDeviceId = deviceId;
    if (previous === deviceId) return;
    // Open tunnels were routed by the old decision — cut them so the switch is immediate and leak-free.
    if (previous) this.listeners.get(previous)?.dropConnections();
    if (deviceId) this.listeners.get(deviceId)?.dropConnections();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getMode(): {
    mode: ProxyMode;
    inactivePolicy: InactivePolicy;
    activeDeviceId: string | null;
    hasSharedProxy: boolean;
    busyDeviceId: string | null;
  } {
    return {
      mode: this.mode,
      inactivePolicy: this.inactivePolicy,
      activeDeviceId: this.activeDeviceId,
      hasSharedProxy: this.hasAnyProxy(),
      busyDeviceId: this.lease?.deviceId ?? null,
    };
  }

  hasAnyProxy(): boolean {
    return Boolean(this.sharedProxy || this.devices.size > 0);
  }

  getProxy(deviceId: string): DeviceProxyConfig | undefined {
    return this.devices.get(deviceId)?.proxy;
  }

  getAllProxies(): Record<string, MaskedProxyConfig> {
    const out: Record<string, MaskedProxyConfig> = {};
    for (const [id, e] of this.devices) out[id] = maskProxy(e.proxy);
    return out;
  }

  getStatus(): {
    mode: ProxyMode;
    inactivePolicy: InactivePolicy;
    activeDeviceId: string | null;
    busyDeviceId: string | null;
    hostIp: string | null;
    devices: Record<string, DeviceProxyStatus>;
    upstreams: Array<{ upstream: string; protocol: UpstreamProtocol | null; activeConnections: number; queued: number; lastError?: string }>;
  } {
    const devices: Record<string, DeviceProxyStatus> = {};
    for (const id of new Set([...this.devices.keys(), ...this.runtimes.keys()])) {
      devices[id] = this.getDeviceStatus(id);
    }
    return {
      mode: this.mode,
      inactivePolicy: this.inactivePolicy,
      activeDeviceId: this.activeDeviceId,
      busyDeviceId: this.lease?.deviceId ?? null,
      hostIp: this.hostPublicIp,
      devices,
      upstreams: [...this.upstreams.values()].map((u) => ({
        upstream: u.label,
        protocol: u.detectedProtocol,
        activeConnections: u.activeConnections,
        queued: u.queuedConnections,
        lastError: u.lastError,
      })),
    };
  }

  getDeviceStatus(deviceId: string): DeviceProxyStatus {
    const entry = this.devices.get(deviceId);
    const rt = this.runtimes.get(deviceId);
    const listener = this.listeners.get(deviceId);
    return {
      deviceId,
      configured: Boolean(entry),
      route: this.routeKind(deviceId),
      method: rt?.method ?? null,
      proxy: entry ? maskProxy(entry.proxy) : undefined,
      protocol: entry ? this.upstreams.get(upstreamKey(entry.proxy))?.detectedProtocol ?? null : undefined,
      gatewayPort: listener?.port,
      gateway: listener?.stats,
      appliedAt: rt?.appliedAt ? new Date(rt.appliedAt).toISOString() : undefined,
      applyError: rt?.applyError,
      transparentError: rt?.transparentError,
    };
  }

  /**
   * Fill in what the client may omit when editing: the UI never receives passwords, so an
   * empty password for the same host/port/user means "keep the stored one".
   */
  private normalize(deviceId: string | null, input: DeviceProxyConfig): DeviceProxyConfig {
    const proxy: DeviceProxyConfig = {
      host: input.host.trim(),
      port: input.port,
      username: input.username?.trim() || undefined,
      password: input.password || undefined,
      type: input.type,
      rotateUrl: input.rotateUrl?.trim() || undefined,
    };
    if (proxy.username && !proxy.password) {
      const candidates = [deviceId ? this.devices.get(deviceId)?.proxy : undefined, this.sharedProxy ?? undefined, ...[...this.devices.values()].map((e) => e.proxy)];
      const match = candidates.find((c) => sameEndpoint(c, proxy) && c?.password);
      if (match) proxy.password = match.password;
    }
    return proxy;
  }

  /** Check a proxy from the PC (HTTPS to an IP-echo service) without touching any phone. */
  async testProxy(input: DeviceProxyConfig): Promise<UpstreamTestResult & { upstream: string }> {
    const proxy = this.normalize(null, input);
    const up = this.getUpstream(proxy);
    const res = await up.test();
    this.pruneUpstreams();
    return { ...res, upstream: up.label };
  }

  /**
   * Assign a proxy to one phone. The proxy is verified from the PC first, so a wrong
   * password / dead proxy is reported clearly and the phone keeps its working network.
   */
  async setProxy(
    deviceId: string,
    input: DeviceProxyConfig,
    opts: { activate?: boolean; skipTest?: boolean } = {},
  ): Promise<{ check: DeviceIpCheckResult; upstream?: UpstreamTestResult }> {
    const proxy = this.normalize(deviceId, input);
    this.logger.info(
      { deviceId, upstream: `${proxy.host}:${proxy.port}`, hasAuth: Boolean(proxy.username) },
      'proxy-manager: assigning proxy to phone',
    );

    let upstream: UpstreamTestResult | undefined;
    if (!opts.skipTest) {
      upstream = await this.getUpstream(proxy).test();
      if (!upstream.ok) {
        this.pruneUpstreams();
        throw new ProxyError(`Прокси не работает: ${upstream.error}`, upstream.code ?? 'unreachable');
      }
    }

    const previous = this.devices.get(deviceId);
    this.devices.set(deviceId, { proxy, listenPort: previous?.listenPort });
    this.sharedProxy = proxy;
    if (this.mode === 'shared_sequential' && opts.activate !== false && !this.isLeasedByOther(deviceId)) {
      this.setActive(deviceId);
    }
    this.saveState();
    this.listeners.get(deviceId)?.dropConnections();
    this.pruneUpstreams();

    try {
      await this.applyDevice(deviceId);
    } catch (err) {
      return {
        upstream,
        check: {
          ok: false,
          leakDetected: false,
          exposesHostIp: false,
          route: this.routeKind(deviceId),
          error: `Прокси сохранён, но применить на плате не удалось (будет повторено автоматически): ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    await delay(1000);
    return { upstream, check: await this.checkDeviceIp(deviceId) };
  }

  /** Assign many proxies at once. Each distinct proxy is tested once; failing ones don't touch phones. */
  async batchSetProxy(assignments: Array<{ deviceId: string; proxy: DeviceProxyConfig }>): Promise<{
    ok: boolean;
    total: number;
    successful: number;
    failed: number;
    results: Array<{ deviceId: string; ok: boolean; error?: string; upstream?: { ip?: string; protocol?: UpstreamProtocol } }>;
  }> {
    const normalized = assignments.map((a) => ({ deviceId: a.deviceId, proxy: this.normalize(a.deviceId, a.proxy) }));
    const tests = new Map<string, UpstreamTestResult>();
    await Promise.all(
      [...new Map(normalized.map((a) => [upstreamKey(a.proxy), a.proxy])).entries()].map(async ([key, proxy]) => {
        tests.set(key, await this.getUpstream(proxy).test());
      }),
    );

    const results: Array<{ deviceId: string; ok: boolean; error?: string; upstream?: { ip?: string; protocol?: UpstreamProtocol } }> = [];
    const toApply: string[] = [];
    for (const { deviceId, proxy } of normalized) {
      const test = tests.get(upstreamKey(proxy))!;
      if (!test.ok) {
        results.push({ deviceId, ok: false, error: `Прокси ${proxy.host}:${proxy.port} не работает: ${test.error}` });
        continue;
      }
      const previous = this.devices.get(deviceId);
      this.devices.set(deviceId, { proxy, listenPort: previous?.listenPort });
      this.listeners.get(deviceId)?.dropConnections();
      this.sharedProxy = proxy;
      toApply.push(deviceId);
    }
    if (this.mode === 'shared_sequential' && toApply.length > 0 && !toApply.includes(this.activeDeviceId ?? '') && !this.lease) {
      this.setActive(toApply[0]);
    }
    this.saveState();
    this.pruneUpstreams();

    // 4 phones at a time keeps the Windows ADB server responsive.
    for (let i = 0; i < toApply.length; i += 4) {
      const chunk = toApply.slice(i, i + 4);
      const settled = await Promise.allSettled(chunk.map((id) => this.applyDevice(id)));
      settled.forEach((r, j) => {
        const deviceId = chunk[j];
        const test = tests.get(upstreamKey(this.devices.get(deviceId)!.proxy));
        results.push(
          r.status === 'fulfilled'
            ? { deviceId, ok: true, upstream: { ip: test?.ip, protocol: test?.protocol } }
            : {
                deviceId,
                ok: false,
                error: `Прокси сохранён, но не применён на плате (повторим автоматически): ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
              },
        );
      });
    }

    const successful = results.filter((r) => r.ok).length;
    return { ok: successful > 0, total: assignments.length, successful, failed: assignments.length - successful, results };
  }

  async clearProxy(deviceId: string): Promise<{ ok: boolean }> {
    this.logger.info({ deviceId }, 'proxy-manager: clearing proxy on phone');
    this.devices.delete(deviceId);
    if (this.activeDeviceId === deviceId) this.setActive(null);
    this.saveState();
    const listener = this.listeners.get(deviceId);
    this.listeners.delete(deviceId);
    await listener?.stop();
    await this.unwireDevice(deviceId);
    this.runtimes.delete(deviceId);
    this.pruneUpstreams();
    return { ok: true };
  }

  /** Re-wire every configured phone that is online (e.g. after an ADB server restart). */
  async reapplyAll(): Promise<{ total: number; restored: number; offline: number; failed: number }> {
    const online = new Set((await this.adb.listDevices()).filter((d) => d.state === 'device').map((d) => d.serial));
    const ids = [...this.devices.keys()];
    const targets = ids.filter((id) => online.has(id));
    let restored = 0;
    for (let i = 0; i < targets.length; i += 4) {
      const settled = await Promise.allSettled(targets.slice(i, i + 4).map((id) => this.applyDevice(id)));
      restored += settled.filter((r) => r.status === 'fulfilled').length;
    }
    if (this.mode === 'shared_sequential' && (!this.activeDeviceId || !this.devices.has(this.activeDeviceId))) {
      this.setActive(targets[0] ?? ids[0] ?? null);
      this.saveState();
    }
    return { total: ids.length, restored, offline: ids.length - targets.length, failed: targets.length - restored };
  }

  /**
   * Switch modes. Phones are wired identically in both modes, so this only changes how the
   * gateways route — open connections are cut so the new rule applies immediately.
   */
  async setMode(mode: ProxyMode, inactivePolicy?: InactivePolicy): Promise<ReturnType<ProxyManager['getMode']> & { ok: boolean }> {
    this.mode = mode;
    if (inactivePolicy) this.inactivePolicy = inactivePolicy;
    if (mode === 'shared_sequential' && (!this.activeDeviceId || !this.devices.has(this.activeDeviceId))) {
      const online = new Set((await this.adb.listDevices()).filter((d) => d.state === 'device').map((d) => d.serial));
      const ids = [...this.devices.keys()];
      this.activeDeviceId = ids.find((id) => online.has(id)) ?? ids[0] ?? null;
    }
    for (const l of this.listeners.values()) l.dropConnections();
    this.saveState();
    this.logger.info({ mode: this.mode, inactivePolicy: this.inactivePolicy, activeDeviceId: this.activeDeviceId }, 'proxy-manager: mode updated');
    return { ok: true, ...this.getMode() };
  }

  private isLeasedByOther(deviceId: string): boolean {
    return Boolean(this.lease && this.lease.deviceId !== deviceId);
  }

  /**
   * Give the shared proxy to `targetDeviceId` (shared_sequential). A phone without its own
   * proxy config gets the shared one. Refuses while another phone runs a task unless `force`.
   */
  async switchActiveDevice(
    targetDeviceId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: boolean; activeDeviceId: string; previousDeviceId?: string }> {
    if (!opts.force && this.isLeasedByOther(targetDeviceId)) {
      throw new Error(`Общий прокси сейчас занят задачей на плате ${this.lease!.deviceId} — дождитесь её завершения`);
    }
    const previousDeviceId = this.activeDeviceId ?? undefined;
    if (!this.devices.has(targetDeviceId)) {
      const proxy = this.sharedProxy ?? (previousDeviceId ? this.devices.get(previousDeviceId)?.proxy : undefined);
      if (!proxy) throw new Error('Нет сохранённой конфигурации прокси для передачи');
      this.devices.set(targetDeviceId, { proxy });
      await this.applyDevice(targetDeviceId);
    }
    this.setActive(targetDeviceId);
    this.saveState();
    this.logger.info({ previousDeviceId, targetDeviceId }, 'proxy-manager: shared proxy moved to phone');
    return { ok: true, activeDeviceId: targetDeviceId, previousDeviceId };
  }

  /**
   * Reserve the network for a task on `deviceId`. In shared_sequential mode this waits until
   * no other phone is running a task, then moves the shared proxy here. Always call the
   * returned release function (try/finally).
   */
  async acquireTaskLease(deviceId: string, waitMs = 240_000): Promise<() => void> {
    if (this.mode !== 'shared_sequential' || !this.hasAnyProxy()) return () => {};
    const deadline = Date.now() + waitMs;
    while (this.lease && this.lease.deviceId !== deviceId) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`Общий прокси занят задачей на плате ${this.lease.deviceId} — превышено время ожидания очереди`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 5000));
        this.leaseWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.lease) this.lease.count++;
    else this.lease = { deviceId, count: 1 };

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (!this.lease || this.lease.deviceId !== deviceId) return;
      if (--this.lease.count <= 0) {
        this.lease = null;
        this.leaseWaiters.splice(0).forEach((wake) => wake());
      }
    };
    try {
      if (this.activeDeviceId !== deviceId) await this.switchActiveDevice(deviceId, { force: true });
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }

  /**
   * Pre-flight network guard used before touching social / marketplace apps.
   * Blocks when the phone should be proxied but isn't, or when it would expose the farm's
   * home IP while proxies are in use on this farm.
   */
  async preflight(deviceId: string): Promise<{ ok: boolean; detail?: string; ipCheck?: DeviceIpCheckResult }> {
    const ipCheck = await this.checkDeviceIp(deviceId);
    const usingProxies = this.hasAnyProxy();
    if (!ipCheck.ok) {
      if (!usingProxies) return { ok: true, ipCheck };
      return { ok: false, ipCheck, detail: `Не удалось подтвердить прокси на плате: ${ipCheck.error}` };
    }
    if (ipCheck.leakDetected) {
      return { ok: false, ipCheck, detail: `Обнаружена утечка: плата выходит в интернет с IP фермы (${ipCheck.ip}), а не через прокси` };
    }
    if (ipCheck.exposesHostIp && usingProxies) {
      return {
        ok: false,
        ipCheck,
        detail: `Плата выходит в интернет с домашнего IP фермы (${ipCheck.ip}) — назначьте ей прокси или включите режим Private`,
      };
    }
    return { ok: true, ipCheck };
  }

  // ── IP checks ──────────────────────────────────────────────────────────────

  /** Resolve public IP of the farm PC (used for leak detection). */
  async refreshHostIp(): Promise<string | null> {
    const now = Date.now();
    if (this.hostPublicIp && now - this.lastHostIpCheck < 600_000) return this.hostPublicIp;
    try {
      // proxy:false — axios would otherwise honour HTTP(S)_PROXY env vars and report the wrong "home" IP.
      const res = await axios.get('https://api.ipify.org?format=json', { timeout: 8000, proxy: false });
      if (res.data?.ip) {
        this.hostPublicIp = String(res.data.ip).trim();
        this.lastHostIpCheck = now;
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'proxy-manager: could not resolve host public IP');
    }
    return this.hostPublicIp;
  }

  /**
   * Shell snippet that fetches `http://host/path` on the phone — with curl when the ROM ships
   * it, otherwise with toybox nc — and always exits 0 so the output reaches us.
   */
  private deviceFetchCmd(host: string, pathname: string, viaGateway: boolean, timeoutSec: number): string {
    const port = config.PROXY_DEVICE_PORT;
    const url = `http://${host}${pathname}`;
    const curl = viaGateway
      ? `curl -s -S -m ${timeoutSec} -x http://127.0.0.1:${port} ${url}`
      : `curl -s -S -m ${timeoutSec} ${url}`;
    const request = viaGateway ? `GET ${url} HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n` : `GET ${pathname} HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n`;
    const nc = viaGateway
      ? `(printf '${request}'; sleep ${Math.min(timeoutSec, 6)}) | toybox nc 127.0.0.1 ${port}`
      : `(printf '${request}'; sleep ${Math.min(timeoutSec, 6)}) | toybox nc ${host} 80`;
    return `{ if command -v curl >/dev/null 2>&1; then ${curl}; else ${nc}; fi; } 2>&1; true`;
  }

  private static responseBody(output: string): string {
    const text = output.trim();
    const sep = text.search(/\r?\n\r?\n/);
    return /^HTTP\/\d/.test(text) && sep !== -1 ? text.slice(sep).trim() : text;
  }

  /** Phone → adb reverse → gateway leg, plus the system proxy setting. */
  private async probeGateway(deviceId: string): Promise<{ ok: boolean; detail: string; systemProxyOk: boolean }> {
    const port = config.PROXY_DEVICE_PORT;
    try {
      const out = await this.adb.shell(
        deviceId,
        `echo "__PROXY=$(settings get global http_proxy)"; ` +
          `{ if command -v curl >/dev/null 2>&1; then curl -s -S -m 5 http://127.0.0.1:${port}/__kmm/ping; ` +
          `else (printf 'GET /__kmm/ping HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n'; sleep 2) | toybox nc 127.0.0.1 ${port}; fi; } 2>&1; true`,
        20_000,
      );
      const systemProxyOk = out.includes(`__PROXY=127.0.0.1:${port}`);
      if (out.includes('KMM_GATEWAY_OK')) return { ok: true, detail: 'ok', systemProxyOk };
      return { ok: false, systemProxyOk, detail: out.replace(/__PROXY=\S*/, '').trim().slice(0, 200) || 'нет ответа' };
    } catch (err) {
      return { ok: false, systemProxyOk: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Ask the phone itself which IP it exits with, through the same path its apps use. */
  async checkDeviceIp(deviceId: string): Promise<DeviceIpCheckResult> {
    const hostIp = await this.refreshHostIp();
    const configured = this.devices.has(deviceId);
    const base = (): Omit<DeviceIpCheckResult, 'ok'> => ({
      leakDetected: false,
      exposesHostIp: false,
      hostIp: hostIp ?? undefined,
      route: this.routeKind(deviceId),
      method: this.runtimes.get(deviceId)?.method ?? undefined,
    });

    if (configured) {
      let probe = await this.probeGateway(deviceId);
      if (!probe.ok || !probe.systemProxyOk) {
        // Self-heal once (lost adb reverse after reboot/re-plug, proxy setting reset, ...).
        await this.applyDevice(deviceId).catch(() => {});
        probe = await this.probeGateway(deviceId);
      }
      if (!probe.ok) {
        const rt = this.runtimes.get(deviceId);
        return {
          ...base(),
          ok: false,
          error:
            `Плата не достаёт до шлюза агента (127.0.0.1:${config.PROXY_DEVICE_PORT} через adb reverse): ${probe.detail}` +
            (rt?.applyError ? `. Последняя ошибка настройки: ${rt.applyError}` : ''),
        };
      }
      if (this.routeKind(deviceId) === 'block') {
        return { ...base(), ok: false, error: 'Режим Shared: плата ждёт общий прокси, её трафик заблокирован' };
      }
    }

    const viaGateway = configured && this.runtimes.get(deviceId)?.method !== 'transparent';
    const endpoints = [
      { host: 'api.ipify.org', path: '/' },
      { host: 'ifconfig.me', path: '/ip' },
    ];
    let ip: string | undefined;
    let lastOutput = '';
    for (const ep of endpoints) {
      try {
        const out = await this.adb.shell(deviceId, this.deviceFetchCmd(ep.host, ep.path, viaGateway, 10), 30_000);
        const body = ProxyManager.responseBody(out);
        ip = extractIp(body);
        if (ip) break;
        lastOutput = body;
      } catch (err) {
        lastOutput = err instanceof Error ? err.message : String(err);
      }
    }

    if (!ip) {
      const gatewayError = configured ? this.listeners.get(deviceId)?.stats.lastError : undefined;
      const output = lastOutput.trim().slice(0, 300);
      return {
        ...base(),
        ok: false,
        error: gatewayError
          ? `Прокси не пропускает трафик: ${gatewayError}`
          : `Не удалось получить IP с платы: ${output || 'пустой ответ'}`,
      };
    }

    const exposesHostIp = Boolean(hostIp && ip === hostIp);
    const route = this.routeKind(deviceId);
    const leakDetected = exposesHostIp && route === 'proxy';
    if (leakDetected) {
      this.logger.warn({ deviceId, ip, hostIp }, 'proxy-manager: IP LEAK — phone must be proxied but exits via the farm IP');
    }

    return { ...base(), ok: true, ip, ...(await this.geo(ip)), exposesHostIp, leakDetected };
  }

  async batchCheckDeviceIp(deviceIds: string[], concurrency = 5): Promise<Array<{ deviceId: string } & DeviceIpCheckResult>> {
    const results: Array<{ deviceId: string } & DeviceIpCheckResult> = [];
    for (let i = 0; i < deviceIds.length; i += concurrency) {
      const chunk = deviceIds.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map((id) => this.checkDeviceIp(id)));
      settled.forEach((r, j) => {
        const deviceId = chunk[j];
        results.push(
          r.status === 'fulfilled'
            ? { deviceId, ...r.value }
            : {
                deviceId,
                ok: false,
                leakDetected: false,
                exposesHostIp: false,
                route: this.routeKind(deviceId),
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
              },
        );
      });
    }
    return results;
  }

  private async geo(ip: string): Promise<{ country?: string; city?: string; isp?: string }> {
    const cached = this.geoCache.get(ip);
    if (cached) return cached;
    try {
      const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,city,isp`, { timeout: 5000 });
      if (res.data?.status === 'success') {
        const geo = { country: res.data.country, city: res.data.city, isp: res.data.isp };
        this.geoCache.set(ip, geo);
        return geo;
      }
    } catch {
      // non-fatal
    }
    return {};
  }

  // ── Rotation & network ─────────────────────────────────────────────────────

  /** Call the provider's rotation webhook, then re-check the phone's exit IP. */
  async rotateProxyIp(
    deviceId: string,
    rotateUrlOverride?: string,
    cooldownMs = 4000,
  ): Promise<{
    ok: boolean;
    deviceId: string;
    rotateUrl: string;
    statusCode?: number;
    rotateResponse?: string;
    check: DeviceIpCheckResult;
    error?: string;
  }> {
    const entry = this.devices.get(deviceId);
    const url = rotateUrlOverride || entry?.proxy.rotateUrl;
    if (!url) {
      const check = await this.checkDeviceIp(deviceId);
      return {
        ok: check.ok,
        deviceId,
        rotateUrl: 'timer-rotation',
        rotateResponse: 'Ссылка ротации не задана — IP меняется по таймеру провайдера',
        check,
      };
    }

    if (entry && rotateUrlOverride && entry.proxy.rotateUrl !== rotateUrlOverride) {
      entry.proxy.rotateUrl = rotateUrlOverride;
      this.saveState();
    }

    this.logger.info({ deviceId, url }, 'proxy-manager: triggering IP rotation webhook');
    let statusCode: number | undefined;
    let rotateResponse = '';
    try {
      const res = await axios.get(url, { timeout: 15_000, headers: { 'User-Agent': 'KMMZavod-ProxyManager/2.0' } });
      statusCode = res.status;
      rotateResponse = typeof res.data === 'string' ? res.data.slice(0, 500) : JSON.stringify(res.data).slice(0, 500);
    } catch (err) {
      throw new Error(`Ошибка вызова ссылки ротации: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (cooldownMs > 0) await delay(cooldownMs);
    // Connections opened before the rotation still ride the old IP.
    this.listeners.get(deviceId)?.dropConnections();
    const check = await this.checkDeviceIp(deviceId);
    return { ok: check.ok, deviceId, rotateUrl: url, statusCode, rotateResponse, check, error: check.error };
  }

  /** Bounce eth0 / Wi-Fi and flush DNS & route caches (SIM-less Ethernet boards). */
  async restartNetworkInterface(
    deviceId: string,
    mode: 'ethernet' | 'wifi' | 'all' = 'ethernet',
  ): Promise<{ ok: boolean; deviceId: string; mode: string; log: string }> {
    this.logger.info({ deviceId, mode }, 'proxy-manager: restarting network interface');
    const commands = ['ndc resolver flushdefaultif 2>/dev/null || true', 'ip route flush cache 2>/dev/null || true'];
    if (mode === 'ethernet' || mode === 'all') {
      commands.push(
        'ip link set eth0 down 2>/dev/null || ifconfig eth0 down 2>/dev/null || true',
        'sleep 1',
        'ip link set eth0 up 2>/dev/null || ifconfig eth0 up 2>/dev/null || true',
      );
    }
    if (mode === 'wifi' || mode === 'all') {
      commands.push('svc wifi disable 2>/dev/null || true', 'sleep 1', 'svc wifi enable 2>/dev/null || true');
    }

    let output = '';
    try {
      output = await this.adb.shell(deviceId, commands.join(' && '));
    } catch (err) {
      throw new Error(`Ошибка перезапуска сети: ${err instanceof Error ? err.message : String(err)}`);
    }
    await delay(2000);
    return { ok: true, deviceId, mode, log: output || 'Сетевые интерфейсы перезапущены, DNS и маршруты сброшены' };
  }
}
