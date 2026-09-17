import { randomUUID } from 'crypto';
import { getRedis } from './redis';
import { logger as rootLogger } from '../logger';
import { deviceAgentClient } from './device-agent';

const logger = rootLogger.child({ module: 'farm-scheduler' });

export interface FarmSchedule {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  isActive: boolean;
  triggerType: 'interval' | 'cron' | 'once';
  intervalMinutes?: number;
  cronExpression?: string;
  runOnceAt?: string;
  jitterMinutes?: number; // +/- minutes random offset
  engine: 'adb_flow' | 'autojs';
  presetId?: string;
  steps?: any[];
  jsCode?: string;
  variables?: Record<string, string>;
  targetMode: 'all' | 'custom';
  targetDeviceIds?: string[];
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed' | 'partial';
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FarmScheduleRunLog {
  id: string;
  scheduleId: string;
  scheduleName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'success' | 'failed' | 'partial';
  targetsCount: number;
  successful: number;
  failed: number;
  devices: Record<string, { ok: boolean; stepsExecuted: number; totalSteps: number; error?: string }>;
  error?: string;
}

/**
 * Standard 5-field cron parser for (min hour dom mon dow).
 */
export function nextCronDate(cron: string, fromDate = new Date()): Date | null {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const start = new Date(fromDate.getTime() + 60_000);
    start.setSeconds(0, 0);
    const end = new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days lookup

    const matchField = (field: string, value: number): boolean => {
      if (field === '*') return true;
      if (field.includes('/')) {
        const [range, stepStr] = field.split('/');
        const step = parseInt(stepStr, 10);
        if (range === '*') return value % step === 0;
        const [lo, hi] = range.split('-').map(Number);
        return value >= lo && value <= hi && (value - lo) % step === 0;
      }
      if (field.includes('-')) {
        const [lo, hi] = field.split('-').map(Number);
        return value >= lo && value <= hi;
      }
      if (field.includes(',')) {
        return field.split(',').map(Number).includes(value);
      }
      return parseInt(field, 10) === value;
    };

    for (let t = start.getTime(); t < end.getTime(); t += 60_000) {
      const d = new Date(t);
      if (
        matchField(parts[0], d.getMinutes()) &&
        matchField(parts[1], d.getHours()) &&
        matchField(parts[2], d.getDate()) &&
        matchField(parts[3], d.getMonth() + 1) &&
        matchField(parts[4], d.getDay())
      ) {
        return d;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Calculate the next execution time with anti-detection jitter.
 */
export function calculateNextRun(schedule: Partial<FarmSchedule>, fromDate = new Date()): string | null {
  const { triggerType, intervalMinutes, cronExpression, runOnceAt, jitterMinutes = 0 } = schedule;
  let targetDate: Date | null = null;

  if (triggerType === 'once') {
    if (runOnceAt && new Date(runOnceAt).getTime() > fromDate.getTime()) {
      return new Date(runOnceAt).toISOString();
    }
    return null;
  }

  if (triggerType === 'interval') {
    const mins = intervalMinutes && intervalMinutes > 0 ? intervalMinutes : 60;
    targetDate = new Date(fromDate.getTime() + mins * 60_000);
  } else if (triggerType === 'cron' && cronExpression) {
    targetDate = nextCronDate(cronExpression, fromDate);
  }

  if (!targetDate) return null;

  // Apply random jitter if specified (+/- jitterMinutes)
  if (jitterMinutes > 0) {
    const jitterMs = Math.round((Math.random() * 2 - 1) * jitterMinutes * 60_000);
    targetDate = new Date(targetDate.getTime() + jitterMs);
    // Don't schedule in the past
    if (targetDate.getTime() <= fromDate.getTime()) {
      targetDate = new Date(fromDate.getTime() + 30_000);
    }
  }

  return targetDate.toISOString();
}

export class FarmSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly TENANTS_SET_KEY = 'kmmzavod:farm_tenants_with_schedules';

  /**
   * Start 30-second background polling cycle.
   */
  start(): void {
    if (this.timer) return;
    logger.info('Starting FarmSchedulerService background loop (30s tick)');

    // Run first tick after 5 seconds to let connections establish
    setTimeout(() => this.tick(), 5000);
    this.timer = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Stopped FarmSchedulerService');
    }
  }

  /**
   * Main scheduler tick.
   */
  async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const redis = getRedis();
      const tenantIds = await redis.smembers(this.TENANTS_SET_KEY);
      if (!tenantIds || tenantIds.length === 0) {
        this.isProcessing = false;
        return;
      }

      const now = new Date();

      for (const tenantId of tenantIds) {
        const key = `kmmzavod:farm_schedules:${tenantId}`;
        const raw = await redis.get(key);
        if (!raw) continue;

        let schedules: FarmSchedule[] = [];
        try {
          schedules = JSON.parse(raw);
        } catch {
          continue;
        }

        let modified = false;

        for (const schedule of schedules) {
          if (!schedule.isActive) continue;

          // Check if scheduled time has arrived
          if (schedule.nextRunAt && new Date(schedule.nextRunAt) <= now) {
            logger.info(
              { scheduleId: schedule.id, name: schedule.name, tenantId },
              'FarmScheduler: triggering scheduled task execution',
            );

            // Execute asynchronously without blocking the loop
            this.executeSchedule(schedule).catch((err) => {
              logger.error({ err, scheduleId: schedule.id }, 'FarmScheduler: execution error');
            });

            // Update next execution time
            schedule.lastRunAt = now.toISOString();
            if (schedule.triggerType === 'once') {
              schedule.isActive = false;
              schedule.nextRunAt = undefined;
            } else {
              schedule.nextRunAt = calculateNextRun(schedule, now) || undefined;
            }
            schedule.updatedAt = new Date().toISOString();
            modified = true;
          }
        }

        if (modified) {
          await redis.set(key, JSON.stringify(schedules));
        }
      }
    } catch (err) {
      logger.error({ err }, 'FarmScheduler: tick failed');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a schedule immediately and record run log.
   */
  async executeSchedule(schedule: FarmSchedule): Promise<FarmScheduleRunLog> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const redis = getRedis();

    let targetIds: string[] = [];
    try {
      if (schedule.targetMode === 'all') {
        const devList = await deviceAgentClient.listDevices();
        if (devList.ok && Array.isArray((devList.raw as any))) {
          targetIds = (devList.raw as any[]).filter((d) => d.state === 'device').map((d) => d.serial);
        }
        if (targetIds.length === 0 && schedule.targetDeviceIds && schedule.targetDeviceIds.length > 0) {
          targetIds = schedule.targetDeviceIds;
        }
      } else {
        targetIds = schedule.targetDeviceIds || [];
      }
    } catch (err: any) {
      logger.warn({ err }, 'FarmScheduler: could not retrieve dynamic device list, using targetDeviceIds fallback');
      targetIds = schedule.targetDeviceIds || [];
    }

    if (targetIds.length === 0) {
      const errorLog: FarmScheduleRunLog = {
        id: randomUUID(),
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: 'failed',
        targetsCount: 0,
        successful: 0,
        failed: 0,
        devices: {},
        error: 'Нет доступных плат для запуска (стойка офлайн или не выбраны устройства)',
      };
      await this.saveRunLog(schedule.tenantId, schedule.id, errorLog);
      return errorLog;
    }

    try {
      const res = await deviceAgentClient.runScript({
        engine: schedule.engine,
        steps: schedule.steps,
        jsCode: schedule.jsCode,
        targetDeviceIds: targetIds,
        variables: schedule.variables,
        scriptName: `${schedule.id}.js`,
      });

      const devicesSummary: Record<string, { ok: boolean; stepsExecuted: number; totalSteps: number; error?: string }> = {};
      if (res.devices) {
        for (const [serial, d] of Object.entries(res.devices)) {
          devicesSummary[serial] = {
            ok: d.ok,
            stepsExecuted: d.stepsExecuted,
            totalSteps: d.totalSteps,
            error: d.error,
          };
        }
      }

      const status: 'success' | 'failed' | 'partial' =
        res.successful === res.targetsCount
          ? 'success'
          : res.successful > 0
          ? 'partial'
          : 'failed';

      const log: FarmScheduleRunLog = {
        id: randomUUID(),
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status,
        targetsCount: res.targetsCount,
        successful: res.successful,
        failed: res.failed,
        devices: devicesSummary,
      };

      await this.saveRunLog(schedule.tenantId, schedule.id, log);

      // Update schedule's lastRunStatus in Redis
      await this.updateScheduleLastStatus(schedule.tenantId, schedule.id, status);

      return log;
    } catch (err: any) {
      const errorLog: FarmScheduleRunLog = {
        id: randomUUID(),
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: 'failed',
        targetsCount: targetIds.length,
        successful: 0,
        failed: targetIds.length,
        devices: {},
        error: err.message || String(err),
      };
      await this.saveRunLog(schedule.tenantId, schedule.id, errorLog);
      await this.updateScheduleLastStatus(schedule.tenantId, schedule.id, 'failed');
      return errorLog;
    }
  }

  private async saveRunLog(tenantId: string, scheduleId: string, log: FarmScheduleRunLog): Promise<void> {
    try {
      const redis = getRedis();
      const historyKey = `kmmzavod:farm_schedule_runs:${tenantId}:${scheduleId}`;
      await redis.lpush(historyKey, JSON.stringify(log));
      await redis.ltrim(historyKey, 0, 49); // Keep last 50 execution runs
    } catch (err) {
      logger.error({ err }, 'Failed to save schedule run log');
    }
  }

  private async updateScheduleLastStatus(tenantId: string, scheduleId: string, status: 'success' | 'failed' | 'partial'): Promise<void> {
    try {
      const redis = getRedis();
      const key = `kmmzavod:farm_schedules:${tenantId}`;
      const raw = await redis.get(key);
      if (!raw) return;

      const schedules: FarmSchedule[] = JSON.parse(raw);
      const target = schedules.find((s) => s.id === scheduleId);
      if (target) {
        target.lastRunStatus = status;
        target.updatedAt = new Date().toISOString();
        await redis.set(key, JSON.stringify(schedules));
      }
    } catch {
      // ignore
    }
  }

  // ── CRUD Methods for API Routes ───────────────────────────────────────────

  async listSchedules(tenantId: string): Promise<FarmSchedule[]> {
    const redis = getRedis();
    const key = `kmmzavod:farm_schedules:${tenantId}`;
    try {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  async saveSchedule(tenantId: string, data: Partial<FarmSchedule>): Promise<FarmSchedule> {
    const redis = getRedis();
    const key = `kmmzavod:farm_schedules:${tenantId}`;
    const schedules = await this.listSchedules(tenantId);

    const scheduleId = data.id || randomUUID();
    const existingIndex = schedules.findIndex((s) => s.id === scheduleId);

    const isActive = data.isActive !== undefined ? data.isActive : true;
    const nextRunAt = isActive ? calculateNextRun(data, new Date()) || undefined : undefined;

    const record: FarmSchedule = {
      id: scheduleId,
      tenantId,
      name: data.name || 'Сценарий по расписанию',
      description: data.description,
      isActive,
      triggerType: data.triggerType || 'interval',
      intervalMinutes: data.intervalMinutes,
      cronExpression: data.cronExpression,
      runOnceAt: data.runOnceAt,
      jitterMinutes: data.jitterMinutes ?? 10,
      engine: data.engine || 'adb_flow',
      presetId: data.presetId,
      steps: data.steps,
      jsCode: data.jsCode,
      variables: data.variables,
      targetMode: data.targetMode || 'all',
      targetDeviceIds: data.targetDeviceIds || [],
      nextRunAt,
      lastRunAt: existingIndex >= 0 ? schedules[existingIndex].lastRunAt : undefined,
      lastRunStatus: existingIndex >= 0 ? schedules[existingIndex].lastRunStatus : undefined,
      createdAt: existingIndex >= 0 ? schedules[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      schedules[existingIndex] = record;
    } else {
      schedules.unshift(record);
    }

    await redis.set(key, JSON.stringify(schedules));
    await redis.sadd(this.TENANTS_SET_KEY, tenantId);

    return record;
  }

  async deleteSchedule(tenantId: string, scheduleId: string): Promise<boolean> {
    const redis = getRedis();
    const key = `kmmzavod:farm_schedules:${tenantId}`;
    let schedules = await this.listSchedules(tenantId);
    schedules = schedules.filter((s) => s.id !== scheduleId);
    await redis.set(key, JSON.stringify(schedules));

    // Also delete history
    await redis.del(`kmmzavod:farm_schedule_runs:${tenantId}:${scheduleId}`);
    return true;
  }

  async toggleSchedule(tenantId: string, scheduleId: string, isActive: boolean): Promise<FarmSchedule | null> {
    const schedules = await this.listSchedules(tenantId);
    const target = schedules.find((s) => s.id === scheduleId);
    if (!target) return null;

    target.isActive = isActive;
    target.updatedAt = new Date().toISOString();
    if (isActive) {
      target.nextRunAt = calculateNextRun(target, new Date()) || undefined;
    } else {
      target.nextRunAt = undefined;
    }

    const redis = getRedis();
    await redis.set(`kmmzavod:farm_schedules:${tenantId}`, JSON.stringify(schedules));
    return target;
  }

  async getScheduleHistory(tenantId: string, scheduleId: string, limit = 20): Promise<FarmScheduleRunLog[]> {
    const redis = getRedis();
    const historyKey = `kmmzavod:farm_schedule_runs:${tenantId}:${scheduleId}`;
    try {
      const items = await redis.lrange(historyKey, 0, limit - 1);
      return items.map((item) => JSON.parse(item));
    } catch {
      return [];
    }
  }
}

export const farmScheduler = new FarmSchedulerService();
