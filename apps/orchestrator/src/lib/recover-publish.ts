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

  // Resume recent ambiguous outcomes, including posts recorded before this worker was deployed.
  // A distinct retained job ID prevents a scheduler tick from restarting an exhausted check.
  let cursor: string | undefined;
  for (;;) {
    const posts = await db.publishJob.findMany({
      where: {
        status: 'failed', needsReview: true, platform: { in: ['tiktok', 'instagram'] },
        socialAccount: { authMethod: 'device', isActive: true, deviceId: { not: null } },
        updatedAt: { gte: new Date(now.getTime() - 3 * 86_400_000), lte: new Date(now.getTime() - 90_000) },
        ...(cursor && { id: { gt: cursor } }),
      },
      select: { id: true, tenantId: true, platform: true, socialAccountId: true },
      orderBy: { id: 'asc' }, take: 100,
    });
    if (posts.length === 0) break;
    const jobs = await Promise.all(posts.map(async (post) => ({ post, state: await queue.getJobState(`verify-${post.id}`) })));
    const missing = jobs.filter(({ state }) => state === 'unknown');
    if (missing.length) await queue.addBulk(missing.map(({ post }) => ({
      name: 'verify-device-publication',
      data: { verificationOnly: true, publishJobId: post.id, tenantId: post.tenantId, platform: post.platform, socialAccountId: post.socialAccountId },
      opts: { jobId: `verify-${post.id}`, priority: 10, attempts: 7, backoff: { type: 'exponential', delay: 120_000 },
        removeOnComplete: { age: 7 * 86_400 }, removeOnFail: { age: 7 * 86_400 } },
    })));
    if (posts.length < 100) break;
    cursor = posts[posts.length - 1].id;
  }
}
