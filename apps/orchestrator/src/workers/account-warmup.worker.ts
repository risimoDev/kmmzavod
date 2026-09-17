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
import { Worker, type ConnectionOptions } from 'bullmq';
import { QUEUES, type AccountWarmupPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger as rootLogger } from '../logger';
import { decrypt, encrypt } from '../lib/crypto';
import { publisherService, describePublisherError } from '../services/publisher';
import { deviceAgentService, describeDeviceAgentError } from '../services/device-agent';

const logger = rootLogger.child({ worker: 'account-warmup' });

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
    async (job) => {
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
          await db.socialAccount.update({
            where: { id: socialAccountId },
            data: {
              lastError: `warmup-device: ${errorMsg}`.slice(0, 1000),
              healthScore: { decrement: 5 },
            },
          });
          await db.socialAccount.updateMany({
            where: { id: socialAccountId, healthScore: { lt: 0 } },
            data: { healthScore: 0 },
          });
          logger.error({ socialAccountId, deviceId: account.deviceId, err: errorMsg }, 'Warmup: physical board session failed');
          throw new Error(`warmup-device: ${errorMsg}`);
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
        await db.socialAccount.update({
          where: { id: socialAccountId },
          data: {
            lastError: `warmup: ${errorMsg}`.slice(0, 1000),
            healthScore: { decrement: 5 },
          },
        });
        await db.socialAccount.updateMany({
          where: { id: socialAccountId, healthScore: { lt: 0 } },
          data: { healthScore: 0 },
        });
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
