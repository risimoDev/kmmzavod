/**
 * Native ADB Video Publisher.
 *
 * Публикация видеороликов в Instagram Reels и TikTok напрямую через ADB:
 * 1. Скачивает видео из MinIO/S3 на хост-ПК (по быстрому проводному каналу без траты мобильного трафика прокси).
 * 2. Мгновенно копирует видеофайл на Android-плату по USB через `adb push` в галерею `/sdcard/DCIM/Camera/`.
 * 3. Отправляет широковещательный сигнал `MEDIA_SCANNER_SCAN_FILE` для мгновенной индексации видео в галерее.
 * 4. Запускает сценарий публикации в Instagram / TikTok через нативный Android Share Intent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import type { Logger } from 'pino';
import { config } from './config';
import { AdbClient } from './adb-client';

export interface PublishRequest {
  deviceId: string;
  platform: 'instagram' | 'tiktok';
  videoUrl: string;
  caption: string;
}

export interface PublishResult {
  ok: boolean;
  onDevicePath?: string;
  detail?: string;
}

export async function publishToDevice(
  req: PublishRequest,
  adb: AdbClient,
  logger: Logger,
): Promise<PublishResult> {
  const { deviceId, platform, videoUrl, caption } = req;
  const fileName = `pub_${platform}_${Date.now()}.mp4`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-pub-'));
  const localFilePath = path.join(tempDir, fileName);
  const onDevicePath = `${config.DOWNLOAD_DIR}/${fileName}`;

  try {
    // 1. Download video on host PC
    logger.info({ deviceId, platform, videoUrl }, 'device-agent: downloading video on host PC');
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120_000,
    });

    const writer = fs.createWriteStream(localFilePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // 2. Push video file to the phone over USB
    logger.info({ deviceId, localFilePath, onDevicePath }, 'device-agent: pushing video to Android board over USB');
    // Ensure destination directory exists
    await adb.shell(deviceId, `mkdir -p "${config.DOWNLOAD_DIR}"`).catch(() => {});
    await adb.pushFile(deviceId, localFilePath, onDevicePath);

    // 3. Trigger MediaScanner broadcast so Android gallery indexes the new video immediately
    await new Promise((r) => setTimeout(r, 1000));
    await adb.scanMediaFile(deviceId, onDevicePath);
    await new Promise((r) => setTimeout(r, 2000));

    // 4. Wake up phone and dismiss keyguard
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard');

    // 5. Verify target package is installed
    const primaryPkg = platform === 'instagram' ? 'com.instagram.android' : 'com.zhiliaoapp.musically';
    const altPkg = platform === 'tiktok' ? 'com.ss.android.ugc.trill' : '';
    const pkgCheck = await adb.shell(deviceId, `pm list packages`).catch(() => '');
    const hasPrimary = pkgCheck.includes(primaryPkg);
    const hasAlt = altPkg ? pkgCheck.includes(altPkg) : false;

    if (!hasPrimary && !hasAlt) {
      throw new Error(`Приложение ${platform} (${primaryPkg}) не установлено на телефоне ${deviceId}`);
    }
    const resolvedPkg = hasPrimary ? primaryPkg : altPkg;

    // 6. Set Android clipboard with caption & hashtags
    if (caption && caption.trim()) {
      try {
        const b64 = Buffer.from(caption.trim(), 'utf-8').toString('base64');
        await adb.shell(deviceId, `cmd clipboard set text "$(echo '${b64}' | base64 -d)"`).catch(async () => {
          await adb.shell(deviceId, `am broadcast -a clipper.set -e text "${caption.replace(/["$`\\]/g, ' ')}"`).catch(() => {});
        });
      } catch (e) {
        logger.warn({ deviceId, err: e }, 'device-agent: could not set clipboard');
      }
    }

    // 7. Trigger publication via Android Share Intent
    logger.info({ deviceId, platform, resolvedPkg, onDevicePath }, 'device-agent: launching social app share intent');

    try {
      await adb.shell(
        deviceId,
        `am start -a android.intent.action.SEND -t video/mp4 --eu android.intent.extra.STREAM "file://${onDevicePath}" -p ${resolvedPkg}`,
      );
    } catch {
      // Fallback: open app directly
      await adb.openApp(deviceId, resolvedPkg);
    }

    // Give the app 3 seconds to receive intent
    await new Promise((r) => setTimeout(r, 3000));

    return {
      ok: true,
      onDevicePath,
    };
  } catch (err: any) {
    logger.error({ deviceId, platform, err: err.message }, 'device-agent: publish failed');
    await adb.shell(deviceId, `screencap -p /sdcard/DCIM/error_pub_${Date.now()}.png`).catch(() => {});
    return {
      ok: false,
      detail: `Ошибка публикации через ADB: ${err.message}`,
    };
  } finally {
    // Clean up local temp file on host PC
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
