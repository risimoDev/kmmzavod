/**
 * Account warmup worker — прогревает аккаунты фермы (приватные и физические телефоны).
 *
 * 1. Physical Device Farm (authMethod=device, стойка 20 плат):
 *    - Instagram & TikTok: через deviceAgentService.viewTarget
 *    - Выполняет органический просмотр видео в целевой нише (watch time 15–35s, лайки, свайпы)
 *    - Pre-flight anti-leak защита: проверяет внешний IP платы перед запуском
 *
 * 2. Instagram private (authMethod=private): через publisher /instagram/warmup
 *
 * Промоушен статуса:
 *   cold    → warming — после первого успешного прогрева
 *   warming → warm    — после WARM_MIN_ACTIONS прогревов И WARM_MIN_DAYS дней
 *                       с первого прогрева
 *
 * Задачи ставит scheduler.worker (~раз в сутки на аккаунт, с джиттером).
 */
import { Worker, DelayedError, UnrecoverableError, type ConnectionOptions, type Job } from 'bullmq';
import { QUEUES, type AccountWarmupPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger as rootLogger } from '../logger';
import { decrypt, encrypt } from '../lib/crypto';
import { getRedisConnection } from '../lib/redis';
import { publisherService, describePublisherError } from '../services/publisher';
import { deviceAgentService, describeDeviceAgentError } from '../services/device-agent';
import { acquireDeviceLock, releaseDeviceLock, isInfrastructureError } from './publish.worker';

const logger = rootLogger.child({ worker: 'account-warmup' });

/** A busy phone re-queues the warmup after this delay without burning an attempt. */
const DEVICE_BUSY_RETRY_MS = 90_000;

/**
 * Records a failed warmup on the account. healthScore is lowered only once per job
 * (final attempt) and only for account/platform-side failures — a farm/publisher outage
 * must not sink every account below the 30-point floor.
 */
async function recordWarmupFailure(
  db: PrismaClient,
  job: Job<AccountWarmupPayload>,
  err: unknown,
  socialAccountId: string,
  lastError: string,
  rawMessage: string,
): Promise<void> {
  const maxAttempts = job.opts?.attempts ?? 1;
  const isFinal = err instanceof UnrecoverableError || job.attemptsMade + 1 >= maxAttempts;
  const penalize = isFinal && !isInfrastructureError(rawMessage);

  await db.socialAccount.update({
    where: { id: socialAccountId },
    data: {
      lastError: lastError.slice(0, 1000),
      ...(penalize ? { healthScore: { decrement: 5 } } : {}),
    },
  });
  if (penalize) {
    await db.socialAccount.updateMany({
      where: { id: socialAccountId, healthScore: { lt: 0 } },
      data: { healthScore: 0 },
    });
  }
}

/** Minimum successful warmup sessions before an account can become warm. */
const WARM_MIN_ACTIONS = 5;
/** Minimum days since the first warmup before an account can become warm. */
const WARM_MIN_DAYS = 5;

interface Deps {
  db: PrismaClient;
  connection: ConnectionOptions;
}

