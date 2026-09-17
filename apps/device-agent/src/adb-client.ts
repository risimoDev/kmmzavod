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

  /** Launch application by package name. */
  async openApp(serial: string, packageName: string): Promise<void> {
    await this.shell(serial, `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
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

  /** Resolve normalized coordinates (0.0 - 1.0) or absolute pixels against device resolution. */
  async resolveCoordinates(serial: string, xPercent?: number, yPercent?: number, x?: number, y?: number): Promise<{ x: number; y: number }> {
    if (x !== undefined && y !== undefined && xPercent === undefined && yPercent === undefined) {
      return { x: Math.round(x), y: Math.round(y) };
    }
    const size = await this.getScreenSize(serial);
    const resolvedX = xPercent !== undefined ? Math.round(xPercent * size.width) : (x ?? Math.round(size.width / 2));
    const resolvedY = yPercent !== undefined ? Math.round(yPercent * size.height) : (y ?? Math.round(size.height / 2));
    return {
      x: Math.max(0, Math.min(size.width - 1, resolvedX)),
      y: Math.max(0, Math.min(size.height - 1, resolvedY)),
    };
  }
}
