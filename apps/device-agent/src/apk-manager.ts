import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import axios from 'axios';
import type { Logger } from 'pino';
import { AdbClient } from './adb-client';

export interface BatchInstallOptions {
  apkUrl: string;
  targetDeviceIds: string[];
  reinstall?: boolean;
  grantPermissions?: boolean;
}

export interface DeviceInstallResult {
  deviceId: string;
  ok: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

export interface BatchInstallResult {
  ok: boolean;
  total: number;
  successful: number;
  failed: number;
  apkSizeMb?: number;
  results: DeviceInstallResult[];
}

export interface BatchAppActionOptions {
  action: 'uninstall' | 'clear-data' | 'force-stop' | 'launch';
  packageName: string;
  targetDeviceIds: string[];
}

export interface BatchAppActionResult {
  ok: boolean;
  action: string;
  packageName: string;
  total: number;
  successful: number;
  failed: number;
  results: Array<{
    deviceId: string;
    ok: boolean;
    output?: string;
    error?: string;
  }>;
}

export class ApkManager {
  private cacheDir: string;

  constructor(private readonly logger: Logger) {
    this.cacheDir = path.join(os.tmpdir(), 'kmmzavod-apks');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Validates that the file at localPath begins with ZIP magic bytes PK\x03\x04.
   * If invalid (e.g. HTML challenge page), deletes the file and throws an error.
   */
  private validateApkFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Файл не найден: ${filePath}`);
    }
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);

    if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      const preview = header.toString('utf-8').replace(/[^\x20-\x7E]/g, '.');
      throw new Error(
        `Загруженный файл не является APK-архивом (сигнатура: '${preview}'). ` +
        `Возможно, ссылка защищена Cloudflare или возвращает HTML-страницу. ` +
        `Рекомендуется скачать APK вручную через браузер на ПК и загрузить файлом.`
      );
    }
  }

  /**
   * Downloads APK from URL with caching on host PC and ZIP header verification.
   */
  async downloadCachedApk(apkUrl: string): Promise<{ localPath: string; sizeMb: number }> {
    const hash = crypto.createHash('sha256').update(apkUrl).digest('hex').slice(0, 16);
    const fileName = `app_${hash}.apk`;
    const targetPath = path.join(this.cacheDir, fileName);

    // If already downloaded and valid size (> 100 KB)
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      if (stats.size > 100 * 1024) {
        try {
          this.validateApkFile(targetPath);
          const sizeMb = Number((stats.size / (1024 * 1024)).toFixed(2));
          this.logger.info({ apkUrl, targetPath, sizeMb }, 'apk-manager: using validated cached APK');
          return { localPath: targetPath, sizeMb };
        } catch {
          // If cached file was corrupted or HTML, download fresh
        }
      }
    }

    this.logger.info({ apkUrl, targetPath }, 'apk-manager: downloading APK to host PC');
    const tempPath = `${targetPath}.tmp_${Date.now()}`;

    const response = await axios({
      method: 'GET',
      url: apkUrl,
      responseType: 'stream',
      timeout: 300_000, // 5 min timeout for slow mirrors
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Validate magic bytes before promoting temp file
    try {
      this.validateApkFile(tempPath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }

    // Atomic move
    fs.renameSync(tempPath, targetPath);
    const finalStats = fs.statSync(targetPath);
    const sizeMb = Number((finalStats.size / (1024 * 1024)).toFixed(2));
    this.logger.info({ apkUrl, targetPath, sizeMb }, 'apk-manager: APK download and verification complete');

    return { localPath: targetPath, sizeMb };
  }

  /**
   * Saves uploaded APK buffer to cache directory with signature verification.
   */
  async saveLocalApkBuffer(buffer: Buffer, originalFilename?: string): Promise<{ localPath: string; sizeMb: number }> {
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      throw new Error('Загруженный файл не является валидным APK-архивом (отсутствует сигнатура PK ZIP)');
    }
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const cleanName = (originalFilename || 'app').replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `upload_${hash}_${cleanName}`;
    const targetPath = path.join(this.cacheDir, fileName.endsWith('.apk') ? fileName : `${fileName}.apk`);

    fs.writeFileSync(targetPath, buffer);
    const sizeMb = Number((buffer.length / (1024 * 1024)).toFixed(2));
    this.logger.info({ targetPath, sizeMb }, 'apk-manager: saved uploaded APK buffer to local cache');
    return { localPath: targetPath, sizeMb };
  }

  /**
   * Concurrently installs a local APK file on all specified boards.
   */
  async batchInstallLocal(
    adb: AdbClient,
    localPath: string,
    sizeMb: number,
    targetDeviceIds: string[],
    reinstall = true,
    grantPermissions = true
  ): Promise<BatchInstallResult> {
    const targets = Array.from(new Set(targetDeviceIds));
    if (targets.length === 0) {
      return { ok: false, total: 0, successful: 0, failed: 0, results: [] };
    }

    this.logger.info({ targetsCount: targets.length, localPath, sizeMb }, 'apk-manager: starting parallel install');

    const settled = await Promise.allSettled(
      targets.map(async (serial): Promise<DeviceInstallResult> => {
        const start = Date.now();
        try {
          const res = await adb.installApk(serial, localPath, { reinstall, grantPermissions });
          return {
            deviceId: serial,
            ok: res.ok,
            durationMs: Date.now() - start,
            output: res.output,
            error: res.ok ? undefined : res.output,
          };
        } catch (err: any) {
          return {
            deviceId: serial,
            ok: false,
            durationMs: Date.now() - start,
            output: '',
            error: err.message || String(err),
          };
        }
      })
    );

    const results: DeviceInstallResult[] = settled.map((s, idx) => {
      if (s.status === 'fulfilled') return s.value;
      return {
        deviceId: targets[idx],
        ok: false,
        durationMs: 0,
        output: '',
        error: s.reason?.message || 'Rejected promise',
      };
    });

    const successful = results.filter((r) => r.ok).length;
    const failed = results.length - successful;

    return {
      ok: successful > 0,
      total: targets.length,
      successful,
      failed,
      apkSizeMb: sizeMb,
      results,
    };
  }

  /**
   * Concurrently installs APK from URL on all specified boards.
   */
  async batchInstall(adb: AdbClient, opts: BatchInstallOptions): Promise<BatchInstallResult> {
    const { apkUrl, targetDeviceIds, reinstall = true, grantPermissions = true } = opts;
    const targets = Array.from(new Set(targetDeviceIds));

    if (targets.length === 0) {
      return { ok: false, total: 0, successful: 0, failed: 0, results: [] };
    }

    // 1. Download / cache APK once with verification
    const { localPath, sizeMb } = await this.downloadCachedApk(apkUrl);

    // 2. Install concurrently across boards
    return this.batchInstallLocal(adb, localPath, sizeMb, targets, reinstall, grantPermissions);
  }

  /**
   * Concurrently installs APK from uploaded Buffer on all specified boards.
   */
  async batchInstallFromBuffer(
    adb: AdbClient,
    buffer: Buffer,
    targetDeviceIds: string[],
    originalFilename?: string,
    reinstall = true,
    grantPermissions = true
  ): Promise<BatchInstallResult> {
    const { localPath, sizeMb } = await this.saveLocalApkBuffer(buffer, originalFilename);
    return this.batchInstallLocal(adb, localPath, sizeMb, targetDeviceIds, reinstall, grantPermissions);
  }

  /**
   * Concurrently runs action (uninstall, clear-data, force-stop, launch) across boards.
   */
  async batchAppAction(adb: AdbClient, opts: BatchAppActionOptions): Promise<BatchAppActionResult> {
    const { action, packageName, targetDeviceIds } = opts;
    const targets = Array.from(new Set(targetDeviceIds));

    this.logger.info({ action, packageName, targetsCount: targets.length }, 'apk-manager: running batch app action');

    const settled = await Promise.allSettled(
      targets.map(async (serial) => {
        switch (action) {
          case 'uninstall':
            return adb.uninstallApp(serial, packageName);
          case 'clear-data':
            return adb.clearAppData(serial, packageName);
          case 'force-stop':
            return adb.stopApp(serial, packageName);
          case 'launch':
            await adb.openApp(serial, packageName);
            return { ok: true, output: 'Launched' };
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      })
    );

    const results = settled.map((s, idx) => ({
      deviceId: targets[idx],
      ok: s.status === 'fulfilled' && (s.value as any)?.ok !== false,
      output: s.status === 'fulfilled' ? (s.value as any)?.output : undefined,
      error: s.status === 'rejected' ? s.reason?.message : (s.status === 'fulfilled' && !(s.value as any)?.ok ? (s.value as any)?.output : undefined),
    }));

    const successful = results.filter((r) => r.ok).length;
    const failed = results.length - successful;

    return {
      ok: successful > 0,
      action,
      packageName,
      total: targets.length,
      successful,
      failed,
      results,
    };
  }
}
