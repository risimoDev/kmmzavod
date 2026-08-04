/**
 * Account Farm routes — mass social account management with auto-assignment.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '../lib/db';
import { encrypt, decrypt } from '../lib/crypto';
import { computeReadiness } from '../lib/publish-readiness';
import { getRedis } from '../lib/redis';
import { logger } from '../logger';

// ── Validation schemas ──────────────────────────────────────────────────────

const CreateAccountGroupBody = z.object({
  name: z.string().min(1).max(200),
  niche: z.string().min(1).max(200),
  timezone: z.string().max(50).default('UTC'),
  maxPostsPerDay: z.number().int().min(1).max(100).default(3),
  staggerMinutes: z.number().int().min(1).max(1440).default(120),
  bgmPool: z.array(z.string().url()).default([]),
  enforceWarmup: z.boolean().default(false),
});

const UpdateAccountGroupBody = z.object({
  name: z.string().min(1).max(200).optional(),
  niche: z.string().min(1).max(200).optional(),
  timezone: z.string().max(50).optional(),
  maxPostsPerDay: z.number().int().min(1).max(100).optional(),
  staggerMinutes: z.number().int().min(1).max(1440).optional(),
  bgmPool: z.array(z.string().url()).optional(),
  enforceWarmup: z.boolean().optional(),
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
    // Publishing method: 'official' (OAuth) or 'private' (unofficial publisher).
    authMethod: z.enum(['official', 'private', 'device']).default('official'),
    // Official-path credentials.
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
    igUserId: z.string().optional(),
    // Private-path credentials. Instagram: username+password (+ optional cookie,
    // techData). TikTok: sessionId/cookie for posting, and/or username+password
    // (+ twoFactorSeed / email+emailPassword) for the account record & future login.
    username: z.string().optional(),
    password: z.string().optional(),
    sessionId: z.string().optional(),
    cookie: z.string().optional(),
    techData: z.string().optional(),
    twoFactorSeed: z.string().optional(),
    email: z.string().optional(),
    emailPassword: z.string().optional(),
    // Device-path: id of the phone as known to Laixi (see GET /devices on device-agent).
    deviceId: z.string().optional(),
    accountGroupId: z.string().uuid().optional(),
    niche: z.string().optional(),
    language: z.string().max(10).default('en'),
  })).min(1).max(500),
  autoAssign: z.boolean().default(true),
});

const SetCredentialsBody = z.object({
  authMethod: z.enum(['official', 'private', 'device']).default('private'),
  username: z.string().optional(),
  password: z.string().optional(),
  sessionId: z.string().optional(),
  cookie: z.string().optional(),
  techData: z.string().optional(),
  twoFactorSeed: z.string().optional(),
  email: z.string().optional(),
  emailPassword: z.string().optional(),
  accessToken: z.string().optional(),
  deviceId: z.string().optional(),
});

type PrivateCreds = {
  username?: string; password?: string; sessionId?: string; cookie?: string;
  techData?: string; twoFactorSeed?: string; email?: string; emailPassword?: string;
};

/** Pull the sessionid value out of a raw Cookie header string, if present. */
function sessionidFromCookie(cookie?: string): string | undefined {
  if (!cookie) return undefined;
  const m = cookie.match(/sessionid=([^;|\s]+)/i);
  return m ? decodeURIComponent(m[1]) : undefined;
}

type CookieObj = { name: string; value: string; domain?: string; path?: string };

/**
 * Parse a TikTok cookie payload (browser-extension JSON array OR a `Cookie:`
 * header string) into a normalized cookie list + the sessionid.
 *
 * TikTok often exports without an explicit `sessionid` cookie but WITH `sid_guard`
 * (whose value embeds the sessionid: `<sessionid>|<ts>|...`, URL-encoded). We
 * derive the sessionid from it and inject a `sessionid` cookie so tiktok-uploader
 * — which authenticates by that cookie — has what it needs.
 */
function parseTikTokCookies(raw?: string): { cookies?: CookieObj[]; sessionid?: string } {
  if (!raw) return {};
  const trimmed = raw.trim();

  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try { arr = JSON.parse(trimmed); } catch { return {}; }
    if (!Array.isArray(arr)) return {};
    const cookies: CookieObj[] = arr
      .filter((c): c is CookieObj =>
        !!c && typeof (c as any).name === 'string' && typeof (c as any).value === 'string')
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? '.tiktok.com', path: c.path ?? '/' }));

    let sessionid = cookies.find((c) => c.name === 'sessionid')?.value;
    if (!sessionid) {
      const guard = cookies.find((c) => c.name === 'sid_guard')?.value;
      if (guard) sessionid = decodeURIComponent(guard).split('|')[0] || undefined;
    }
    if (sessionid && !cookies.some((c) => c.name === 'sessionid')) {
      cookies.push({ name: 'sessionid', value: sessionid, domain: '.tiktok.com', path: '/' });
    }
    return { cookies: cookies.length ? cookies : undefined, sessionid };
  }

  // Header-style string: `sessionid=...; csrftoken=...`
  return { sessionid: sessionidFromCookie(trimmed) };
}

