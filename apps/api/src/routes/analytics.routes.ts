import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { agentPost, describeDeviceAgentError, hasFarmAccess } from '../lib/device-agent';

const pageSize = 25;
const querySchema = z.object({
  platform: z.enum(['tiktok', 'instagram', 'youtube_shorts', 'postbridge']).optional(),
  accountId: z.string().uuid().optional(),
  period: z.enum(['7', '30', '90', 'all']).default('all'),
  status: z.enum(['pending', 'scheduled', 'uploading', 'published', 'failed']).optional(),
  sort: z.enum(['recent', 'views']).default('recent'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const idSchema = z.string().uuid();
const nullableCount = z.number().int().min(0).max(2_147_483_647).nullable();
const percent = z.number().finite().min(0).max(100).nullable();
const engagementSchema = z.object({
  stayed: percent.default(null),
  averageViewed: z.number().finite().min(0).nullable().default(null),
  completed: percent.default(null),
  shares: nullableCount.default(null),
  saves: nullableCount.default(null),
});
const metricsSchema = z.object({ views: nullableCount, likes: nullableCount, comments: nullableCount, engagement: engagementSchema.optional() });
const profileSchema = z.object({
  posts: nullableCount.default(null),
  tiles: z.array(z.object({ index: z.number().int().nonnegative(), views: nullableCount, pinned: z.boolean() })).max(200),
});
const agentSnapshot = profileSchema.extend({
  ok: z.literal(true),
  username: z.string(),
  platform: z.enum(['instagram', 'tiktok']),
  followers: nullableCount,
});

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/accounts', async (req) => {
    const { tenantId } = req.user;
    const { accountId, platform, period, status, sort, page } = querySchema.parse(req.query);
    const accountScope = { tenantId, platform };
    const since = period === 'all' ? null : new Date(Date.now() - Number(period) * 86_400_000);
    const scope: Prisma.PublishJobWhereInput = {
      tenantId,
      socialAccount: accountScope,
      ...(since && { OR: [
        { status: 'published', publishedAt: { gte: since } },
        { status: 'published', publishedAt: null, createdAt: { gte: since } },
        { status: { not: 'published' }, createdAt: { gte: since } },
      ] }),
    };
    const postsScope = { ...scope, socialAccountId: accountId, status };
    const [accounts, aggregates, totalPosts] = await Promise.all([
      db.socialAccount.findMany({
        where: accountScope,
        orderBy: [{ isActive: 'desc' }, { accountName: 'asc' }, { id: 'asc' }],
        select: {
          id: true, accountName: true, platform: true, isActive: true, followers: true, statsAt: true,
          authMethod: true, deviceId: true, accountGroup: { select: { name: true } },
          postMetrics: {
            where: { tenantId, publishJobId: null, source: 'device' },
            orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }], take: 1,
            select: { raw: true, collectedAt: true },
          },
        },
      }),
      db.publishJob.groupBy({
        by: ['socialAccountId', 'status'], where: scope,
        _count: { _all: true, views: true, verifiedAt: true },
        _sum: { views: true, likes: true, comments: true },
      }),
      db.publishJob.count({ where: postsScope }),
    ]);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(totalPosts / pageSize)));
    const posts = await db.publishJob.findMany({
      where: postsScope,
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
      orderBy: [
        ...(sort === 'views' ? [{ views: { sort: 'desc', nulls: 'last' } } as const] : []),
        { createdAt: 'desc' }, { id: 'desc' },
      ],
      select: {
        id: true, socialAccountId: true, status: true, caption: true, createdAt: true, scheduledAt: true,
        publishedAt: true, verifiedAt: true, views: true, likes: true, comments: true, metricsAt: true,
        needsReview: true, video: { select: { title: true } },
        metrics: {
          where: { tenantId, source: 'manual' }, orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }], take: 1,
          select: { raw: true },
        },
      },
    });
    const byAccount = new Map<string, Map<string, (typeof aggregates)[number]>>();
    for (const row of aggregates) {
      const states = byAccount.get(row.socialAccountId) ?? new Map();
      states.set(row.status, row);
      byAccount.set(row.socialAccountId, states);
    }
    const canEdit = req.user.role !== 'viewer';
    const canCollect = canEdit && hasFarmAccess(req.user);
    return {
      canEdit,
      accounts: accounts.map(({ postMetrics, authMethod, deviceId, ...account }) => {
        const states = byAccount.get(account.id);
        const count = (key: string) => states?.get(key)?._count._all ?? 0;
        const published = states?.get('published');
        const snapshot = postMetrics[0];
        const profile = profileSchema.safeParse(snapshot?.raw);
        const visibleViews = profile.data?.tiles.flatMap((tile) => tile.views === null ? [] : [tile.views]) ?? [];
        return {
          ...account,
          published: count('published'), scheduled: count('scheduled'), failed: count('failed'),
          inProgress: count('pending') + count('uploading'),
          verified: published?._count.verifiedAt ?? 0,
          withViews: published?._count.views ?? 0,
          views: published?._sum.views ?? null,
          likes: published?._sum.likes ?? null,
          comments: published?._sum.comments ?? null,
          canCollect: canCollect && account.isActive && authMethod === 'device' && Boolean(deviceId) &&
            (account.platform === 'instagram' || account.platform === 'tiktok'),
          profile: profile.data ? {
            collectedAt: snapshot.collectedAt,
            posts: profile.data.posts,
            tiles: account.id === accountId ? profile.data.tiles : [],
            withViews: visibleViews.length,
            views: visibleViews.length ? visibleViews.reduce((sum, value) => sum + value, 0) : null,
          } : null,
        };
      }),
      posts: posts.map(({ video, caption, metrics, ...post }) => ({
        ...post,
        title: video?.title || caption?.trim().slice(0, 160) || 'Видео',
        engagement: engagementSchema.safeParse(metrics[0]?.raw).data ?? null,
      })),
      page: currentPage,
      pageSize,
      totalPosts,
    };
  });

  app.patch<{ Params: { id: string } }>('/posts/:id/metrics', async (req, reply) => {
    const { tenantId } = req.user;
    const id = idSchema.parse(req.params.id);
    const { engagement, ...values } = metricsSchema.parse(req.body);
    const saved = await db.$transaction(async (tx) => {
      const where = { id, tenantId, status: 'published' as const, socialAccount: { tenantId } };
      const collectedAt = new Date();
      const updated = await tx.publishJob.updateMany({ where, data: { ...values, metricsAt: collectedAt } });
      if (!updated.count) return false;
      const job = await tx.publishJob.findUniqueOrThrow({ where: { id }, select: { socialAccountId: true } });
      await tx.postMetric.create({
        data: { ...values, tenantId, socialAccountId: job.socialAccountId, publishJobId: id, source: 'manual', collectedAt,
          raw: engagement ?? {} },
      });
      return true;
    });
    if (!saved) return reply.code(404).send({ message: 'Опубликованное видео не найдено' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/accounts/:id/collect', async (req, reply) => {
    if (!hasFarmAccess(req.user)) return reply.code(403).send({ message: 'Нет доступа к телефонной ферме' });
    const { tenantId } = req.user;
    const id = idSchema.parse(req.params.id);
    const account = await db.socialAccount.findFirst({
      where: { id, tenantId },
      select: { accountName: true, platform: true, authMethod: true, deviceId: true, isActive: true },
    });
    if (!account) return reply.code(404).send({ message: 'Аккаунт не найден' });
    const { platform, deviceId, accountName } = account;
    const username = accountName.trim().replace(/^@+/, '');
    if (!account.isActive || account.authMethod !== 'device' || !deviceId ||
        (platform !== 'instagram' && platform !== 'tiktok') || !/^[a-z\d._]{1,100}$/i.test(username)) {
      return reply.code(400).send({ message: 'Нужен активный аккаунт Instagram или TikTok с привязанным телефоном и корректным именем профиля' });
    }
    const foreign = await db.socialAccount.findFirst({ where: { deviceId, tenantId: { not: tenantId } }, select: { id: true } });
    if (foreign) return reply.code(409).send({ message: 'Телефон привязан к другой организации' });

    let response: unknown;
    try {
      response = await agentPost<unknown>('/stats/profile', { deviceId, platform, username }, { timeout: 240_000 });
    } catch (err) {
      return reply.code(502).send({ message: describeDeviceAgentError(err) });
    }
    const snapshot = agentSnapshot.safeParse(response);
    if (!snapshot.success || snapshot.data.platform !== platform || snapshot.data.username.toLowerCase() !== username.toLowerCase()) {
      return reply.code(502).send({ message: 'Телефон не вернул подтверждённые данные этого профиля' });
    }
    const { followers, posts, tiles } = snapshot.data;
    const collectedAt = new Date();
    const saved = await db.$transaction(async (tx) => {
      const updated = await tx.socialAccount.updateMany({
        where: { id, tenantId, deviceId, platform, accountName, authMethod: 'device', isActive: true,
          OR: [{ statsAt: null }, { statsAt: { lte: collectedAt } }] },
        data: { followers: followers ?? undefined, statsAt: collectedAt },
      });
      if (!updated.count) return false;
      await tx.postMetric.create({ data: { tenantId, socialAccountId: id, source: 'device', raw: { posts, tiles }, collectedAt } });
      return true;
    });
    if (!saved) return reply.code(409).send({ message: 'Данные аккаунта изменились во время сбора' });
    return reply.code(204).send();
  });
}
