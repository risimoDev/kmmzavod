import dotenv from 'dotenv';

dotenv.config();

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  // Bind to the AmneziaWG interface IP only — never 0.0.0.0. See infra/amneziawg/README.md.
  HOST: env('DEVICE_AGENT_HOST', '10.13.13.2'),
  PORT: Number(env('DEVICE_AGENT_PORT', '8300')),
  LAIXI_WS_URL: env('LAIXI_WS_URL', 'ws://127.0.0.1:22221/'),
  // Where the referenced Autox.js scripts live on this PC (paths sent to Laixi's
  // ExecuteAutoJs action must be local filesystem paths, not URLs).
  SCRIPTS_DIR: env('DEVICE_AGENT_SCRIPTS_DIR', String.raw`C:\device-agent\scripts`),
  // Working dir Laixi downloads videos into on-device before posting (per httpdown action).
  DOWNLOAD_DIR: env('DEVICE_AGENT_DOWNLOAD_DIR', '/sdcard/DCIM/kmmzavod'),
  LAIXI_TIMEOUT_MS: Number(env('DEVICE_AGENT_LAIXI_TIMEOUT_MS', '120000')),
};
