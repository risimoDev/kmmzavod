import type { Logger } from 'pino';
import { AdbClient } from './adb-client';

export interface BoardHealthInfo {
  deviceId: string;
  online: boolean;
  batteryLevel?: number;
  batteryTemp?: number;
  freeRamMb?: number;
  currentFocus?: string;
  error?: string;
}

export class AutoHealManager {
  constructor(
    private readonly adb: AdbClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Applies critical phone farm rack settings to prevent motherboards from sleeping,
   * disconnecting from USB/ADB, or locking up.
   */
  async optimizeBoard(deviceId: string): Promise<{ ok: boolean; message: string }> {
    this.logger.info({ deviceId }, 'auto-heal: applying rack optimizations');

    const commands = [
      // 1. Never sleep while plugged into USB / DC-DC power (Value 3 = AC + USB)
      'settings put global stay_on_while_plugged_in 3',
      // 2. Max screen timeout
      'settings put system screen_off_timeout 2147483647',
      // 3. Disable lockscreen / PIN swipe
      'settings put secure lockscreen.disabled 1',
      // 4. Dismiss any active keyguard
      'wm dismiss-keyguard',
      // 5. Accelerate animation scale for faster UI automation
      'settings put global window_animation_scale 0.5',
      'settings put global transition_animation_scale 0.5',
      'settings put global animator_duration_scale 0.5',
      // 6. Wake up screen
      'input keyevent 224',
    ];

    try {
      await this.adb.shell(deviceId, commands.join(' && '));
      return { ok: true, message: `Плата ${deviceId} оптимизирована (сна нет, блокировка снята, анимации ускорены)` };
    } catch (err) {
      this.logger.error({ deviceId, err }, 'auto-heal: optimization failed');
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Dismisses any ANR («Приложение не отвечает») or system crash popups on the screen.
   */
  async dismissSystemDialogs(deviceId: string): Promise<{ ok: boolean }> {
    try {
      // Press BACK twice and HOME to dismiss dialog overlays
      await this.adb.shell(deviceId, 'input keyevent 4 && input keyevent 4 && input keyevent 3');
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  }

  /**
   * Collect hardware and RAM health diagnostics from the Android board.
   */
  async getBoardHealth(deviceId: string): Promise<BoardHealthInfo> {
    try {
      // Run battery & proc meminfo: fast, universal, zero hanging
      const cmd = 'dumpsys battery; cat /proc/meminfo';
      const rawRes = await this.adb.shell(deviceId, cmd);
      let text = '';
      if (typeof rawRes === 'string') {
        text = rawRes;
      } else if (rawRes && typeof rawRes === 'object') {
        text = String((rawRes as any).data ?? (rawRes as any).result ?? (rawRes as any).output ?? JSON.stringify(rawRes));
      }

      const levelMatch = text.match(/level:\s*(\d+)/i);
      const tempMatch = text.match(/temperature:\s*(\d+)/i);
      const ramMatch = text.match(/MemAvailable:\s*(\d+)\s*kB/i) || text.match(/MemFree:\s*(\d+)\s*kB/i) || text.match(/Free RAM:\s*([0-9,]+)\s*kB/i);

      const batteryLevel = levelMatch ? parseInt(levelMatch[1], 10) : 100;
      const batteryTemp = tempMatch ? Math.round(parseInt(tempMatch[1], 10) / 10) : 35; // dumpsys temp is in tenths of C
      const freeRamMb = ramMatch ? Math.round(parseInt(ramMatch[1].replace(/,/g, ''), 10) / 1024) : undefined;

      return {
        deviceId,
        online: true,
        batteryLevel,
        batteryTemp,
        freeRamMb,
      };
    } catch (err) {
      return {
        deviceId,
        online: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Optimize all boards in the rack simultaneously.
   */
  async optimizeAllBoards(deviceIds: string[]): Promise<Array<{ deviceId: string; ok: boolean; message: string }>> {
    const results = await Promise.all(
      deviceIds.map(async (id) => {
        const res = await this.optimizeBoard(id);
        return { deviceId: id, ...res };
      }),
    );
    return results;
  }
}
