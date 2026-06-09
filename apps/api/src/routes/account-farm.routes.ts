/**
 * Account Farm routes — mass social account management with auto-assignment.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '../lib/db';
import { encrypt, decrypt } from '../lib/crypto';
import { logger } from '../logger';

// ── Validation schemas ──────────────────────────────────────────────────────

const CreateAccountGroupBody = z.object({
  name: z.string().min(1).max(200),
  niche: z.string().min(1).max(200),
  timezone: z.string().max(50).default('UTC'),
  maxPostsPerDay: z.number().int().min(1).max(100).default(3),
  staggerMinutes: z.number().int().min(1).max(1440).default(120),
  bgmPool: z.array(z.string().url()).default([]),
});

const UpdateAccountGroupBody = z.object({
  name: z.string().min(1).max(200).optional(),
  niche: z.string().min(1).max(200).optional(),
  timezone: z.string().max(50).optional(),
  maxPostsPerDay: z.number().int().min(1).max(100).optional(),
  staggerMinutes: z.number().int().min(1).max(1440).optional(),
  bgmPool: z.array(z.string().url()).optional(),
  isActive: z.boolean().optional(),
});

const BulkProxyBody = z.object({
  proxies: z.array(z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    type: z.enum(['http', 'https', 'socks5', 'residential', 'mobile']),
    country: z.string().optional(),
    city: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    maxAccounts: z.number().int().min(1).max(100).default(3),
  })).min(1).max(1000),
});

const BulkSocialAccountBody = z.object({
  accounts: z.array(z.object({
    platform: z.enum(['tiktok', 'instagram', 'youtube_shorts', 'postbridge']),
    accountName: z.string().min(1).max(200),
    accessToken: z.string().min(1),
    refreshToken: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
    igUserId: z.string().optional(),
    accountGroupId: z.string().uuid().optional(),
    niche: z.string().optional(),
    language: z.string().max(10).default('en'),
  })).min(1).max(500),
  autoAssign: z.boolean().default(true),
});

// ── Device fingerprint generator ─────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
];

/**
 * Build a proxy connection URL from a Proxy record for use by the publish worker.
 * Password is stored encrypted, so decrypt it here.
 */
