import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import type { Logger } from 'pino';
import { config } from './config';
import { AdbClient, AdbDevice } from './adb-client';
import { LocalProxyForwarder } from './proxy-forwarder';

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

export class ProxyManager {
  private stateFilePath: string;
  private proxyMap: Map<string, DeviceProxyConfig> = new Map();
  private hostPublicIp: string | null = null;
  private lastHostIpCheck = 0;

  /** Forwarders indexed by upstream signature: type://user:pass@host:port */
  private forwarders: Map<string, LocalProxyForwarder> = new Map();
  /** Mapping of deviceId -> forwarder signature */
  private deviceForwarderKey: Map<string, string> = new Map();

  constructor(
    private readonly adb: AdbClient,
    private readonly logger: Logger,
  ) {
    this.stateFilePath = path.join(config.SCRIPTS_DIR, '..', 'devices-proxy-state.json');
    this.loadState();
    this.refreshHostIp().catch((err) => {
      this.logger.warn({ err: String(err) }, 'proxy-manager: initial host IP resolution failed');
    });
  }

  /**
   * Initialize forwarders and ADB reverse tunnels for all saved proxies on agent startup.
   * Waits gracefully for ADB to finish USB device discovery before applying.
   */
  async init(): Promise<void> {
    if (this.proxyMap.size === 0) return;
    this.logger.info({ count: this.proxyMap.size }, 'proxy-manager: restoring saved device proxies');

    // Wait up to 10 seconds for ADB to enumerate USB devices
    let onlineDevices: AdbDevice[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const list = await this.adb.listDevices();
        onlineDevices = list.filter((d) => d.state === 'device');
        if (onlineDevices.length > 0) break;
      } catch {
        // adb still initializing
      }
      if (attempt < 4) {
        this.logger.info('proxy-manager: waiting for ADB USB device enumeration (2s)...');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const onlineSerials = new Set(onlineDevices.map((d) => d.serial));
    let restored = 0;

    for (const [deviceId, proxy] of this.proxyMap.entries()) {
      if (!onlineSerials.has(deviceId)) {
        this.logger.info({ deviceId }, 'proxy-manager: device currently offline, proxy will be applied upon reconnect');
        continue;
      }
      try {
        await this.applyDeviceProxy(deviceId, proxy);
        restored++;
      } catch (err) {
        this.logger.warn({ deviceId, err: String(err) }, 'proxy-manager: failed to restore proxy for device');
      }
    }

    this.logger.info(
      { restored, totalConfigured: this.proxyMap.size, online: onlineSerials.size },
      'proxy-manager: proxy restoration complete'
    );
  }

  /**
   * Reapply saved proxies to all currently connected devices in the rack.
   */
  async reapplyAll(): Promise<{ total: number; restored: number; offline: number }> {
    const devices = await this.adb.listDevices().catch(() => []);
    const onlineSerials = new Set(
      devices.filter((d) => d.state === 'device').map((d) => d.serial)
    );

    let restored = 0;
    let offline = 0;

    for (const [deviceId, proxy] of this.proxyMap.entries()) {
      if (onlineSerials.has(deviceId)) {
        try {
          await this.applyDeviceProxy(deviceId, proxy);
          restored++;
        } catch (err) {
          this.logger.warn({ deviceId, err: String(err) }, 'proxy-manager: failed to reapply proxy');
        }
      } else {
        offline++;
      }
    }

    this.logger.info({ restored, offline, total: this.proxyMap.size }, 'proxy-manager: reapplyAll finished');
    return { total: this.proxyMap.size, restored, offline };
  }

  /**
   * Apply proxy configuration (reverse tunnel and global Android settings) to an active device.
   */
  async applyDeviceProxy(deviceId: string, proxy: DeviceProxyConfig): Promise<void> {
    const oldKey = this.deviceForwarderKey.get(deviceId);

    if (proxy.username && proxy.password) {
      // Android does not support proxy credentials natively in settings put global http_proxy.
      // Route through local forwarder on Farm PC via ADB reverse.
      const fwd = await this.getOrCreateForwarder(proxy);
      const newKey = this.getForwarderKey(proxy);
      this.deviceForwarderKey.set(deviceId, newKey);

      // Map device 127.0.0.1:8888 -> Farm PC local forwarder port
      await this.adb.exec(['-s', deviceId, 'reverse', '--remove', 'tcp:8888']).catch(() => {});
      await this.adb.exec(['-s', deviceId, 'reverse', 'tcp:8888', `tcp:${fwd.boundPort}`]);

      const cmd = [
        'settings put global http_proxy 127.0.0.1:8888',
        'settings put global global_http_proxy_host 127.0.0.1',
        'settings put global global_http_proxy_port 8888',
      ].join(' && ');

      await this.adb.shell(deviceId, cmd);
      this.logger.info({ deviceId, port: fwd.boundPort }, 'proxy-manager: forwarder and reverse tunnel applied');
    } else {
      // Open or IP-whitelisted proxy
      await this.adb.exec(['-s', deviceId, 'reverse', '--remove', 'tcp:8888']).catch(() => {});
      this.deviceForwarderKey.delete(deviceId);

      const cmd = [
        `settings put global http_proxy ${proxy.host}:${proxy.port}`,
        `settings put global global_http_proxy_host ${proxy.host}`,
        `settings put global global_http_proxy_port ${proxy.port}`,
      ].join(' && ');

      await this.adb.shell(deviceId, cmd);
    }

    if (oldKey && oldKey !== this.deviceForwarderKey.get(deviceId)) {
      await this.releaseForwarder(oldKey);
    }
  }

  private getForwarderKey(proxy: DeviceProxyConfig): string {
    return `${proxy.type || 'http'}://${proxy.username || ''}:${proxy.password || ''}@${proxy.host}:${proxy.port}`;
  }

  private async getOrCreateForwarder(proxy: DeviceProxyConfig): Promise<LocalProxyForwarder> {
    const key = this.getForwarderKey(proxy);
    let fwd = this.forwarders.get(key);
    if (!fwd) {
      fwd = new LocalProxyForwarder(
        {
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
          type: proxy.type,
        },
        this.logger
      );
      await fwd.start();
      this.forwarders.set(key, fwd);
    }
    return fwd;
  }

  private async releaseForwarder(key: string): Promise<void> {
    // Check if any active device still uses this forwarder key
    for (const assignedKey of this.deviceForwarderKey.values()) {
      if (assignedKey === key) return;
    }
    const fwd = this.forwarders.get(key);
    if (fwd) {
      await fwd.stop();
      this.forwarders.delete(key);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const data = JSON.parse(raw);
        if (typeof data === 'object' && data !== null) {
          for (const [deviceId, cfg] of Object.entries(data)) {
            this.proxyMap.set(deviceId, cfg as DeviceProxyConfig);
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'proxy-manager: failed to load state file, starting fresh');
    }
  }

  private saveState(): void {
    try {
      const obj: Record<string, DeviceProxyConfig> = {};
      for (const [id, cfg] of this.proxyMap.entries()) {
        obj[id] = cfg;
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error({ err }, 'proxy-manager: failed to save state file');
    }
  }

  /** Resolve public IP of the host PC running device-agent (used for leak detection). */
  async refreshHostIp(): Promise<string | null> {
    const now = Date.now();
    if (this.hostPublicIp && now - this.lastHostIpCheck < 600_000) {
      return this.hostPublicIp;
    }
    try {
      const res = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
      if (res.data?.ip) {
        this.hostPublicIp = res.data.ip.trim();
        this.lastHostIpCheck = now;
        this.logger.info({ hostPublicIp: this.hostPublicIp }, 'proxy-manager: host public IP updated');
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'proxy-manager: could not resolve host public IP');
    }
    return this.hostPublicIp;
  }

  /**
   * Set global HTTP proxy on device via ADB and persist configuration.
   * If proxy has credentials, a LocalProxyForwarder is spawned and bridged via `adb reverse tcp:8888`.
   */
  async setProxy(deviceId: string, proxy: DeviceProxyConfig): Promise<DeviceIpCheckResult> {
    this.logger.info(
      { deviceId, host: proxy.host, port: proxy.port, hasAuth: Boolean(proxy.username && proxy.password) },
      'proxy-manager: applying proxy to device'
    );

    try {
      await this.applyDeviceProxy(deviceId, proxy);
      this.proxyMap.set(deviceId, proxy);
      this.saveState();
    } catch (err) {
      this.logger.error({ deviceId, err }, 'proxy-manager: failed to set proxy settings via ADB');
      throw new Error(`Failed to set proxy via ADB: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Give network stack 2 seconds to apply
    await new Promise((r) => setTimeout(r, 2000));

    // Verify live IP from device
    return this.checkDeviceIp(deviceId);
  }

  /** Clear proxy settings on device. */
  async clearProxy(deviceId: string): Promise<{ ok: boolean }> {
    this.logger.info({ deviceId }, 'proxy-manager: clearing proxy on device');

    const oldKey = this.deviceForwarderKey.get(deviceId);
    this.deviceForwarderKey.delete(deviceId);

    // Remove ADB reverse tunnel
    await this.adb.exec(['-s', deviceId, 'reverse', '--remove', 'tcp:8888']).catch(() => {});

    if (oldKey) {
      await this.releaseForwarder(oldKey);
    }

    const cmd = [
      'settings put global http_proxy :0',
      'settings delete global http_proxy',
      'settings delete global global_http_proxy_host',
      'settings delete global global_http_proxy_port',
    ].join(' && ');

    try {
      await this.adb.shell(deviceId, cmd);
      this.proxyMap.delete(deviceId);
      this.saveState();
      return { ok: true };
    } catch (err) {
      this.logger.error({ deviceId, err }, 'proxy-manager: failed to clear proxy settings');
      throw new Error(`Failed to clear proxy via ADB: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Run a check on the device itself to test what IP it exits with to the internet. */
  async checkDeviceIp(deviceId: string): Promise<DeviceIpCheckResult> {
    await this.refreshHostIp();

    const cfg = this.proxyMap.get(deviceId);
    let cmd = '';

    if (cfg && cfg.username && cfg.password) {
      // Ensure reverse tunnel and settings are active before testing (self-healing)
      try {
        await this.applyDeviceProxy(deviceId, cfg);
      } catch {
        // non-fatal, proceed with test
      }
      // Forwarder is running on 127.0.0.1:8888 via ADB reverse tunnel
      cmd = [
        'curl -k -s -S -x http://127.0.0.1:8888 --max-time 12 http://api.ipify.org',
        'curl -k -s -S -x http://127.0.0.1:8888 --max-time 12 https://api.ipify.org',
        'curl -k -s -S --max-time 12 http://api.ipify.org',
      ].join(' || ');
    } else if (cfg && cfg.host && cfg.port) {
      const proto = cfg.type === 'socks5' ? 'socks5://' : 'http://';
      const proxyOpt = `-x ${proto}${cfg.host}:${cfg.port}`;
      cmd = `curl -k -s -S ${proxyOpt} --max-time 12 http://api.ipify.org || curl -k -s -S ${proxyOpt} --max-time 12 https://api.ipify.org`;
    } else {
      cmd = `curl -k -s -S --max-time 10 http://api.ipify.org || curl -k -s -S --max-time 10 https://api.ipify.org || wget -qO- --timeout=10 http://api.ipify.org`;
    }

    try {
      const text = await this.adb.shell(deviceId, cmd);
      this.logger.debug({ deviceId, text }, 'proxy-manager: adb response for ip check');

      // Extract IPv4 or IPv6
      const ipMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || text.match(/[0-9a-fA-F:]{7,39}/);
      if (!ipMatch) {
        return {
          ok: false,
          error: `No valid IP returned from device. Raw response: ${text.slice(0, 200)}`,
          leakDetected: false,
          hostIp: this.hostPublicIp ?? undefined,
        };
      }

      const deviceIp = ipMatch[0].trim();
      const leakDetected = Boolean(this.hostPublicIp && deviceIp === this.hostPublicIp);

      if (leakDetected) {
        this.logger.warn({ deviceId, deviceIp, hostIp: this.hostPublicIp }, 'proxy-manager: IP LEAK DETECTED! Device is using host direct IP!');
      }

      // Fetch geo data via IP-API from host
      let geo: { country?: string; city?: string; isp?: string } = {};
      try {
        const geoRes = await axios.get(`http://ip-api.com/json/${deviceIp}?fields=status,country,city,isp`, { timeout: 5000 });
        if (geoRes.data?.status === 'success') {
          geo = {
            country: geoRes.data.country,
            city: geoRes.data.city,
            isp: geoRes.data.isp,
          };
        }
      } catch {
        // non-fatal
      }

      return {
        ok: true,
        ip: deviceIp,
        country: geo.country,
        city: geo.city,
        isp: geo.isp,
        leakDetected,
        hostIp: this.hostPublicIp ?? undefined,
      };
    } catch (err) {
      return {
        ok: false,
        error: `ADB check failed: ${err instanceof Error ? err.message : String(err)}`,
        leakDetected: false,
        hostIp: this.hostPublicIp ?? undefined,
      };
    }
  }

  /** Trigger IP rotation webhook for mobile/residential proxy and verify new exit IP. */
  async rotateProxyIp(
    deviceId: string,
    rotateUrlOverride?: string,
    cooldownMs = 4000
  ): Promise<{
    ok: boolean;
    deviceId: string;
    rotateUrl: string;
    statusCode?: number;
    rotateResponse?: string;
    check: DeviceIpCheckResult;
    error?: string;
  }> {
    const cfg = this.proxyMap.get(deviceId);
    const url = rotateUrlOverride || cfg?.rotateUrl;
    if (!url) {
      // Для Shared-прокси с ротацией по таймеру провайдера URL-вебхук отсутствует.
      this.logger.info({ deviceId }, 'proxy-manager: no rotateUrl configured (Shared/timer rotation) - checking current IP');
      const check = await this.checkDeviceIp(deviceId);
      return {
        ok: check.ok,
        deviceId,
        rotateUrl: 'timer-rotation',
        statusCode: 200,
        rotateResponse: 'Авторотация по таймеру провайдера (Shared-режим)',
        check,
      };
    }

    this.logger.info({ deviceId, url }, 'proxy-manager: triggering IP rotation webhook');

    let statusCode: number | undefined;
    let rotateResponse = '';

    try {
      const res = await axios.get(url, {
        timeout: 15_000,
        headers: { 'User-Agent': 'KMMZavod-ProxyManager/1.0' },
      });
      statusCode = res.status;
      rotateResponse = typeof res.data === 'string' ? res.data.slice(0, 500) : JSON.stringify(res.data).slice(0, 500);
    } catch (err) {
      this.logger.error({ deviceId, err }, 'proxy-manager: failed to call rotateUrl');
      throw new Error(`Ошибка вызова ротации по ссылке: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Cooldown to give mobile carrier / modem time to re-establish connection
    if (cooldownMs > 0) {
      await new Promise((r) => setTimeout(r, cooldownMs));
    }

    // Re-check exit IP
    const check = await this.checkDeviceIp(deviceId);
    return {
      ok: check.ok,
      deviceId,
      rotateUrl: url,
      statusCode,
      rotateResponse,
      check,
    };
  }

  /**
   * Restart network interface (Ethernet eth0 or Wi-Fi wlan0) and flush DNS/route cache.
   * Tailored for single-cable Ethernet motherboard phone farms without SIM cards.
   */
  async restartNetworkInterface(
    deviceId: string,
    mode: 'ethernet' | 'wifi' | 'all' = 'ethernet'
  ): Promise<{
    ok: boolean;
    deviceId: string;
    mode: string;
    log: string;
  }> {
    this.logger.info({ deviceId, mode }, 'proxy-manager: restarting network interface and flushing caches');

    const commands: string[] = [];

    // 1. Flush DNS resolver and route caches
    commands.push('ndc resolver flushdefaultif 2>/dev/null || true');
    commands.push('ip route flush cache 2>/dev/null || true');

    // 2. Ethernet bounce (single cable farm architecture)
    if (mode === 'ethernet' || mode === 'all') {
      commands.push('ip link set eth0 down 2>/dev/null || ifconfig eth0 down 2>/dev/null || true');
      commands.push('sleep 1');
      commands.push('ip link set eth0 up 2>/dev/null || ifconfig eth0 up 2>/dev/null || true');
    }

    // 3. Wi-Fi bounce
    if (mode === 'wifi' || mode === 'all') {
      commands.push('svc wifi disable 2>/dev/null || true');
      commands.push('sleep 1');
      commands.push('svc wifi enable 2>/dev/null || true');
    }

    const script = commands.join(' && ');
    let output = '';
    try {
      output = await this.adb.shell(deviceId, script);
    } catch (err) {
      this.logger.error({ deviceId, err }, 'proxy-manager: network restart command failed');
      throw new Error(`Ошибка перезапуска сети: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Allow 2s for interface re-negotiation / DHCP renewal
    await new Promise((r) => setTimeout(r, 2000));

    return {
      ok: true,
      deviceId,
      mode,
      log: output || 'Сетевые интерфейсы перезапущены, DNS и маршруты сброшены',
    };
  }

  /** Batch set proxy across multiple devices in parallel */
  async batchSetProxy(
    assignments: Array<{ deviceId: string; proxy: DeviceProxyConfig }>
  ): Promise<{
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
    const results = await Promise.allSettled(
      assignments.map(async ({ deviceId, proxy }) => {
        const check = await this.setProxy(deviceId, proxy);
        return { deviceId, ok: true, check };
      })
    );

    const formatted = results.map((r, i) => {
      const devId = assignments[i].deviceId;
      if (r.status === 'fulfilled') {
        return r.value;
      }
      return {
        deviceId: devId,
        ok: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    const successful = formatted.filter((f) => f.ok).length;
    return {
      ok: successful > 0 || assignments.length === 0,
      total: assignments.length,
      successful,
      failed: assignments.length - successful,
      results: formatted,
    };
  }

  getProxy(deviceId: string): DeviceProxyConfig | undefined {
    return this.proxyMap.get(deviceId);
  }

  getAllProxies(): Record<string, DeviceProxyConfig> {
    const res: Record<string, DeviceProxyConfig> = {};
    for (const [k, v] of this.proxyMap.entries()) {
      res[k] = v;
    }
    return res;
  }
}
