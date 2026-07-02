/**
 * Account warmup worker — прогревает приватные аккаунты фермы.
 *
 * Instagram (authMethod=private): через publisher /instagram/warmup — логин по
 * сохранённой сессии, скролл ленты, 2–4 лайка. Обновлённая сессия сохраняется
 * (зашифрованной), чтобы следующий прогрев/пост не требовал повторного логина.
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

      const account = await db.socialAccount.findUnique({ where: { id: socialAccountId } });
      if (!account || account.tenantId !== tenantId) {
        logger.warn({ socialAccountId }, 'Warmup: account not found, skipping');
        return;
      }
      if (!account.isActive || account.authMethod !== 'private' || account.platform !== 'instagram') {
        logger.info({ socialAccountId, platform: account.platform }, 'Warmup: not applicable, skipping');
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
