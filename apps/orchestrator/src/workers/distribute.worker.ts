/**
 * Distribute worker — раздаёт уникализированные варианты по множеству аккаунтов.
 *
 * Алгоритм:
 * 1. Загружает DistributeJob + items
 * 2. Для каждого DistributeItem создаёт PublishJob с задержкой (stagger)
 * 3. Отслеживает прогресс через колбэки publish-worker'а
 */
import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import { QUEUES, type DistributeJobPayload, type PublishJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger as rootLogger } from '../logger';

const logger = rootLogger.child({ worker: 'distribute' });

interface Deps {
  db: PrismaClient;
  publishQueue: Queue<PublishJobPayload>;
  connection: ConnectionOptions;
}

export function createDistributeWorker(deps: Deps): Worker {
  const { db, publishQueue, connection } = deps;

  return new Worker<DistributeJobPayload>(
    QUEUES['uniquify-distribute'].name,
    async (job) => {
      const { distributeJobId, tenantId } = job.data;
      logger.info({ distributeJobId, tenantId }, 'Distribute: start');

      // Load distribute job with items
      const distJob = await db.distributeJob.findUniqueOrThrow({
        where: { id: distributeJobId },
        include: {
          items: {
            where: { status: 'pending' },
            include: {
              uniqueVariant: { select: { id: true, status: true, outputKey: true } },
              socialAccount: { select: { id: true, platform: true, isActive: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (distJob.status === 'cancelled') {
        logger.info({ distributeJobId }, 'Distribute: job cancelled, skipping');
        return;
      }

      // Mark as distributing
      await db.distributeJob.update({
        where: { id: distributeJobId },
        data: { status: 'distributing' },
      });

      const staggerMs = distJob.staggerMinutes * 60 * 1000;
      let itemIndex = 0;
      let skippedCount = 0;

      for (const item of distJob.items) {
        // Skip if variant not ready or account disabled
        if (item.uniqueVariant.status !== 'completed' || !item.uniqueVariant.outputKey) {
          await db.distributeItem.update({
            where: { id: item.id },
            data: { status: 'skipped', error: 'Variant not completed or has no output' },
          });
          skippedCount++;
          continue;
        }
        if (!item.socialAccount.isActive) {
          await db.distributeItem.update({
            where: { id: item.id },
            data: { status: 'skipped', error: 'Social account is disabled' },
          });
          skippedCount++;
          continue;
        }

        // Calculate scheduled time with stagger
        const scheduledAt = new Date(Date.now() + itemIndex * staggerMs);
        const delay = itemIndex * staggerMs;

        // Build caption from template
        const caption = buildCaption(
          distJob.captionTemplate,
          item.caption,
          item.hashtags.length > 0 ? item.hashtags : distJob.hashtags,
          itemIndex,
          item.socialAccount.platform,
        );

        const hashtags = item.hashtags.length > 0 ? item.hashtags : distJob.hashtags;

        // Create PublishJob
        const publishJob = await db.publishJob.create({
          data: {
            tenantId,
            socialAccountId: item.socialAccount.id,
            uniqueVariantId: item.uniqueVariant.id,
            platform: item.socialAccount.platform as any,
            caption,
            hashtags,
            scheduledAt,
            status: 'scheduled',
          },
        });

        // Update DistributeItem with publish job reference
        await db.distributeItem.update({
          where: { id: item.id },
          data: {
            status: 'scheduled',
            publishJobId: publishJob.id,
            scheduledAt,
          },
        });

        // Enqueue publish job with delay
        const payload: PublishJobPayload = {
          publishJobId: publishJob.id,
          uniqueVariantId: item.uniqueVariant.id,
          tenantId,
          platform: item.socialAccount.platform as any,
          socialAccountId: item.socialAccount.id,
          scheduledAt: scheduledAt.toISOString(),
        };

        await publishQueue.add(
          `publish-distribute:${publishJob.id}`,
          payload,
          { delay, jobId: publishJob.id },
        );

        logger.info(
          {
            distributeJobId,
            itemId: item.id,
            publishJobId: publishJob.id,
            variantId: item.uniqueVariant.id,
            accountId: item.socialAccount.id,
            platform: item.socialAccount.platform,
            delay: `${Math.round(delay / 60000)}min`,
          },
          'Distribute: scheduled publish',
        );

        itemIndex++;
      }

      // Update stats
      const scheduledCount = itemIndex;
      await db.distributeJob.update({
        where: { id: distributeJobId },
        data: {
          totalItems: distJob.items.length,
          ...(scheduledCount === 0 && skippedCount === distJob.items.length
            ? { status: 'completed', completedAt: new Date() }
            : {}),
        },
      });

      logger.info(
        { distributeJobId, scheduled: scheduledCount, skipped: skippedCount, total: distJob.items.length },
        'Distribute: items dispatched',
      );
    },
    {
      connection,
      concurrency: QUEUES['uniquify-distribute'].concurrency,
    },
  );
}

/**
 * Build caption from template or per-item override.
 * Template supports: {{index}}, {{platform}}
 */
function buildCaption(
  template: string | null,
  itemCaption: string | null,
  hashtags: string[],
  index: number,
  platform: string,
): string {
  // Per-item caption takes priority
  if (itemCaption) {
    const tags = hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ');
    return tags ? `${itemCaption}\n\n${tags}` : itemCaption;
  }

  if (!template) {
    const tags = hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ');
    return tags || '';
  }

  let result = template
    .replace(/\{\{index\}\}/g, String(index + 1))
    .replace(/\{\{platform\}\}/g, platform);

  const tags = hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' ');
  if (tags) result += `\n\n${tags}`;

  return result;
}
