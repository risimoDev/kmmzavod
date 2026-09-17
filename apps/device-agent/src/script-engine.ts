import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Logger } from 'pino';
import { AdbClient } from './adb-client';

export type FlowStep =
  | { type: 'launch'; packageName: string }
  | { type: 'sleep'; durationMs: number; jitterMs?: number }
  | { type: 'tap'; xPercent?: number; yPercent?: number; x?: number; y?: number }
  | { type: 'swipe'; x1Percent: number; y1Percent: number; x2Percent: number; y2Percent: number; durationMs?: number }
  | { type: 'random_scroll'; count?: number; direction?: 'up' | 'down'; minDelayMs?: number; maxDelayMs?: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: 'home' | 'back' | 'recents' | 'power' | 'enter' | 'volume_up' | 'volume_down' | number }
  | { type: 'clear_data'; packageName: string }
  | { type: 'stop_app'; packageName: string }
  | { type: 'open_url'; url: string; packageName?: string }
  | { type: 'shell'; command: string };

export interface StepLog {
  stepIndex: number;
  type: string;
  description: string;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

export interface DeviceScriptExecutionResult {
  serial: string;
  ok: boolean;
  stepsExecuted: number;
  totalSteps: number;
  totalDurationMs: number;
  stepLogs: StepLog[];
  error?: string;
}

export interface RunBatchScriptOptions {
  engine: 'adb_flow' | 'autojs';
  steps?: FlowStep[];
  jsCode?: string;
  targetDeviceIds: string[];
  variables?: Record<string, string>;
  scriptName?: string;
}

export interface RunBatchScriptResult {
  ok: boolean;
  engine: 'adb_flow' | 'autojs';
  targetsCount: number;
  successful: number;
  failed: number;
  devices: Record<string, DeviceScriptExecutionResult>;
}

export class ScriptEngine {
  private tempDir: string;