export function createAccountWarmupWorker(deps: Deps): Worker {
  const { db, connection } = deps;

  return new Worker<AccountWarmupPayload>(
    QUEUES['account-warmup'].name,
    async (job, token) => {
      const { socialAccountId, tenantId } = job.data;

      const account = await db.socialAccount.findUnique({
        where: { id: socialAccountId },
        include: { accountGroup: { select: { niche: true } } },
      });
      if (!account || account.tenantId !== tenantId) {
        logger.warn({ socialAccountId }, 'Warmup: account not found, skipping');
        return;
      }
      if (!account.isActive) {
        logger.info({ socialAccountId, platform: account.platform }, 'Warmup: account inactive, skipping');
        return;
      }

      // ── Physical Phone Farm (authMethod=device, стойка 20 плат) ───────────
      if (account.authMethod === 'device') {
        if (!account.deviceId) {
          logger.warn({ socialAccountId }, 'Warmup: deviceId not assigned to physical account');
          return;
        }
        if (account.platform !== 'instagram' && account.platform !== 'tiktok') {
          logger.info({ socialAccountId, platform: account.platform }, 'Warmup device: platform not supported');
          return;
        }

        // Determine target username from niche or fallback
        const targetUsername = account.niche || account.accountGroup?.niche || (account.platform === 'tiktok' ? 'tiktok' : 'instagram');
        logger.info({ socialAccountId, deviceId: account.deviceId, platform: account.platform, targetUsername }, 'Warmup: executing physical board Smart View');

        // One phone, one task at a time (same lock as the publish worker). TTL covers the
        // whole view-target call (660s timeout) plus margin.
        const redis = getRedisConnection();
        const lockOwner = await acquireDeviceLock(redis, account.deviceId, Math.ceil(660_000 / 1000) + 120);
        if (!lockOwner) {
          // Busy phone is not the account's fault: re-queue later, no attempt used, no penalty.
          logger.info({ socialAccountId, deviceId: account.deviceId }, 'Warmup: phone busy, delaying');
          await job.moveToDelayed(Date.now() + DEVICE_BUSY_RETRY_MS, token);
          throw new DelayedError();
        }

        try {
          const result = await deviceAgentService.viewTarget({
            deviceId: account.deviceId,
            platform: account.platform,
            targetUsername,
            watchDurationSeconds: 18 + Math.floor(Math.random() * 18),
            scrollCount: 2 + Math.floor(Math.random() * 3),
            likeProbability: 0.35,
            checkIpFirst: true,
          });

          if (!result.ok) {
            throw new Error(result.detail || 'device-agent reported failure during smart view');
          }

          const now = new Date();
          const warmupStartedAt = account.warmupStartedAt ?? now;
          const warmupCount = account.warmupCount + 1;

          // Promotion rules
          let warmupStatus = account.warmupStatus;
          if (warmupStatus === 'cold') {
            warmupStatus = 'warming';
          } else if (warmupStatus === 'warming') {
            const daysSinceStart = (now.getTime() - warmupStartedAt.getTime()) / 86_400_000;
            if (warmupCount >= WARM_MIN_ACTIONS && daysSinceStart >= WARM_MIN_DAYS) {
              warmupStatus = 'warm';
            }
          }

          await db.socialAccount.update({
            where: { id: socialAccountId },
            data: {
              warmupStatus,
              warmupStartedAt,
              lastWarmupAt: now,
              warmupCount,
              healthScore: Math.min(100, (account.healthScore ?? 90) + 2),
              lastError: null,
            },
          });

          logger.info(
            { socialAccountId, deviceId: account.deviceId, warmupCount, warmupStatus },
            'Warmup: physical board session success',
          );
          return;
        } catch (err: unknown) {
          const errorMsg = describeDeviceAgentError(err);
          await recordWarmupFailure(db, job, err, socialAccountId, `warmup-device: ${errorMsg}`, errorMsg);
          logger.error({ socialAccountId, deviceId: account.deviceId, err: errorMsg }, 'Warmup: physical board session failed');
          throw new Error(`warmup-device: ${errorMsg}`);
        } finally {
          await releaseDeviceLock(redis, account.deviceId, lockOwner);
        }
      }

      // ── Private publisher path (instagrapi) ───────────────────────────────
      if (account.authMethod !== 'private' || account.platform !== 'instagram') {
        logger.info({ socialAccountId, platform: account.platform, authMethod: account.authMethod }, 'Warmup: not applicable, skipping');
        return;
      }

      let sessionData: Record<string, unknown> = {};
      if (account.sessionData) {
        try {
          sessionData = JSON.parse(decrypt(account.sessionData));
        } catch (e) {
          throw new Error(`Warmup: cannot read stored session (${(e as Error).message})`);
        }
      }

      try {
        const result = await publisherService.instagramWarmup({
          proxyUrl: account.proxyUrl,
          deviceFingerprint: account.deviceFingerprint as Record<string, unknown> | null,
          sessionData,
          likeCount: 2 + Math.floor(Math.random() * 3), // 2–4 likes, human-ish
        });

        const now = new Date();
        const warmupStartedAt = account.warmupStartedAt ?? now;
        const warmupCount = account.warmupCount + 1;

        // Promotion rules
        let warmupStatus = account.warmupStatus;
        if (warmupStatus === 'cold') {
          warmupStatus = 'warming';
        } else if (warmupStatus === 'warming') {
          const daysSinceStart = (now.getTime() - warmupStartedAt.getTime()) / 86_400_000;
          if (warmupCount >= WARM_MIN_ACTIONS && daysSinceStart >= WARM_MIN_DAYS) {
            warmupStatus = 'warm';
          }
        }

        await db.socialAccount.update({
          where: { id: socialAccountId },
          data: {
            warmupStatus,
            warmupStartedAt,
            lastWarmupAt: now,
            warmupCount,
            ...(result.sessionData && Object.keys(result.sessionData).length > 0
              ? { sessionData: encrypt(JSON.stringify(result.sessionData)) }
              : {}),
          },
        });

        logger.info(
          { socialAccountId, actions: result.actions, warmupCount, warmupStatus },
          'Warmup: success',
        );
      } catch (err: unknown) {
        const errorMsg = describePublisherError(err);
        // Login challenges / blocks during warmup are an early health signal.
        await recordWarmupFailure(db, job, err, socialAccountId, `warmup: ${errorMsg}`, errorMsg);
        logger.error({ socialAccountId, err: errorMsg }, 'Warmup: failed');
        throw new Error(`warmup-instagram: ${errorMsg}`);
      }
    },
    {
      connection,
      concurrency: QUEUES['account-warmup'].concurrency,
    },
  );
}