/**
 * Build the private-publisher session blob from import/credential input.
 * Stored encrypted; the publisher microservice reads it to log in.
 * Returns { session, note } — note surfaces a non-fatal caveat (e.g. a TikTok
 * account stored without a posting session).
 */
function buildPrivateSession(platform: string, acc: PrivateCreds): { session: Record<string, unknown>; note?: string } {
  if (platform === 'instagram') {
    if (!acc.username || !acc.password) {
      throw new Error('Instagram private account needs username and password');
    }
    const session: Record<string, unknown> = { username: acc.username, password: acc.password };
    const sid = acc.sessionId || sessionidFromCookie(acc.cookie);
    if (sid) session.sessionid = sid;
    if (acc.cookie) session.cookie = acc.cookie;
    if (acc.techData) session.tech_data = acc.techData;
    return { session };
  }
  if (platform === 'tiktok') {
    const parsed = parseTikTokCookies(acc.cookie);
    const sid = acc.sessionId || parsed.sessionid;
    const session: Record<string, unknown> = {};
    if (sid) session.sessionid = sid;
    // Full cookie list authenticates the headless browser (preferred over sessionid alone).
    if (parsed.cookies?.length) session.cookies = parsed.cookies;
    else if (acc.cookie) session.cookie = acc.cookie;
    // Store login material for the account record + future automated login.
    if (acc.username) session.username = acc.username;
    if (acc.password) session.password = acc.password;
    if (acc.twoFactorSeed) session.two_factor_seed = acc.twoFactorSeed;
    if (acc.email) session.email = acc.email;
    if (acc.emailPassword) session.email_password = acc.emailPassword;
    if (Object.keys(session).length === 0) {
      throw new Error('TikTok private account needs a sessionId/cookie or username+password');
    }
    // Posting via tiktok-uploader needs a sessionid or a cookie list.
    const postReady = Boolean(sid || parsed.cookies?.length);
    const note = postReady ? undefined
      : 'stored without posting session — add a TikTok sessionid/cookie before publishing';
    return { session, note };
  }
  throw new Error(`Private publishing is not supported for platform "${platform}"`);
}

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

/**
 * Pick a proxy for a new account of `platform`, enforcing "one account per
 * platform per proxy" (so a single proxy hosts at most 1 TikTok + 1 Instagram +
 * 1 YouTube …). Prefers proxies that ALREADY host accounts of other platforms so
 * the fleet pairs up (1 TikTok + 1 IG on the same IP) instead of scattering.
 * Returns the proxy row or null when none is free for this platform.
 */
