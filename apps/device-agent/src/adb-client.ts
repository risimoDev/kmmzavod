/**
 * AdbClient — собственный открытый драйвер для управления стойкой Android-плат
 * через официальный Android Debug Bridge (ADB).
 *
 * Полностью заменяет Laixi Master:
 * - 0 ₽ навсегда, без лицензий и подписок
 * - Прямой доступ к USB-устройствам на полной скорости
 * - Захват экрана через `exec-out screencap -p` в PNG за 100–200 мс
 * - Прямой push видеофайлов с ПК на плату без расхода мобильного трафика прокси
 * - Поддержка любых сценариев: соцсети (Instagram, TikTok) и e-commerce (Wildberries)
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import { config } from './config';

const execFileAsync = promisify(execFile);

export interface AdbDevice {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | 'unknown';
  model?: string;
  product?: string;
  device?: string;
}

export class AdbClient {
  private adbPath: string;

  constructor(private readonly logger: Logger, adbPath?: string) {
    this.adbPath = adbPath || config.ADB_PATH || 'adb';
  }

  /** Run ADB command and return stdout string. */
  async exec(args: string[], timeoutMs = 30_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.adbPath, args, {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'utf-8',
      });
      return stdout.trim();
    } catch (err: any) {
      const msg = err.stderr ? String(err.stderr).trim() : err.message;
      this.logger.debug({ args, err: msg }, 'adb: exec error');
      throw new Error(`ADB error (${args.join(' ')}): ${msg}`);
    }
  }

  /** Run a shell command on a specific device. */
  async shell(serial: string, command: string, timeoutMs = 30_000): Promise<string> {
    return this.exec(['-s', serial, 'shell', command], timeoutMs);
  }

  /** List all connected Android boards with detailed device info. */
  async listDevices(): Promise<AdbDevice[]> {
    try {
      const raw = await this.exec(['devices', '-l']);
      const lines = raw.split(/\r?\n/).slice(1); // skip "List of devices attached"
      const result: AdbDevice[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;

        const serial = parts[0];
        const state = (['device', 'offline', 'unauthorized'].includes(parts[1]) ? parts[1] : 'unknown') as AdbDevice['state'];

        let model: string | undefined;
        let product: string | undefined;
        let device: string | undefined;

        for (const token of parts.slice(2)) {
          if (token.startsWith('model:')) model = token.slice(6);
          else if (token.startsWith('product:')) product = token.slice(8);
          else if (token.startsWith('device:')) device = token.slice(7);
        }

        result.push({ serial, state, model, product, device });
      }

      return result;
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'adb: listDevices failed');
      return [];
    }
  }

  /** Push local file from host PC to device filesystem over USB. */
  async pushFile(serial: string, localPath: string, remotePath: string, timeoutMs = 120_000): Promise<void> {
    this.logger.info({ serial, localPath, remotePath }, 'adb: pushing file to board');
    await this.exec(['-s', serial, 'push', localPath, remotePath], timeoutMs);
  }

  /** Broadcast MEDIA_SCANNER_SCAN_FILE so Android gallery indexes the file immediately. */
  async scanMediaFile(serial: string, remotePath: string): Promise<void> {
    this.logger.info({ serial, remotePath }, 'adb: broadcasting MediaScanner');
    await this.shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${remotePath}"`);
  }

  /**
   * Fast native screen capture directly from Android framebuffer.
   * Uses `adb exec-out screencap -p` streaming raw PNG bytes into Node.js buffer.
   * Returns base64 string without creating temporary files.
   */
  async takeScreenshot(serial: string, timeoutMs = 15_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = spawn(this.adbPath, ['-s', serial, 'exec-out', 'screencap', '-p']);
      const chunks: Buffer[] = [];
      let errBuf = '';

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`ADB screenshot timeout (${timeoutMs}ms) for ${serial}`));
      }, timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', (d) => { errBuf += d.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && chunks.length > 0) {
          const fullBuf = Buffer.concat(chunks);
          resolve(fullBuf.toString('base64'));
        } else {
          reject(new Error(`screencap failed with exit code ${code}: ${errBuf || 'empty buffer'}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Launch application by package name with 3-tier fallback. */
  async openApp(serial: string, packageName: string): Promise<void> {
    // 1. First try monkey runner
    try {
      const res = await this.shell(serial, `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
      if (!res.includes('No activities found') && !res.includes('monkey aborted') && !res.includes('** Error')) {
        return;
      }
    } catch {
      // fallback
    }

    // 2. Try resolving main launchable activity via cmd package resolve-activity
    try {
      const actRaw = await this.shell(serial, `cmd package resolve-activity --brief ${packageName}`);
      const match = actRaw.match(/([a-zA-Z0-9_.]+\/[a-zA-Z0-9_.]+)/);
      if (match && !match[1].includes('ResolverActivity')) {
        await this.shell(serial, `am start -n ${match[1]}`);
        return;
      }
    } catch {
      // fallback
    }

    // 3. Standard am start intent action MAIN category LAUNCHER
    await this.shell(serial, `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${packageName}`);
  }

  /** Open deep link or URL via Android Intent. */
  async openUrl(serial: string, url: string, packageName?: string): Promise<void> {
    const pkgArg = packageName ? ` ${packageName}` : '';
    await this.shell(serial, `am start -a android.intent.action.VIEW -d "${url}"${pkgArg}`);
  }

  /** Tap screen at (x, y). */
  async tap(serial: string, x: number, y: number): Promise<void> {
    await this.shell(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  /** Swipe from (x1, y1) to (x2, y2) over durationMs. */
  async swipe(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    await this.shell(serial, `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`);
  }

  /** Input text string. */
  async inputText(serial: string, text: string): Promise<void> {
    // Escape shell-sensitive characters
    const escaped = text.replace(/([ "$\\`'()|&;<>*?~])/g, '\\$1');
    await this.shell(serial, `input text ${escaped}`);
  }

  /** Send keyevent (e.g. 3 = HOME, 4 = BACK, 224 = WAKEUP, 26 = POWER). */
  async keyevent(serial: string, code: number): Promise<void> {
    await this.shell(serial, `input keyevent ${code}`);
  }

  /** Wake up and turn screen on. */
  async wakeUp(serial: string): Promise<void> {
    await this.keyevent(serial, 224);
  }

  /** Press Home button. */
  async home(serial: string): Promise<void> {
    await this.keyevent(serial, 3);
  }

  /** Press Back button. */
  async back(serial: string): Promise<void> {
    await this.keyevent(serial, 4);
  }

  /** Press App Switcher / Recent Apps button. */
  async recents(serial: string): Promise<void> {
    await this.keyevent(serial, 187);
  }

  /** Press Power / Lock button. */
  async power(serial: string): Promise<void> {
    await this.keyevent(serial, 26);
  }

  /** Volume Up. */
  async volumeUp(serial: string): Promise<void> {
    await this.keyevent(serial, 24);
  }

  /** Volume Down. */
  async volumeDown(serial: string): Promise<void> {
    await this.keyevent(serial, 25);
  }

  /** Reboot board. */
  async reboot(serial: string): Promise<void> {
    await this.exec(['-s', serial, 'reboot']);
  }

  /** Get current device screen orientation (0 = 0°, 1 = 90°, 2 = 180°, 3 = 270°). */
  async getOrientation(serial: string): Promise<number> {
    try {
      const out = await this.shell(serial, 'dumpsys window');
      const m = out.match(/mCurrentRotation=(\d)/i) || out.match(/orientation=(\d)/i);
      if (m) {
        return parseInt(m[1], 10);
      }
    } catch {
      // fallback
    }
    return 0;
  }

  /** Force device orientation: 0 = Portrait (0°), 1 = Landscape (90°). */
  async setOrientation(serial: string, orientation: 0 | 1): Promise<void> {
    // Disable accelerometer auto-rotation to prevent hardware sensors from snapping back
    await this.shell(serial, 'settings put system accelerometer_rotation 0');
    await this.shell(serial, `settings put system user_rotation ${orientation}`);
  }

  /** Determine currently focused / foreground package name. */
  async getForegroundApp(serial: string): Promise<string | undefined> {
    try {
      const out = await this.shell(serial, 'dumpsys window');
      const m = out.match(/mCurrentFocus=Window\{[^\}]*\s+([a-zA-Z0-9_.]+)\//) ||
                out.match(/mFocusedApp=AppWindowToken\{[^\}]*\s+([a-zA-Z0-9_.]+)\//);
      if (m && m[1] && m[1] !== 'com.android.systemui') {
        return m[1];
      }
    } catch {}
    try {
      const out = await this.shell(serial, 'dumpsys activity activities');
      const m = out.match(/topResumedActivity=ActivityRecord\{[^\}]*\s+([a-zA-Z0-9_.]+)\//) ||
                out.match(/ResumedActivity: ActivityRecord\{[^\}]*\s+([a-zA-Z0-9_.]+)\//);
      if (m && m[1]) return m[1];
    } catch {}
    return undefined;
  }

  /**
   * Auto-grant all common Android runtime permissions via ADB.
   * If packageName is omitted, targets the currently focused foreground app.
   */
  async grantAllPermissions(serial: string, packageName?: string): Promise<{ ok: boolean; targetPackage?: string; grantedCount: number }> {
    const pkg = packageName || (await this.getForegroundApp(serial));
    if (!pkg) {
      return { ok: false, grantedCount: 0 };
    }

    const permissions = [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.POST_NOTIFICATIONS',
    ];

    let grantedCount = 0;
    for (const perm of permissions) {
      try {
        await this.shell(serial, `pm grant ${pkg} ${perm}`);
        grantedCount++;
      } catch {
        // Not all apps declare all permissions, ignore failed grants
      }
    }

    try {
      await this.shell(serial, `appops set ${pkg} SYSTEM_ALERT_WINDOW allow`);
    } catch {}

    this.logger.info({ serial, pkg, grantedCount }, 'adb: auto-granted runtime permissions');
    return { ok: true, targetPackage: pkg, grantedCount };
  }

  /**
   * Confirms system runtime permission dialogs ("Подтвердить права"):
   * Sends DPAD hardware keys (Down + Right + Enter) to trigger "Allow",
   * and also grants all permissions via ADB pm grant.
   */
  async acceptPermissionDialog(serial: string): Promise<void> {
    // 1. Send D-Pad navigation to focus and trigger the "Allow" button on system dialog
    try {
      await this.keyevent(serial, 20); // KEYCODE_DPAD_DOWN
      await this.keyevent(serial, 22); // KEYCODE_DPAD_RIGHT
      await this.keyevent(serial, 66); // KEYCODE_ENTER
    } catch {}

    // 2. Also run pm grant for all permissions on the active app
    await this.grantAllPermissions(serial);
  }

  private screenSizeCache = new Map<string, { width: number; height: number }>();

  /** Get screen dimensions [width, height] with in-memory caching. */
  async getScreenSize(serial: string): Promise<{ width: number; height: number }> {
    const cached = this.screenSizeCache.get(serial);
    if (cached) return cached;

    try {
      const out = await this.shell(serial, 'wm size');
      const m = out.match(/Physical size:\s*(\d+)x(\d+)/i) || out.match(/(\d+)x(\d+)/);
      if (m) {
        const size = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
        this.screenSizeCache.set(serial, size);
        return size;
      }
    } catch {
      // ignore
    }
    const fallback = { width: 1080, height: 2220 }; // Standard Samsung S8+ resolution
    this.screenSizeCache.set(serial, fallback);
    return fallback;
  }

  /** Resolve normalized coordinates (0.0 - 1.0) or absolute pixels against device resolution & rotation. */
  async resolveCoordinates(serial: string, xPercent?: number, yPercent?: number, x?: number, y?: number): Promise<{ x: number; y: number }> {
    if (x !== undefined && y !== undefined && xPercent === undefined && yPercent === undefined) {
      return { x: Math.round(x), y: Math.round(y) };
    }
    const size = await this.getScreenSize(serial);
    const orientation = await this.getOrientation(serial);

    // If rotated 90° or 270° (landscape), swap width and height in display coordinate space
    let displayWidth = size.width;
    let displayHeight = size.height;
    if (orientation === 1 || orientation === 3) {
      if (size.width < size.height) {
        displayWidth = size.height;
        displayHeight = size.width;
      }
    } else {
      if (size.width > size.height) {
        displayWidth = size.height;
        displayHeight = size.width;
      }
    }

    const resolvedX = xPercent !== undefined ? Math.round(xPercent * displayWidth) : (x ?? Math.round(displayWidth / 2));
    const resolvedY = yPercent !== undefined ? Math.round(yPercent * displayHeight) : (y ?? Math.round(displayHeight / 2));
    return {
      x: Math.max(0, Math.min(displayWidth - 1, resolvedX)),
      y: Math.max(0, Math.min(displayHeight - 1, resolvedY)),
    };
  }

  /** Install APK file on device. Supports reinstall (-r) and granting all runtime permissions (-g). */
  async installApk(
    serial: string,
    apkPath: string,
    options: { reinstall?: boolean; grantPermissions?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    const { reinstall = true, grantPermissions = true } = options;
    const args = ['-s', serial, 'install'];
    if (reinstall) args.push('-r');
    if (grantPermissions) args.push('-g');
    args.push(apkPath);

    this.logger.info({ serial, apkPath, options }, 'adb: installing apk');
    try {
      const output = await this.exec(args, 180_000); // 3 min timeout for large APKs
      const isSuccess = output.includes('Success');
      return { ok: isSuccess, output };
    } catch (err: any) {
      this.logger.error({ serial, apkPath, err: err.message }, 'adb: installApk error');
      return { ok: false, output: err.message };
    }
  }

  /** Uninstall application by package name. */
  async uninstallApp(serial: string, packageName: string, keepData = false): Promise<{ ok: boolean; output: string }> {
    const args = ['-s', serial, 'uninstall'];
    if (keepData) args.push('-k');
    args.push(packageName);

    this.logger.info({ serial, packageName, keepData }, 'adb: uninstalling app');
    try {
      const output = await this.exec(args, 60_000);
      const isSuccess = output.includes('Success');
      return { ok: isSuccess, output };
    } catch (err: any) {
      return { ok: false, output: err.message };
    }
  }

  /** Clear application data and cache (pm clear). Instantly resets app state and sessions. */
  async clearAppData(serial: string, packageName: string): Promise<{ ok: boolean; output: string }> {
    try {
      const output = await this.shell(serial, `pm clear ${packageName}`);
      const isSuccess = output.includes('Success');
      return { ok: isSuccess, output };
    } catch (err: any) {
      return { ok: false, output: err.message };
    }
  }

  /** Force stop application (am force-stop). */
  async stopApp(serial: string, packageName: string): Promise<{ ok: boolean; output: string }> {
    try {
      const output = await this.shell(serial, `am force-stop ${packageName}`);
      return { ok: true, output };
    } catch (err: any) {
      return { ok: false, output: err.message };
    }
  }

  /** List installed packages. thirdPartyOnly filters system apps. */
  async listPackages(serial: string, thirdPartyOnly = true): Promise<string[]> {
    try {
      const flag = thirdPartyOnly ? '-3' : '';
      const raw = await this.shell(serial, `pm list packages ${flag}`);
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice(8).trim())
        .filter(Boolean)
        .sort();
    } catch (err: any) {
      this.logger.error({ serial, err: err.message }, 'adb: listPackages error');
      return [];
    }
  }
}
