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

export const config = {
  // Bind to the AmneziaWG interface IP only — never 0.0.0.0. See infra/amneziawg/README.md.
  HOST: detectTunnelHost(),
  PORT: Number(env('DEVICE_AGENT_PORT', '8300')),
  // Path to Google adb executable (defaults to adb in PATH)
  ADB_PATH: env('ADB_PATH', 'adb'),
  // Local scripts folder on host PC
  SCRIPTS_DIR: resolveScriptsDir(),
  // Target folder on Android device for videos
  DOWNLOAD_DIR: env('DEVICE_AGENT_DOWNLOAD_DIR', '/sdcard/DCIM/Camera'),
  ADB_TIMEOUT_MS: Number(env('DEVICE_AGENT_ADB_TIMEOUT_MS', '60000')),
};
