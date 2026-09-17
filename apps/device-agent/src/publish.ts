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

    // 5. Trigger publication via Android Share Intent
    logger.info({ deviceId, platform, onDevicePath }, 'device-agent: launching social app share intent');

    if (platform === 'instagram') {
      // Direct intent into Instagram Reels/Story post
      try {
        await adb.shell(
          deviceId,
          `am start -a android.intent.action.SEND -t video/mp4 --eu android.intent.extra.STREAM "file://${onDevicePath}" -p com.instagram.android`,
        );
      } catch {
        // Fallback: open Instagram app
        await adb.openApp(deviceId, 'com.instagram.android');
      }
    } else {
      // Direct intent into TikTok
      try {
        await adb.shell(
          deviceId,
          `am start -a android.intent.action.SEND -t video/mp4 --eu android.intent.extra.STREAM "file://${onDevicePath}" -p com.zhiliaoapp.musically`,
        );
      } catch {
        await adb.openApp(deviceId, 'com.zhiliaoapp.musically');
      }
    }

    // Give the app 3 seconds to receive intent
    await new Promise((r) => setTimeout(r, 3000));

    return {
      ok: true,
      onDevicePath,
    };
  } catch (err: any) {
    logger.error({ deviceId, platform, err: err.message }, 'device-agent: publish failed');
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
