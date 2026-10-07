import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

dotenv.config();

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

function detectTunnelHost(): string {
  if (process.env.DEVICE_AGENT_HOST) return process.env.DEVICE_AGENT_HOST;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('10.66.66.') || net.address.startsWith('10.13.13.')) {
          return net.address;
        }
      }
    }
  }
  return '10.66.66.2';
}

function resolveScriptsDir(): string {
  if (process.env.DEVICE_AGENT_SCRIPTS_DIR) return process.env.DEVICE_AGENT_SCRIPTS_DIR;
  const localScripts = path.resolve(__dirname, '../scripts');
  if (fs.existsSync(localScripts)) return localScripts;
  return String.raw`C:\device-agent\scripts`;
}

function resolveAdbPath(): string {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const localAdb = path.resolve(__dirname, '../platform-tools/adb.exe');
  if (fs.existsSync(localAdb)) return localAdb;
  const rootAdb = path.resolve(__dirname, '../../../platform-tools/adb.exe');
  if (fs.existsSync(rootAdb)) return rootAdb;
  return 'adb';
}

export const config = {
  // Bind to the AmneziaWG interface IP only — never 0.0.0.0. See infra/amneziawg/README.md.
  // (Phones reach their proxy gateways via `adb reverse`, which is unaffected by this.)
  HOST: detectTunnelHost(),
  PORT: Number(env('DEVICE_AGENT_PORT', '8300')),
  // Path to Google adb executable (prioritizes local platform-tools)
  ADB_PATH: resolveAdbPath(),
  // Local scripts folder on host PC
  SCRIPTS_DIR: resolveScriptsDir(),
  // Target folder on Android device for videos
  DOWNLOAD_DIR: env('DEVICE_AGENT_DOWNLOAD_DIR', '/sdcard/DCIM/Camera'),
  ADB_TIMEOUT_MS: Number(env('DEVICE_AGENT_ADB_TIMEOUT_MS', '60000')),

  // ── Proxy gateway (see src/proxy-manager.ts) ──
  // Where device proxy configs are persisted (contains proxy passwords — keep it out of git).
  PROXY_STATE_FILE: env('DEVICE_AGENT_PROXY_STATE_FILE', path.join(resolveScriptsDir(), '..', 'devices-proxy-state.json')),
  // Per-device gateways only need to be reachable by `adb reverse`, which connects from localhost.
  PROXY_BIND_HOST: env('DEVICE_AGENT_PROXY_BIND', '127.0.0.1'),
  // First port for per-device gateways on the PC (each phone gets a stable port from here up).
  PROXY_BASE_PORT: Number(env('DEVICE_AGENT_PROXY_BASE_PORT', '18800')),
  // Port the phone itself uses (`settings put global http_proxy 127.0.0.1:<port>`).
  PROXY_DEVICE_PORT: Number(env('DEVICE_AGENT_PROXY_DEVICE_PORT', '8888')),
  // Max concurrent connections per upstream proxy (shared mobile proxies often cap at 50). 0 = unlimited.
  PROXY_MAX_CONNECTIONS: Number(env('DEVICE_AGENT_PROXY_MAX_CONNECTIONS', '45')),
  PROXY_IDLE_TIMEOUT_MS: Number(env('DEVICE_AGENT_PROXY_IDLE_TIMEOUT_MS', '180000')),
  // 'auto' = transparent sing-box+iptables on rooted boards, 'off' = system HTTP proxy only.
  PROXY_ROOT_MODE: env('DEVICE_AGENT_PROXY_ROOT_MODE', 'auto') === 'off' ? 'off' as const : 'auto' as const,
  // How often the watchdog re-checks that every phone is still wired to its gateway.
  PROXY_WATCHDOG_INTERVAL_MS: Number(env('DEVICE_AGENT_PROXY_WATCHDOG_MS', '20000')),
  // Hosts the phone reaches directly (Android global-proxy exclusion list).
  PROXY_BYPASS_LIST: env(
    'DEVICE_AGENT_PROXY_BYPASS',
    'localhost,127.0.0.1,*.samsung.com,*.samsungapps.com,*.samsungcloud.com,*.cloudfront.cn',
  ),
};
