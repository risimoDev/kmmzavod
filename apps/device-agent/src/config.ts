import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

function resolveScriptsDir(): string {
  if (process.env.DEVICE_AGENT_SCRIPTS_DIR) return process.env.DEVICE_AGENT_SCRIPTS_DIR;
  const localScripts = path.resolve(__dirname, '../scripts');
  if (fs.existsSync(localScripts)) return localScripts;
  return String.raw`C:\device-agent\scripts`;
}

export const config = {
  // Bind to the AmneziaWG interface IP only — never 0.0.0.0. See infra/amneziawg/README.md.
  HOST: env('DEVICE_AGENT_HOST', '10.13.13.2'),
  PORT: Number(env('DEVICE_AGENT_PORT', '8300')),
  // Path to Google adb executable (defaults to adb in PATH)
  ADB_PATH: env('ADB_PATH', 'adb'),
  // Local scripts folder on host PC
  SCRIPTS_DIR: resolveScriptsDir(),
  // Target folder on Android device for videos
  DOWNLOAD_DIR: env('DEVICE_AGENT_DOWNLOAD_DIR', '/sdcard/DCIM/Camera'),
  ADB_TIMEOUT_MS: Number(env('DEVICE_AGENT_ADB_TIMEOUT_MS', '60000')),
};
