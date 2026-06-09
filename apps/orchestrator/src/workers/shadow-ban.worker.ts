/**
 * Shadow-ban checker worker.
 *
 * Runs ~30-60 min after a publish to verify the post is visible.
 * Currently a placeholder: real implementation requires platform-specific
 * search APIs or scraping. When a shadow-ban is detected the account
 * health score is dropped and the account is paused.
 */
import { Worker, Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { QUEUES } from '@kmmzavod/queue';
import type { ShadowBanCheckPayload } from '@kmmzavod/queue';
import { logger } from '../logger';

interface Deps {
  db: PrismaClient;
  connection: ConnectionOptions;
}

export function createShadowBanWorker(deps: Deps): Worker {
  const { db, connection } = deps;

  return new Worker<ShadowBanCheckPayload>(
    QUEUES['shadow-ban-check'].name,
    async (job) => {
      const { publishJobId, socialAccountId, tenantId, platform, externalPostId, hashtags } = job.data;
      logger.info({ publishJobId, socialAccountId, platform, externalPostId }, 'Shadow-ban check start');

      // ── Placeholder: replace with real platform search / API call ─────────────
      // TikTok: search via TikTok Research API or scrape hashtag feed
      // Instagram: Graph API search by hashtag + filter by account
      // YouTube: Data API search for video ID
      // PostBridge: internal lookup
      //
      // If post is NOT found → shadowBanDetected = true, healthScore -= 50
      // ─────────────────────────────────────────────────────────────────────────

      let shadowBanned = false;

      // TODO: implement actual visibility check per platform
      // Example pseudo-code:
      // if (platform === 'tiktok') {
      //   const found = await tiktokClient.searchHashtag(hashtags[0], { authorId: account.accountName });
      //   shadowBanned = !found.some(p => p.id === externalPostId);
      // }

      await db.socialAccount.update({
        where: { id: socialAccountId },
        data: {
          shadowBanDetected: shadowBanned,
          shadowBanCheckedAt: new Date(),
          ...(shadowBanned
            ? {
                healthScore: { decrement: 50 },
                isActive: false,
                lastError: 'Shadow-ban detected — account paused',
              }
            : {}),
        },
      });

      // Clamp healthScore
      await db.socialAccount.updateMany({
        where: { id: socialAccountId, healthScore: { lt: 0 } },
        data: { healthScore: 0 },
      });

      logger.info(
        { publishJobId, socialAccountId, shadowBanned },
        shadowBanned ? 'Shadow-ban detected' : 'Shadow-ban check passed',
      );
    },
    {
      connection,
      concurrency: QUEUES['shadow-ban-check'].concurrency,
    },
  );
}
