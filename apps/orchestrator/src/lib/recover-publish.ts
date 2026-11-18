import type { PrismaClient } from '@kmmzavod/db';
import { addOrReplace, type PublishJobPayload } from '@kmmzavod/queue';
import type { Queue } from 'bullmq';
import { finalizePublishFailure } from '../workers/publish.worker';

export async function recoverPublishes(db: PrismaClient, queue: Queue<PublishJobPayload>, now: Date) {
  const due = await db.publishJob.findMany({
    where: {
      needsReview: false,
      status: { in: ['pending', 'scheduled'] },
      updatedAt: { lt: new Date(now.getTime() - 60_000) },
      OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
    },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  for (const post of due) {
    await addOrReplace(queue, `publish:${post.id}`, {
      publishJobId: post.id, tenantId: post.tenantId, platform: post.platform,
      socialAccountId: post.socialAccountId, videoId: post.videoId ?? undefined,
      uniqueVariantId: post.uniqueVariantId ?? undefined, scheduledAt: post.scheduledAt?.toISOString(),
    }, { jobId: post.id });
  }

  const interrupted = await db.publishJob.findMany({
    where: { status: 'uploading', updatedAt: { lt: new Date(now.getTime() - 45 * 60_000) } },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  for (const post of interrupted) {
    const queued = await queue.getJob(post.id);
    if (queued && await queued.getState() === 'active') continue;
    await finalizePublishFailure(db, post.id, 'Публикация прервана. Проверьте профиль вручную.', true);
  }
}
