/**
 * Маршруты управления социальными аккаунтами и публикацией видео.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { encrypt } from '../lib/crypto';
import { publishQueue } from '../lib/queues';
import { logger } from '../logger';
import { config } from '../config';
import type { PublishJobPayload } from '@kmmzavod/queue';

// ── Validation schemas ──────────────────────────────────────────────────────

const CreateSocialAccountBody = z.object({
  platform: z.enum(['tiktok', 'instagram', 'youtube_shorts']),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  accountName: z.string().min(1).max(200),
  igUserId: z.string().regex(/^\d+$/, 'Must be a numeric Instagram Business Account ID').optional(),
  proxyUrl: z.string().url().optional(),
});

const PublishVideoBody = z.object({
  socialAccountId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  caption: z.string().max(2200).optional(),
  hashtags: z.array(z.string().max(100)).max(30).default([]),
  scheduledAt: z.string().datetime().optional(),
});

const ListPublishJobsQuery = z.object({
  status: z.enum(['pending', 'scheduled', 'uploading', 'published', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── Routes ──────────────────────────────────────────────────────────────────

export async function publishRoutes(app: FastifyInstance) {

  // ── Social OAuth (Public Callbacks) ─────────────────────────────────────

  app.get('/social/tiktok/callback', async (req, reply) => {
    const { code, state, error, error_description } = req.query as any;
    if (error) {
      logger.error({ error, error_description }, 'TikTok OAuth error callback');
      return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?error=tiktok_auth_failed`);
    }
    if (!code) return reply.code(400).send({ error: 'Missing code' });
    try {
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: config.TIKTOK_CLIENT_KEY!,
          client_secret: config.TIKTOK_CLIENT_SECRET!,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${config.NEXT_PUBLIC_API_URL}/api/v1/social/tiktok/callback`,
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (!tokenRes.ok) throw new Error('TikTok token exchange failed');
      const userRes = await fetch('https://open.tiktokapis.com/v2/user/info/', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json() as any;
      const accountName = userData?.data?.user?.display_name || userData?.data?.user?.username || 'TikTok Account';
      const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
      const { tenantId } = decodedState;
      await db.socialAccount.create({
        data: {
          tenantId,
          platform: 'tiktok',
          accessToken: encrypt(tokenData.access_token),
          refreshToken: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
          expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
          accountName,
        },
      });
      return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?success=tiktok_connected`);
    } catch (err) {
      logger.error({ err }, 'TikTok OAuth failed');
      return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?error=tiktok_auth_failed`);
    }
  });

  app.get('/social/youtube/callback', async (req, reply) => {
    const { code, state, error } = req.query as any;
    if (error) return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?error=youtube_auth_failed`);
    if (!code) return reply.code(400).send({ error: 'Missing code' });
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.YOUTUBE_CLIENT_ID!,
          client_secret: config.YOUTUBE_CLIENT_SECRET!,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${config.NEXT_PUBLIC_API_URL}/api/v1/social/youtube/callback`,
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (!tokenRes.ok) throw new Error('YouTube token exchange failed');
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json() as any;
      const accountName = userData?.name || 'YouTube Account';
      const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
      const { tenantId } = decodedState;
      await db.socialAccount.create({
        data: {
          tenantId,
          platform: 'youtube_shorts',
          accessToken: encrypt(tokenData.access_token),
          refreshToken: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
          expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
          accountName,
        },
      });
      return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?success=youtube_connected`);
    } catch (err) {
      logger.error({ err }, 'YouTube OAuth failed');
      return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?error=youtube_auth_failed`);
    }
  });

  app.get('/social/instagram/callback', async (req, reply) => {
    const { code, state, error } = req.query as any;
    if (error) return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?error=instagram_auth_failed`);
    if (!code) return reply.code(400).send({ error: 'Missing code' });
    try {
      const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.INSTAGRAM_APP_ID!,
          client_secret: config.INSTAGRAM_APP_SECRET!,
          redirect_uri: `${config.NEXT_PUBLIC_API_URL}/api/v1/social/instagram/callback`,
          code,
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (!tokenRes.ok) throw new Error('Instagram token exchange failed');
      const longLivedRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${config.INSTAGRAM_APP_ID}&client_secret=${config.INSTAGRAM_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
      const longLivedData = await longLivedRes.json() as any;
      const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longLivedData.access_token}`);
      const pagesData = await pagesRes.json() as any;
      if (!pagesData.data || pagesData.data.length === 0) throw new Error('No Facebook pages found');
      let igAccountId = null, accountName = 'Instagram Account';
      for (const page of pagesData.data) {
        const igRes = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account,name&access_token=${longLivedData.access_token}`);
        const igData = await igRes.json() as any;
        if (igData.instagram_business_account) {
          igAccountId = igData.instagram_business_account.id;
          accountName = `IG: ${igData.name}`;
          break;
        }
      }
      if (!igAccountId) throw new Error('No Instagram Business Account linked');
      const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
      const { tenantId } = decodedState;
      await db.socialAccount.create({
        data: {
          tenantId,
          platform: 'instagram',
          accessToken: encrypt(longLivedData.access_token),
          expiresAt: longLivedData.expires_in ? new Date(Date.now() + longLivedData.expires_in * 1000) : null,
          accountName,
          igUserId: igAccountId,
        },
      });
      return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?success=instagram_connected`);
    } catch (err: any) {
      logger.error({ err }, 'Instagram OAuth failed');
      return reply.redirect(`${config.NEXT_PUBLIC_API_URL?.replace(':3000', ':3001')}/settings?error=instagram_auth_failed&message=${encodeURIComponent(err.message)}`);
    }
  });

  // ── Protected Routes ───────────────────────────────────────────────────

  app.addHook('preHandler', app.authenticate);

  app.get('/social/tiktok/authorize', async (req, reply) => {
    if (!config.TIKTOK_CLIENT_KEY) return reply.code(400).send({ error: 'TikTok OAuth not configured' });
    const state = Buffer.from(JSON.stringify({ tenantId: req.user.tenantId, userId: req.user.id })).toString('base64');
    const qs = new URLSearchParams({
      client_key: config.TIKTOK_CLIENT_KEY,
      scope: 'user.info.basic,video.upload,video.publish',
      response_type: 'code',
      redirect_uri: `${config.NEXT_PUBLIC_API_URL}/api/v1/social/tiktok/callback`,
      state,
    }).toString();
    return reply.redirect(`https://www.tiktok.com/v2/auth/authorize/?${qs}`);
  });

  app.get('/social/youtube/authorize', async (req, reply) => {
    if (!config.YOUTUBE_CLIENT_ID) return reply.code(400).send({ error: 'YouTube OAuth not configured' });
    const state = Buffer.from(JSON.stringify({ tenantId: req.user.tenantId, userId: req.user.id })).toString('base64');
    const qs = new URLSearchParams({
      client_id: config.YOUTUBE_CLIENT_ID,
      redirect_uri: `${config.NEXT_PUBLIC_API_URL}/api/v1/social/youtube/callback`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/userinfo.profile',
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString();
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${qs}`);
  });

  app.get('/social/instagram/authorize', async (req, reply) => {
    if (!config.INSTAGRAM_APP_ID) return reply.code(400).send({ error: 'Instagram OAuth not configured' });
    const state = Buffer.from(JSON.stringify({ tenantId: req.user.tenantId, userId: req.user.id })).toString('base64');
    const qs = new URLSearchParams({
      client_id: config.INSTAGRAM_APP_ID,
      redirect_uri: `${config.NEXT_PUBLIC_API_URL}/api/v1/social/instagram/callback`,
      scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
      response_type: 'code',
      state,
    }).toString();
    return reply.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${qs}`);
  });

  app.post('/social-accounts', async (req, reply) => {
    const body = CreateSocialAccountBody.parse(req.body);
    const { tenantId } = req.user;
    const account = await db.socialAccount.create({
      data: {
        tenantId,
        platform: body.platform,
        accessToken: encrypt(body.accessToken),
        refreshToken: body.refreshToken ? encrypt(body.refreshToken) : undefined,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        accountName: body.accountName,
        igUserId: body.igUserId,
        proxyUrl: body.proxyUrl,
      },
    });
    return reply.code(201).send({ id: account.id, platform: account.platform, accountName: account.accountName, isActive: account.isActive, createdAt: account.createdAt });
  });

  app.get('/social-accounts', async (req) => {
    const { tenantId } = req.user;
    const accounts = await db.socialAccount.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, platform: true, accountName: true, isActive: true, expiresAt: true, proxyUrl: true, createdAt: true, _count: { select: { publishJobs: true } } },
    });
    return { data: accounts };
  });

  app.delete<{ Params: { id: string } }>('/social-accounts/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params;
    const account = await db.socialAccount.findFirst({ where: { id, tenantId } });
    if (!account) return reply.code(404).send({ error: 'NotFound', message: 'Social account not found' });
    await db.socialAccount.update({ where: { id }, data: { isActive: false } });
    return { success: true };
  });

  app.post<{ Params: { videoId: string } }>('/videos/:videoId/publish', async (req, reply) => {
    const body = PublishVideoBody.parse(req.body);
    const { tenantId } = req.user;
    const { videoId } = req.params;
    const video = await db.video.findFirst({ where: { id: videoId, tenantId, status: 'completed' } });
    if (!video) return reply.code(404).send({ error: 'NotFound', message: 'Video not found or not yet completed' });
    const account = await db.socialAccount.findFirst({ where: { id: body.socialAccountId, tenantId, isActive: true } });
    if (!account) return reply.code(404).send({ error: 'NotFound', message: 'Social account not found or not active' });
    if (body.variantId) {
      const variant = await db.videoVariant.findFirst({ where: { id: body.variantId, videoId } });
      if (!variant) return reply.code(404).send({ error: 'NotFound', message: 'Video variant not found' });
    }
    const publishJob = await db.publishJob.create({
      data: { videoId, tenantId, socialAccountId: body.socialAccountId, variantId: body.variantId, platform: account.platform, caption: body.caption, hashtags: body.hashtags, scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null, status: body.scheduledAt ? 'scheduled' : 'pending' },
    });
    const jobPayload: PublishJobPayload = { publishJobId: publishJob.id, videoId, tenantId, platform: account.platform, socialAccountId: account.id, scheduledAt: body.scheduledAt };
    const delay = body.scheduledAt ? Math.max(0, new Date(body.scheduledAt).getTime() - Date.now()) : undefined;
    await publishQueue.add(`publish:${publishJob.id}`, jobPayload, { delay, jobId: publishJob.id });
    return reply.code(201).send({ id: publishJob.id, platform: publishJob.platform, status: publishJob.status, scheduledAt: publishJob.scheduledAt, createdAt: publishJob.createdAt });
  });

  app.get<{ Params: { videoId: string } }>('/videos/:videoId/publish-jobs', async (req) => {
    const { tenantId } = req.user;
    const { videoId } = req.params;
    const query = ListPublishJobsQuery.parse(req.query);
    const where = { videoId, tenantId, ...(query.status && { status: query.status }) };
    const [data, total] = await Promise.all([
      db.publishJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: { id: true, platform: true, status: true, caption: true, hashtags: true, scheduledAt: true, publishedAt: true, externalPostId: true, error: true, createdAt: true, socialAccount: { select: { id: true, accountName: true, platform: true } } },
      }),
      db.publishJob.count({ where }),
    ]);
    return { data, pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  });
}
