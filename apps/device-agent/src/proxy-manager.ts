import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import type { Logger } from 'pino';
import { config } from './config';
import { AdbClient } from './adb-client';

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

  /** Set global HTTP proxy on device via ADB and persist configuration. */
  async setProxy(deviceId: string, proxy: DeviceProxyConfig): Promise<DeviceIpCheckResult> {
    this.logger.info({ deviceId, host: proxy.host, port: proxy.port }, 'proxy-manager: applying proxy to device');

    const cmd = [
      `settings put global http_proxy ${proxy.host}:${proxy.port}`,
      `settings put global global_http_proxy_host ${proxy.host}`,
      `settings put global global_http_proxy_port ${proxy.port}`,
    ].join(' && ');

    try {
      await this.adb.shell(deviceId, cmd);
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

    // Run curl or wget on the device to get its outward IP (testing through proxy if configured)
    const cfg = this.proxyMap.get(deviceId);
    let cmd = '';
    if (cfg && cfg.host && cfg.port) {
      const auth = cfg.username && cfg.password ? `${cfg.username}:${cfg.password}@` : '';
      const proto = cfg.type === 'socks5' ? 'socks5://' : 'http://';
      const proxyOpt = `-x ${proto}${auth}${cfg.host}:${cfg.port}`;
      // Test strictly through proxy with SSL ignore (-k) and show errors (-S)
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
      // Не падаем с ошибкой, а проверяем текущий выходной IP и статус.
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