async function pickProxyForPlatform(
  tx: typeof db,
  tenantId: string,
  platform: string,
): Promise<{ id: string; type: string; host: string; port: number; username: string | null; password: string | null } | null> {
  const proxy = await tx.proxy.findFirst({
    where: {
      tenantId,
      isActive: true,
      assignedAccounts: { lt: tx.proxy.fields.maxAccounts },
      accounts: { none: { platform: platform as any } }, // no same-platform account yet
    },
    // Most-loaded-but-still-free first → completes 1-of-each-platform pairings.
    orderBy: [{ assignedAccounts: 'desc' }],
    select: { id: true, type: true, host: true, port: true, username: true, password: true },
  });
  return proxy;
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

  // ── Auto-assign proxies to accounts that don't have one ─────────────────────
  // Enforces "1 account per platform per proxy". Idempotent — accounts that
  // already have a proxy are left untouched.
  app.post('/proxies/auto-assign', async (request, reply) => {
    const { tenantId } = request.user;

    const unassigned = await db.socialAccount.findMany({
      where: { tenantId, isActive: true, proxyId: null },
      select: { id: true, platform: true },
      orderBy: { createdAt: 'asc' },
    });

    let assigned = 0;
    const noProxyFor: string[] = [];
    for (const acc of unassigned) {
      const proxy = await pickProxyForPlatform(db, tenantId, acc.platform);
      if (!proxy) { noProxyFor.push(acc.platform); continue; }
      await db.$transaction([
        db.socialAccount.update({
          where: { id: acc.id },
          data: { proxyId: proxy.id, proxyUrl: buildProxyUrl(proxy) },
        }),
        db.proxy.update({
          where: { id: proxy.id },
          data: { assignedAccounts: { increment: 1 } },
        }),
      ]);
      assigned++;
    }

    logger.info({ tenantId, assigned, unassigned: unassigned.length }, 'Proxies auto-assigned');
    return reply.send({
      assigned,
      remaining: unassigned.length - assigned,
      note: noProxyFor.length
        ? `Не хватило свободных прокси для платформ: ${[...new Set(noProxyFor)].join(', ')} (нужен ещё 1 прокси на каждый такой аккаунт)`
        : undefined,
    });
  });

  // ── Social Accounts Bulk Import with Auto-Assignment ───────────────────────

  app.post('/social-accounts/bulk', async (request, reply) => {
    const { tenantId } = request.user;
    const { accounts, autoAssign } = BulkSocialAccountBody.parse(request.body);

    const results: Array<{ accountName: string; status: 'created' | 'failed'; error?: string; note?: string }> = [];

    for (const acc of accounts) {
      try {
        let accountGroupId = acc.accountGroupId ?? null;
        let groupRecord: any = null;
        let proxyId: string | null = null;
        let deviceFingerprint: any = null;
        let timezone = 'UTC';

        // Build proxyUrl string used by the publish worker (decrypt password for URL)
        let proxyUrl: string | null = null;

        if (accountGroupId) {
          groupRecord = await db.accountGroup.findFirst({
            where: { id: accountGroupId, tenantId },
          });
          if (groupRecord) timezone = groupRecord.timezone;
        }
        // Auto-assign a proxy per the "1 account per platform per proxy" rule
        // (independent of group — every private account should get its own IP).
        if (autoAssign) {
          const proxy = await pickProxyForPlatform(db, tenantId, acc.platform);
          if (proxy) {
            proxyId = proxy.id;
            proxyUrl = buildProxyUrl(proxy);
          }
          deviceFingerprint = generateFingerprint();
        }

        // Resolve credentials per publishing method.
        let accessTokenEnc: string;
        let sessionDataEnc: string | undefined;
        let importNote: string | undefined;
        if (acc.authMethod === 'private') {
          const { session, note } = buildPrivateSession(acc.platform, acc); // throws → recorded as failed below
          sessionDataEnc = encrypt(JSON.stringify(session));
          accessTokenEnc = encrypt('private'); // placeholder (column is NOT NULL)
          importNote = note;
        } else if (acc.authMethod === 'device') {
          if (!acc.deviceId) throw new Error('Device account needs deviceId (Laixi device id)');
          accessTokenEnc = encrypt('device'); // placeholder (column is NOT NULL) — the phone's logged-in app IS the session
        } else {
          if (!acc.accessToken) throw new Error('Official account needs accessToken');
          accessTokenEnc = encrypt(acc.accessToken);
        }

        await db.socialAccount.create({
          data: {
            tenantId,
            platform: acc.platform,
            accountName: acc.accountName,
            authMethod: acc.authMethod,
            deviceId: acc.deviceId,
            accessToken: accessTokenEnc,
            sessionData: sessionDataEnc,
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

        results.push({ accountName: acc.accountName, status: 'created', ...(importNote ? { note: importNote } : {}) });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, accountName: acc.accountName }, 'Bulk import failed for account');
        results.push({ accountName: acc.accountName, status: 'failed', error: msg });
      }
    }

    return reply.status(201).send({ imported: results.filter((r) => r.status === 'created').length, results });
  });

  // ── Set / update an account's publishing method + credentials ─────────────

  app.put('/social-accounts/:id/credentials', async (request, reply) => {
    const { tenantId } = request.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = SetCredentialsBody.parse(request.body);

    const account = await db.socialAccount.findFirst({
      where: { id, tenantId },
      select: { id: true, platform: true },
    });
    if (!account) return reply.status(404).send({ error: 'Account not found' });

    const data: Record<string, unknown> = { authMethod: body.authMethod };
    let credNote: string | undefined;
    if (body.authMethod === 'private') {
      try {
        const { session, note } = buildPrivateSession(account.platform, body);
        data.sessionData = encrypt(JSON.stringify(session));
        data.accessToken = encrypt('private');
        credNote = note;
      } catch (err: unknown) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid credentials' });
      }
    } else if (body.authMethod === 'device') {
      if (!body.deviceId) return reply.status(400).send({ error: 'Device account needs deviceId (Laixi device id)' });
      data.deviceId = body.deviceId;
      data.accessToken = encrypt('device');
      data.sessionData = null;
    } else {
      if (!body.accessToken) return reply.status(400).send({ error: 'Official account needs accessToken' });
      data.accessToken = encrypt(body.accessToken);
      data.sessionData = null;
    }

    await db.socialAccount.update({ where: { id }, data });
    logger.info({ accountId: id, authMethod: body.authMethod }, 'Account credentials updated');
    return reply.send({ updated: true, authMethod: body.authMethod, ...(credNote ? { note: credNote } : {}) });
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

    const [rows, total] = await Promise.all([
      db.socialAccount.findMany({
        where,
        include: {
          accountGroup: { select: { name: true, enforceWarmup: true } },
          proxy: { select: { host: true, port: true, type: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      db.socialAccount.count({ where }),
    ]);

    // Attach publish-readiness; strip secrets from the response.
    const accounts = rows.map(({ accessToken: _at, refreshToken: _rt, sessionData, ...a }) => ({
      ...a,
      readiness: computeReadiness({
        isActive: a.isActive, authMethod: a.authMethod, healthScore: a.healthScore,
        warmupStatus: a.warmupStatus, shadowBanDetected: a.shadowBanDetected,
        hasSession: !!sessionData, hasProxy: !!a.proxyUrl, expiresAt: a.expiresAt,
        enforceWarmup: a.accountGroup?.enforceWarmup ?? false, hasDeviceId: !!a.deviceId,
      }),
    }));

    return reply.send({ accounts, total, page, limit });
  });

  // ── Publish diagnostics — "why can't I publish" in one shot ─────────────────
  // Walks the whole chain (publisher service → accounts → sessions → proxies)
  // and returns a checklist with concrete fixes, so autopublish failures are
  // self-diagnosable instead of surfacing as cryptic per-post errors.
  app.get('/diagnostics', async (request, reply) => {
    const { tenantId } = request.user;

    // 1. Publisher microservice reachability (written to Redis by orchestrator).
    let publisher: { ok: boolean; reason?: string; url?: string; checkedAt?: string; stale?: boolean };
    try {
      const raw = await getRedis().get('kmmzavod:health:publisher');
      if (!raw) {
        publisher = { ok: false, reason: 'Нет данных о publisher (оркестратор не запущен или ещё не пинговал)', stale: true };
      } else {
        publisher = JSON.parse(raw);
      }
    } catch {
      publisher = { ok: false, reason: 'Не удалось прочитать статус publisher из Redis' };
    }

    // 2. Accounts breakdown by readiness (the same logic the workers apply).
    const rows = await db.socialAccount.findMany({
      where: { tenantId },
      include: { accountGroup: { select: { enforceWarmup: true } } },
    });
    const blockerCounts: Record<string, number> = {};
    let canPublish = 0;
    for (const a of rows) {
      const r = computeReadiness({
        isActive: a.isActive, authMethod: a.authMethod, healthScore: a.healthScore,
        warmupStatus: a.warmupStatus, shadowBanDetected: a.shadowBanDetected,
        hasSession: !!a.sessionData, hasProxy: !!a.proxyUrl, expiresAt: a.expiresAt,
        enforceWarmup: a.accountGroup?.enforceWarmup ?? false, hasDeviceId: !!a.deviceId,
      });
      if (r.canPublish) canPublish++;
      for (const b of r.blockers) blockerCounts[b] = (blockerCounts[b] ?? 0) + 1;
    }

    // 3. Proxy health.
    const [proxyTotal, proxyActive, accountsNoProxy] = await Promise.all([
      db.proxy.count({ where: { tenantId } }),
      db.proxy.count({ where: { tenantId, isActive: true } }),
      db.socialAccount.count({ where: { tenantId, isActive: true, proxyId: null } }),
    ]);

    // 4. Build the actionable checklist.
    const checks: Array<{ id: string; ok: boolean; label: string; fix?: string }> = [
      {
        id: 'publisher', ok: publisher.ok,
        label: publisher.ok ? 'Сервис публикации доступен' : 'Сервис публикации недоступен',
        fix: publisher.ok ? undefined : (publisher.reason ?? 'Запустите: docker compose up -d publisher'),
      },
      {
        id: 'accounts', ok: rows.length > 0,
        label: rows.length > 0 ? `Аккаунтов: ${rows.length}` : 'Нет аккаунтов',
        fix: rows.length > 0 ? undefined : 'Импортируйте аккаунты на вкладке Accounts',
      },
      {
        id: 'ready', ok: canPublish > 0,
        label: `Готовы публиковать: ${canPublish} из ${rows.length}`,
        fix: canPublish > 0 ? undefined
          : 'Ни один аккаунт не готов — см. причины ниже (чаще всего нет sessionid для TikTok)',
      },
      {
        id: 'proxies', ok: proxyTotal === 0 || accountsNoProxy === 0,
        label: proxyTotal === 0 ? 'Прокси не заданы' : `Аккаунтов без прокси: ${accountsNoProxy}`,
        fix: accountsNoProxy > 0 ? 'Нажмите «Распределить прокси» на вкладке Proxies' : undefined,
      },
    ];

    const canPublishNow = publisher.ok && canPublish > 0;
    return reply.send({
      canPublishNow,
      publisher,
      checks,
      accounts: { total: rows.length, ready: canPublish, blockers: blockerCounts },
      proxies: { total: proxyTotal, active: proxyActive, accountsWithoutProxy: accountsNoProxy },
    });
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
