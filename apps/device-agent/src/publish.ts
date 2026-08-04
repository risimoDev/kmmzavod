import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { config } from './config';
import { LaixiClient } from './laixi-client';

export interface PublishRequest {
  deviceId: string;
  platform: 'instagram' | 'tiktok';
  videoUrl: string;
  caption: string;
}

export interface PublishResult {
  ok: boolean;
  detail?: string;
}

const TEMPLATE_FILE: Record<PublishRequest['platform'], string> = {
  instagram: 'instagram_post.template.js',
  tiktok: 'tiktok_post.template.js',
};

/** Render a template script with the job's video path + caption baked in, write it next to the templates. */
function renderScript(platform: PublishRequest['platform'], onDeviceVideoPath: string, caption: string): string {
  const templatePath = path.join(config.SCRIPTS_DIR, TEMPLATE_FILE[platform]);
  const template = fs.readFileSync(templatePath, 'utf-8');
  const rendered = template
    .replace('__VIDEO_PATH__', onDeviceVideoPath.replace(/\\/g, '\\\\'))
    .replace('__CAPTION__', caption.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'));

  const outPath = path.join(config.SCRIPTS_DIR, `_run_${platform}_${Date.now()}.js`);
  fs.writeFileSync(outPath, rendered, 'utf-8');
  return outPath;
}

export async function publishToDevice(req: PublishRequest, laixi: LaixiClient, logger: Logger): Promise<PublishResult> {
  const { deviceId, platform, videoUrl, caption } = req;
  const onDevicePath = `${config.DOWNLOAD_DIR}/${platform}_${Date.now()}.mp4`;

  logger.info({ deviceId, platform }, 'device-agent: downloading video to phone');
  await laixi.httpDownload(deviceId, videoUrl, onDevicePath);

  // Laixi's httpdown is fire-and-forget per the (thin) docs — no confirmed
  // completion signal. Give the transfer time before launching the post flow.
  // CALIBRATE: replace with a poll loop (e.g. `Current Activity` / a custom
  // Autox.js file-exists check) once you've seen how Laixi reports progress.
  await new Promise((r) => setTimeout(r, 15_000));

  const scriptPath = renderScript(platform, onDevicePath, caption);
  logger.info({ deviceId, platform, scriptPath }, 'device-agent: executing Autox.js post script');

  try {
    await laixi.executeAutoJs(deviceId, scriptPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.unlink(scriptPath, () => undefined);
  }
}