  constructor(private logger: Logger) {
    this.tempDir = path.join(os.tmpdir(), 'kmmzavod-scripts');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Replace {{VARIABLE}} patterns in string with provided variable dictionary.
   */
  private substituteVariables(str: string, vars?: Record<string, string>): string {
    if (!vars) return str;
    let result = str;
    for (const [k, v] of Object.entries(vars)) {
      const reg = new RegExp(`{{\\s*${k}\\s*}}`, 'gi');
      result = result.replace(reg, v);
    }
    return result;
  }

  /**
   * Helper delay.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /**
   * Execute a single Native ADB Flow Step on a device.
   */
  async executeStep(
    adb: AdbClient,
    serial: string,
    step: FlowStep,
    stepIndex: number,
    vars?: Record<string, string>,
  ): Promise<StepLog> {
    const startTime = Date.now();
    let description = '';

    try {
      switch (step.type) {
        case 'launch': {
          const pkg = this.substituteVariables(step.packageName, vars);
          description = `Launch app: ${pkg}`;
          await adb.openApp(serial, pkg);
          break;
        }

        case 'sleep': {
          const jitter = step.jitterMs ? Math.floor(Math.random() * step.jitterMs) : 0;
          const totalMs = step.durationMs + jitter;
          description = `Pause: ${totalMs}ms (jitter: ${jitter}ms)`;
          await this.sleep(totalMs);
          break;
        }

        case 'tap': {
          const coords = await adb.resolveCoordinates(serial, step.xPercent, step.yPercent, step.x, step.y);
          description = `Tap at (${coords.x}, ${coords.y})`;
          await adb.tap(serial, coords.x, coords.y);
          break;
        }

        case 'swipe': {
          const size = await adb.getScreenSize(serial);
          const x1 = Math.round(step.x1Percent * size.width);
          const y1 = Math.round(step.y1Percent * size.height);
          const x2 = Math.round(step.x2Percent * size.width);
          const y2 = Math.round(step.y2Percent * size.height);
          const dur = step.durationMs || 300;
          description = `Swipe: (${x1}, ${y1}) -> (${x2}, ${y2}) [${dur}ms]`;
          await adb.swipe(serial, x1, y1, x2, y2, dur);
          break;
        }

        case 'random_scroll': {
          const count = step.count || 3;
          const direction = step.direction || 'down';
          const minDelay = step.minDelayMs || 800;
          const maxDelay = step.maxDelayMs || 2000;
          const size = await adb.getScreenSize(serial);

          description = `Random scroll: ${count} times (${direction})`;

          for (let i = 0; i < count; i++) {
            // Humanized touch coords with slight random offsets
            const x = Math.round(size.width * (0.45 + (Math.random() * 0.1 - 0.05)));
            let y1: number, y2: number;

            if (direction === 'down') {
              // Swipe up to scroll down
              y1 = Math.round(size.height * (0.7 + (Math.random() * 0.1 - 0.05)));
              y2 = Math.round(size.height * (0.3 + (Math.random() * 0.1 - 0.05)));
            } else {
              // Swipe down to scroll up
              y1 = Math.round(size.height * (0.3 + (Math.random() * 0.1 - 0.05)));
              y2 = Math.round(size.height * (0.7 + (Math.random() * 0.1 - 0.05)));
            }

            const swipeDur = Math.round(250 + Math.random() * 200);
            await adb.swipe(serial, x, y1, x, y2, swipeDur);

            const delay = Math.round(minDelay + Math.random() * (maxDelay - minDelay));
            await this.sleep(delay);
          }
          break;
        }

        case 'text': {
          const raw = this.substituteVariables(step.text, vars);
          description = `Input text: "${raw.slice(0, 30)}${raw.length > 30 ? '...' : ''}"`;
          await adb.inputText(serial, raw);
          break;
        }

        case 'key': {
          let code: number;
          if (typeof step.key === 'number') {
            code = step.key;
          } else {
            const keyMap: Record<string, number> = {
              home: 3,
              back: 4,
              recents: 187,
              power: 26,
              enter: 66,
              volume_up: 24,
              volume_down: 25,
            };
            code = keyMap[step.key] ?? 3;
          }
          description = `Key event: ${step.key} (code ${code})`;
          await adb.keyevent(serial, code);
          break;
        }

        case 'clear_data': {
          const pkg = this.substituteVariables(step.packageName, vars);
          description = `Clear app data (pm clear): ${pkg}`;
          await adb.clearAppData(serial, pkg);
          break;
        }

        case 'stop_app': {
          const pkg = this.substituteVariables(step.packageName, vars);
          description = `Force stop app (am force-stop): ${pkg}`;
          await adb.stopApp(serial, pkg);
          break;
        }

        case 'open_url': {
          const url = this.substituteVariables(step.url, vars);
          const pkg = step.packageName ? this.substituteVariables(step.packageName, vars) : undefined;
          description = `Open URL: ${url}${pkg ? ` [${pkg}]` : ''}`;
          await adb.openUrl(serial, url, pkg);
          break;
        }

        case 'shell': {
          const cmd = this.substituteVariables(step.command, vars);
          description = `Shell: ${cmd}`;
          await adb.shell(serial, cmd);
          break;
        }

        default:
          description = `Unknown step: ${(step as any).type}`;
      }

      return {
        stepIndex,
        type: step.type,
        description,
        status: 'success',
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        stepIndex,
        type: step.type,
        description,
        status: 'failed',
        durationMs: Date.now() - startTime,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Run a sequence of FlowSteps on a single device.
   */
  async runAdbFlow(
    adb: AdbClient,
    serial: string,
    steps: FlowStep[],
    vars?: Record<string, string>,
  ): Promise<DeviceScriptExecutionResult> {
    const start = Date.now();
    const stepLogs: StepLog[] = [];
    let stepsExecuted = 0;
    let failedError: string | undefined;

    this.logger.info({ serial, stepsCount: steps.length }, 'ScriptEngine: starting ADB Flow on device');

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const log = await this.executeStep(adb, serial, step, i + 1, vars);
      stepLogs.push(log);

      if (log.status === 'failed') {
        failedError = log.error;
        this.logger.warn({ serial, step: i + 1, error: log.error }, 'ScriptEngine: step failed');
        // Stop execution of subsequent steps on failure
        break;
      }
      stepsExecuted++;
    }

    const ok = stepLogs.length === steps.length && stepLogs.every((s) => s.status === 'success');

    return {
      serial,
      ok,
      stepsExecuted,
      totalSteps: steps.length,
      totalDurationMs: Date.now() - start,
      stepLogs,
      error: failedError,
    };
  }

  /**
   * Run Auto.js / AutoX.js JavaScript script on a device.
   */
  async runAutoJs(
    adb: AdbClient,
    serial: string,
    jsCode: string,
    scriptName = 'macro.js',
  ): Promise<DeviceScriptExecutionResult> {
    const start = Date.now();
    const stepLogs: StepLog[] = [];

    try {
      // 1. Save JS code to local temporary file
      const safeName = scriptName.endsWith('.js') ? scriptName : `${scriptName}.js`;
      const localFile = path.join(this.tempDir, `${Date.now()}_${safeName}`);
      fs.writeFileSync(localFile, jsCode, 'utf-8');

      stepLogs.push({
        stepIndex: 1,
        type: 'prepare_script',
        description: `Generated script ${safeName} (${jsCode.length} bytes)`,
        status: 'success',
        durationMs: Date.now() - start,
      });

      // 2. Push to Android device storage (/sdcard/AutoX/scripts/)
      const pushStart = Date.now();
      const remoteDir = '/sdcard/AutoX/scripts';
      const remotePath = `${remoteDir}/${safeName}`;

      await adb.shell(serial, `mkdir -p ${remoteDir}`);
      await adb.pushFile(serial, localFile, remotePath);

      // Clean local temp file
      try {
        fs.unlinkSync(localFile);
      } catch {
        // ignore
      }

      stepLogs.push({
        stepIndex: 2,
        type: 'push_script',
        description: `Pushed script to ${remotePath}`,
        status: 'success',
        durationMs: Date.now() - pushStart,
      });

      // 3. Trigger AutoX.js execution via Intent
      const intentStart = Date.now();
      // Try broadcasting to AutoX.js or opening the script
      const triggerCmd = `am start -n org.autojs.autoxjs.v6/org.autojs.autoxjs.external.open.RunIntentActivity -d "file://${remotePath}" -t "application/x-javascript" || am broadcast -a org.autojs.autoxjs.action.RUN_SCRIPT -e path "${remotePath}"`;
      await adb.shell(serial, triggerCmd);

      stepLogs.push({
        stepIndex: 3,
        type: 'launch_autoxjs',
        description: `Triggered AutoX.js runner for ${safeName}`,
        status: 'success',
        durationMs: Date.now() - intentStart,
      });

      return {
        serial,
        ok: true,
        stepsExecuted: 3,
        totalSteps: 3,
        totalDurationMs: Date.now() - start,
        stepLogs,
      };
    } catch (err: any) {
      this.logger.error({ err, serial }, 'ScriptEngine: runAutoJs failed');
      return {
        serial,
        ok: false,
        stepsExecuted: stepLogs.length,
        totalSteps: 3,
        totalDurationMs: Date.now() - start,
        stepLogs,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Run script (Flow or Auto.js) across multiple target devices in parallel.
   */
  async runBatchScript(adb: AdbClient, options: RunBatchScriptOptions): Promise<RunBatchScriptResult> {
    const { engine, steps = [], jsCode = '', targetDeviceIds, variables, scriptName } = options;
    const uniqueSerials = Array.from(new Set(targetDeviceIds));

    this.logger.info(
      { engine, targetCount: uniqueSerials.length, stepsCount: steps.length },
      'ScriptEngine: running batch script on farm',
    );

    const results = await Promise.allSettled(
      uniqueSerials.map(async (serial) => {
        if (engine === 'autojs') {
          return this.runAutoJs(adb, serial, jsCode, scriptName);
        } else {
          return this.runAdbFlow(adb, serial, steps, variables);
        }
      }),
    );

    const devices: Record<string, DeviceScriptExecutionResult> = {};
    let successful = 0;
    let failed = 0;

    results.forEach((res, index) => {
      const serial = uniqueSerials[index];
      if (res.status === 'fulfilled') {
        devices[serial] = res.value;
        if (res.value.ok) {
          successful++;
        } else {
          failed++;
        }
      } else {
        failed++;
        devices[serial] = {
          serial,
          ok: false,
          stepsExecuted: 0,
          totalSteps: steps.length,
          totalDurationMs: 0,
          stepLogs: [],
          error: res.reason instanceof Error ? res.reason.message : String(res.reason),
        };
      }
    });

    return {
      ok: successful > 0,
      engine,
      targetsCount: uniqueSerials.length,
      successful,
      failed,
      devices,
    };
  }
}