function buildProxyUrl(proxy: {
  type: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}): string {
  const scheme = proxy.type === 'socks5' ? 'socks5' : 'http';
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ? decrypt(proxy.password) : '')}@`
    : '';
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

function generateFingerprint() {
  return {
    deviceId: randomUUID(),
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    screenResolution: ['1080x1920', '1170x2532', '1080x2400'][Math.floor(Math.random() * 3)],
    osVersion: ['Android 14', 'Android 13', 'iOS 17.1', 'iOS 16.6'][Math.floor(Math.random() * 4)],
    appVersion: ['30.5.0', '31.1.2', '29.8.1'][Math.floor(Math.random() * 3)],
    language: 'en-US',
    carrier: ['Verizon', 'T-Mobile', 'AT&T', 'O2', 'Vodafone'][Math.floor(Math.random() * 5)],
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function accountFarmRoutes(app: FastifyInstance) {
  // All farm routes require JWT authentication (consistent with the rest of the API)
  app.addHook('preHandler', app.authenticate);

  // ── Account Groups ─────────────────────────────────────────────────────────

  app.post('/account-groups', async (request, reply) => {
    const { tenantId } = request.user;
    const body = CreateAccountGroupBody.parse(request.body);
    const group = await db.accountGroup.create({
      data: { ...body, tenantId },
    });
    logger.info({ groupId: group.id, tenantId }, 'AccountGroup created');
    return reply.status(201).send(group);
  });

  app.get('/account-groups', async (request, reply) => {
    const { tenantId } = request.user;
    const { isActive } = z.object({ isActive: z.enum(['true', 'false']).optional() }).parse(request.query);
    const groups = await db.accountGroup.findMany({
      where: {
        tenantId,
        ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
      },
      include: { _count: { select: { accounts: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(groups);
  });

  app.put('/account-groups/:id', async (request, reply) => {
    const { tenantId } = request.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = UpdateAccountGroupBody.parse(request.body);
    const group = await db.accountGroup.updateMany({
      where: { id, tenantId },
      data: body,
    });
    if (group.count === 0) return reply.status(404).send({ error: 'Group not found' });
    return reply.send({ updated: group.count });
  });

  app.delete('/account-groups/:id', async (request, reply) => {
    const { tenantId } = request.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await db.accountGroup.deleteMany({ where: { id, tenantId } });
    return reply.status(204).send();
  });

  // ── Proxies ────────────────────────────────────────────────────────────────

  app.post('/proxies/bulk', async (request, reply) => {
    const { tenantId } = request.user;
    const { proxies } = BulkProxyBody.parse(request.body);
    const created = await db.proxy.createMany({
      data: proxies.map((p) => ({
        ...p,
        tenantId,
        password: p.password ? encrypt(p.password) : undefined,
      })),
      skipDuplicates: false,
    });
    logger.info({ count: created.count, tenantId }, 'Proxies bulk imported');
    return reply.status(201).send({ imported: created.count });
  });

  app.get('/proxies', async (request, reply) => {
    const { tenantId } = request.user;
    const { isActive, country } = z.object({
      isActive: z.enum(['true', 'false']).optional(),
      country: z.string().optional(),
    }).parse(request.query);

    const proxies = await db.proxy.findMany({
      where: {
        tenantId,
        ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
        ...(country ? { country: { equals: country, mode: 'insensitive' } } : {}),
      },
      include: { _count: { select: { accounts: true } } },
      orderBy: [{ isActive: 'desc' }, { assignedAccounts: 'asc' }],
    });
    // Never expose proxy passwords
    return reply.send(proxies.map((p: any) => { const { password: _pw, ...rest } = p; return rest; }));
  });

  app.post('/proxies/:id/health-check', async (request, reply) => {
    const { tenantId } = request.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const proxy = await db.proxy.findFirst({ where: { id, tenantId } });
    if (!proxy) return reply.status(404).send({ error: 'Proxy not found' });

    // Simple TCP connectivity check
    const net = await import('net');
    const ok = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(5000);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.connect(proxy.port, proxy.host);
    });

    await db.proxy.update({
      where: { id },
      data: {
        healthCheckAt: new Date(),
        ...(ok ? { failCount: 0 } : { failCount: { increment: 1 }, lastError: 'Connection timeout' }),
        ...(ok ? {} : { isActive: proxy.failCount >= 2 ? false : undefined }),
      },
    });

    return reply.send({ id, ok });
  });

  // ── Social Accounts Bulk Import with Auto-Assignment ───────────────────────

  app.post('/social-accounts/bulk', async (request, reply) => {
    const { tenantId } = request.user;
    const { accounts, autoAssign } = BulkSocialAccountBody.parse(request.body);

    const results: Array<{ accountName: string; status: 'created' | 'failed'; error?: string }> = [];

    for (const acc of accounts) {
      try {
        let accountGroupId = acc.accountGroupId ?? null;
        let groupRecord: any = null;
        let proxyId: string | null = null;
        let deviceFingerprint: any = null;
        let timezone = 'UTC';

        // Build proxyUrl string used by the publish worker (decrypt password for URL)
        let proxyUrl: string | null = null;

        if (autoAssign && accountGroupId) {
          groupRecord = await db.accountGroup.findFirst({
            where: { id: accountGroupId, tenantId },
          });
          if (groupRecord) {
            timezone = groupRecord.timezone;
            // Pick least-loaded active proxy within this tenant
            const proxy = await db.proxy.findFirst({
              where: { tenantId, isActive: true, assignedAccounts: { lt: db.proxy.fields.maxAccounts } },
              orderBy: { assignedAccounts: 'asc' },
            });
            if (proxy) {
              proxyId = proxy.id;
              proxyUrl = buildProxyUrl(proxy);
            }
            deviceFingerprint = generateFingerprint();
          }
        }

        await db.socialAccount.create({
          data: {
            tenantId,
            platform: acc.platform,
            accountName: acc.accountName,
            accessToken: encrypt(acc.accessToken),
            refreshToken: acc.refreshToken ? encrypt(acc.refreshToken) : undefined,
            expiresAt: acc.expiresAt ? new Date(acc.expiresAt) : undefined,
            igUserId: acc.igUserId,
            accountGroupId,
            proxyId,
            proxyUrl: proxyUrl ?? undefined,
            deviceFingerprint: deviceFingerprint ?? undefined,
            niche: acc.niche ?? groupRecord?.niche,
            language: acc.language,
            actionLimits: { maxPostsPerDay: groupRecord?.maxPostsPerDay ?? 3 },
          },
        });

        // Increment proxy counter
        if (proxyId) {
          await db.proxy.update({
            where: { id: proxyId },
            data: { assignedAccounts: { increment: 1 } },
          });
        }

        results.push({ accountName: acc.accountName, status: 'created' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, accountName: acc.accountName }, 'Bulk import failed for account');
        results.push({ accountName: acc.accountName, status: 'failed', error: msg });
      }
    }

    return reply.status(201).send({ imported: results.filter((r) => r.status === 'created').length, results });
  });

  // ── Reset Daily Post Counts (call via cron every midnight per timezone) ────

  app.post('/social-accounts/reset-daily', async (request, reply) => {
    const { tenantId } = request.user;
    const { timezone } = z.object({ timezone: z.string().optional() }).parse(request.query);

    const where: any = { tenantId };
    if (timezone) {
      // Only reset accounts whose group timezone matches (or null timezone fallback)
      where.OR = [
        { accountGroup: { timezone } },
        { accountGroupId: null },
      ];
    }

    const updated = await db.socialAccount.updateMany({
      where,
      data: { dailyPostCount: 0 },
    });

    logger.info({ tenantId, timezone, updated: updated.count }, 'Daily post counts reset');
    return reply.send({ reset: updated.count });
  });

  // ── List Social Accounts with Farm Fields ──────────────────────────────────

  app.get('/social-accounts', async (request, reply) => {
    const { tenantId } = request.user;
    const { platform, accountGroupId, isActive, page, limit } = z.object({
      platform: z.enum(['tiktok', 'instagram', 'youtube_shorts', 'postbridge']).optional(),
      accountGroupId: z.string().uuid().optional(),
      isActive: z.enum(['true', 'false']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);

    const where = {
      tenantId,
      ...(platform ? { platform } : {}),
      ...(accountGroupId ? { accountGroupId } : {}),
      ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
    };

    const [accounts, total] = await Promise.all([
      db.socialAccount.findMany({
        where,
        include: { accountGroup: { select: { name: true } }, proxy: { select: { host: true, port: true, type: true } } },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      db.socialAccount.count({ where }),
    ]);

    return reply.send({ accounts, total, page, limit });
  });

  // ── Farm Metrics Dashboard ─────────────────────────────────────────────────

  app.get('/metrics', async (request, reply) => {
    const { tenantId } = request.user;

    const [
      totalAccounts,
      activeAccounts,
      shadowBannedAccounts,
      lowHealthAccounts,
      totalProxies,
      activeProxies,
      failedProxies,
    ] = await Promise.all([
      db.socialAccount.count({ where: { tenantId } }),
      db.socialAccount.count({ where: { tenantId, isActive: true } }),
      db.socialAccount.count({ where: { tenantId, shadowBanDetected: true } }),
      db.socialAccount.count({ where: { tenantId, healthScore: { lt: 30 } } }),
      db.proxy.count({ where: { tenantId } }),
      db.proxy.count({ where: { tenantId, isActive: true } }),
      db.proxy.count({ where: { tenantId, isActive: false } }),
    ]);

    // Health score buckets
    const healthBuckets = await db.socialAccount.groupBy({
      by: ['platform'],
      where: { tenantId },
      _avg: { healthScore: true },
      _count: { id: true },
    });

    // Daily post count today (approximate — resets via cron)
    const postsToday = await db.socialAccount.aggregate({
      where: { tenantId },
      _sum: { dailyPostCount: true },
    });

    return reply.send({
      accounts: {
        total: totalAccounts,
        active: activeAccounts,
        shadowBanned: shadowBannedAccounts,
        lowHealth: lowHealthAccounts,
        postsToday: postsToday._sum.dailyPostCount ?? 0,
        healthByPlatform: healthBuckets.map((b: any) => ({
          platform: b.platform,
          avgHealth: b._avg.healthScore ?? 0,
          count: b._count.id,
        })),
      },
      proxies: {
        total: totalProxies,
        active: activeProxies,
        failed: failedProxies,
      },
    });
  });
}
