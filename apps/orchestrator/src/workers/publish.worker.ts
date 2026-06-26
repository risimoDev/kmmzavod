/**
 * Publish worker — публикует финальное видео в соцсети.
 *
 * TikTok:   скачивает видео из MinIO во temp файл → uploadVideo() → удаляет файл
 * Instagram: генерирует presigned URL → uploadReel() (Instagram сам скачивает)
 *
 * Retry: BullMQ retries (attempts: 3, fixed backoff 30s). При финальном провале → status: failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import { QUEUES, type PublishJobPayload, type ShadowBanCheckPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { IStorageClient } from '@kmmzavod/storage';
import { TikTokClient } from '../clients/social/tiktok.client';
import { InstagramClient } from '../clients/social/instagram.client';
import { PostBridgeClient } from '../clients/social/postbridge.client';
import { YouTubeClient } from '../clients/social/youtube.client';
import { logger as rootLogger } from '../logger';
import { decrypt, encrypt } from '../lib/crypto';
import { publisherService, describePublisherError } from '../services/publisher';

const logger = rootLogger.child({ worker: 'publish' });

interface Deps {
  db: PrismaClient;
  storage: IStorageClient;
  connection: ConnectionOptions;
  shadowBanCheckQueue?: Queue<ShadowBanCheckPayload>;
  tiktokClientKey?: string;
  tiktokClientSecret?: string;
  instagramAppId?: string;
  instagramAppSecret?: string;
  postBridgeApiKey?: string;
  youtubeClientId?: string;
  youtubeClientSecret?: string;
}

export function createPublishWorker(deps: Deps): Worker {
  const { db, storage, connection, shadowBanCheckQueue } = deps;

  const tiktok = deps.tiktokClientKey && deps.tiktokClientSecret
    ? new TikTokClient(deps.tiktokClientKey, deps.tiktokClientSecret)
    : null;
  const instagram = deps.instagramAppId && deps.instagramAppSecret
    ? new InstagramClient(deps.instagramAppId, deps.instagramAppSecret)
    : null;
  const postbridge = deps.postBridgeApiKey
    ? new PostBridgeClient(deps.postBridgeApiKey)
    : null;
  const youtube = new YouTubeClient();

  return new Worker<PublishJobPayload>(
    QUEUES['publish'].name,
    async (job) => {
      const { publishJobId, videoId, tenantId, platform, socialAccountId } = job.data;
      logger.info({ publishJobId, platform, videoId, attempt: job.attemptsMade + 1 }, 'Publish: старт');

      // Mark as uploading
      await db.publishJob.update({
        where: { id: publishJobId },
        data: { status: 'uploading' },
      });

      try {
        // Load social account and decrypt tokens
        const accountRaw = await db.socialAccount.findUniqueOrThrow({
          where: { id: socialAccountId },
        });
        const account = {
          ...accountRaw,
          accessToken: decrypt(accountRaw.accessToken),
          refreshToken: accountRaw.refreshToken ? decrypt(accountRaw.refreshToken) : null,
        };

        if (!account.isActive) {
          throw new Error(`Social account ${socialAccountId} is disabled`);
        }
        if ((accountRaw.healthScore ?? 100) < 30) {
          throw new Error(`Social account ${socialAccountId} health score too low (${accountRaw.healthScore}) — paused for safety`);
        }

        // Set per-account proxy on all social clients (isolation: each tenant uses their own IP)
        const accountProxy = account.proxyUrl ?? null;
        if (tiktok) tiktok.proxyUrl = accountProxy;
        if (instagram) instagram.proxyUrl = accountProxy;
        youtube.proxyUrl = accountProxy;
        if (postbridge) postbridge.proxyUrl = accountProxy;

        if (accountProxy) {
          const safeProxy = accountProxy.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
          logger.info({ socialAccountId, proxy: safeProxy }, 'Publish: using per-account proxy');
        }

        // Load publish job for caption/hashtags + determine video storage key
        const publishJob = await db.publishJob.findUniqueOrThrow({
          where: { id: publishJobId },
          select: { caption: true, hashtags: true, variantId: true, uniqueVariantId: true },
        });

        // Abort if this publish was scheduled from a distribution that got cancelled
        const linkedDistItem = await db.distributeItem.findFirst({
          where: { publishJobId },
          select: { id: true, distributeJobId: true },
        });
        if (linkedDistItem) {
          const distJob = await db.distributeJob.findUnique({
            where: { id: linkedDistItem.distributeJobId },
            select: { status: true },
          });
          if (distJob?.status === 'cancelled') {
            logger.info({ publishJobId, distributeJobId: linkedDistItem.distributeJobId }, 'Publish: distribution cancelled, aborting');
            await db.publishJob.update({
              where: { id: publishJobId },
              data: { status: 'failed', error: 'Distribution cancelled' },
            });
            return;
          }
        }

        let storageKey: string;

        if (publishJob.uniqueVariantId) {
          // Uniquified variant — resolve from UniqueVariant
          const uVariant = await db.uniqueVariant.findUniqueOrThrow({
            where: { id: publishJob.uniqueVariantId },
            select: { outputKey: true },
          });
          if (!uVariant.outputKey) throw new Error(`UniqueVariant ${publishJob.uniqueVariantId} has no outputKey`);
          storageKey = uVariant.outputKey;
        } else if (publishJob.variantId) {
          const variant = await db.videoVariant.findUniqueOrThrow({
            where: { id: publishJob.variantId },
            select: { outputKey: true },
          });
          storageKey = variant.outputKey;
        } else if (videoId) {
          const video = await db.video.findUniqueOrThrow({
            where: { id: videoId },
            select: { outputUrl: true },
          });
          if (!video.outputUrl) throw new Error(`Video ${videoId} has no outputUrl`);
          storageKey = video.outputUrl;
        } else {
          throw new Error(`PublishJob ${publishJobId} has no videoId or uniqueVariantId`);
        }

        let externalPostId: string | undefined;

        // ── Private path (unofficial publisher microservice) ───────────────────
        // Routes Instagram/TikTok through apps/publisher (instagrapi / tiktok-uploader)
        // using the account's stored session + proxy, instead of the official API.
        const isPrivate =
          accountRaw.authMethod === 'private' && (platform === 'instagram' || platform === 'tiktok');

        if (isPrivate) {
          let sessionData: Record<string, unknown> = {};
          if (accountRaw.sessionData) {
            try {
              sessionData = JSON.parse(decrypt(accountRaw.sessionData));
            } catch (e) {
              throw new Error(`private-${platform}: cannot read stored session (${(e as Error).message})`);
            }
          }
          const presignedUrl = await storage.presignedUrl(storageKey, 3600);
          const fullCaption = buildCaption(publishJob.caption, publishJob.hashtags);

          try {
            const result =
              platform === 'instagram'
                ? await publisherService.instagramPublish({
                    videoUrl: presignedUrl,
                    caption: fullCaption,
                    proxyUrl: accountRaw.proxyUrl,
                    deviceFingerprint: accountRaw.deviceFingerprint as Record<string, unknown> | null,
                    sessionData,
                  })
                : await publisherService.tiktokPublish({
                    videoUrl: presignedUrl,
                    caption: fullCaption,
                    proxyUrl: accountRaw.proxyUrl,
                    sessionData,
                  });

            externalPostId = result.externalId ?? undefined;

            // Persist the refreshed session so the next post reuses it (no re-login).
            if (result.sessionData && Object.keys(result.sessionData).length > 0) {
              await db.socialAccount.update({
                where: { id: socialAccountId },
                data: { sessionData: encrypt(JSON.stringify(result.sessionData)) },
              });
            }
          } catch (err: unknown) {
            throw new Error(`publisher-${platform}: ${describePublisherError(err)}`);
          }
        } else
        switch (platform) {
          // ── TikTok: download to temp file → upload ──────────────────────────
          case 'tiktok': {
            if (!tiktok) throw new Error('TikTok client not configured (missing client key/secret)');

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
            const tmpFile = path.join(tmpDir, 'video.mp4');
            try {
              await storage.downloadFile(storageKey, tmpFile);
              const fullCaption = buildCaption(publishJob.caption, publishJob.hashtags);

              const result = await tiktok.uploadVideo(
                { accessToken: account.accessToken, refreshToken: account.refreshToken ?? '' },
                tmpFile,
                fullCaption,
              );
              externalPostId = result.publishId;

              // Persist rotated tokens if returned
              if (result.newAccessToken) {
                await db.socialAccount.update({
                  where: { id: socialAccountId },
                  data: {
                    accessToken: encrypt(result.newAccessToken),
                    refreshToken: result.newRefreshToken ? encrypt(result.newRefreshToken) : accountRaw.refreshToken,
                    expiresAt: result.newExpiresAt ?? account.expiresAt,
                  },
                });
              }
            } finally {
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            break;
          }

          // ── Instagram: presigned URL (no temp file) ─────────────────────────
          case 'instagram': {
            if (!instagram) throw new Error('Instagram client not configured (missing appId/appSecret)');
            if (!account.igUserId) throw new Error(`Social account ${socialAccountId} is missing igUserId (Instagram Business Account ID)`);

            const presignedUrl = await storage.presignedUrl(storageKey, 3600);
            const result = await instagram.uploadReel(
              account.accessToken,
              account.igUserId,
              presignedUrl,
              publishJob.caption ?? '',
              publishJob.hashtags as string[] | undefined,
            );
            externalPostId = result.mediaId;
            break;
          }

          case 'youtube_shorts': {
            if (!deps.youtubeClientId || !deps.youtubeClientSecret) {
              throw new Error('YouTube client not configured (missing YOUTUBE_CLIENT_ID/SECRET)');
            }
            if (!account.refreshToken) {
              throw new Error(`Social account ${socialAccountId} is missing refreshToken for YouTube OAuth`);
            }

            // Refresh OAuth2 token
            const tokenResult = await youtube.refreshToken(
              deps.youtubeClientId,
              deps.youtubeClientSecret,
              account.refreshToken,
            );

            // Persist refreshed access token
            await db.socialAccount.update({
              where: { id: socialAccountId },
              data: {
                accessToken: encrypt(tokenResult.accessToken),
                expiresAt: new Date(Date.now() + tokenResult.expiresIn * 1000),
              },
            });

            // Download video to temp file and upload
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-yt-'));
            const tmpFile = path.join(tmpDir, 'video.mp4');
            try {
              await storage.downloadFile(storageKey, tmpFile);
              const fullCaption = buildCaption(publishJob.caption, publishJob.hashtags);

              // Load video metadata for title/description (may be null for uniquified variants)
              const video = videoId
                ? await db.video.findUnique({
                    where: { id: videoId },
                    select: { title: true, description: true, metadata: true },
                  })
                : null;

              const socialMeta = (video?.metadata as any)?.socialMetadata;
              const title = video?.title ?? 'Video';
              const description = socialMeta?.description ?? fullCaption;
              const hashtags: string[] = socialMeta?.hashtags ?? publishJob.hashtags ?? [];

              const result = await youtube.uploadShort(
                tokenResult.accessToken,
                tmpFile,
                title,
                description,
                hashtags,
              );
              externalPostId = result.videoId;
            } finally {
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            break;
          }

          // ── PostBridge: download to temp → upload to PostBridge → cross-post ──
          case 'postbridge': {
            if (!postbridge) throw new Error('PostBridge client not configured (missing POST_BRIDGE_API_KEY)');

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-pb-'));
            const tmpFile = path.join(tmpDir, 'video.mp4');
            try {
              await storage.downloadFile(storageKey, tmpFile);
              const mediaId = await postbridge.uploadMedia(tmpFile);
              const fullCaption = buildCaption(publishJob.caption, publishJob.hashtags);

              // Use PostBridge account ID stored in socialAccount.accountName (numeric)
              const pbAccountId = parseInt(account.accountName, 10);
              if (isNaN(pbAccountId)) throw new Error(`Invalid PostBridge account ID: ${account.accountName}`);

              const result = await postbridge.createPost({
                caption: fullCaption,
                socialAccountIds: [pbAccountId],
                mediaIds: [mediaId],
              });
              externalPostId = result.id;
            } finally {
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            break;
          }

          default:
            throw new Error(`Unknown platform: ${platform}`);
        }

        // Mark as published and update account health
        const now = new Date();
        await db.$transaction([
          db.publishJob.update({
            where: { id: publishJobId },
            data: {
              status: 'published',
              publishedAt: now,
              externalPostId,
            },
          }),
          db.socialAccount.update({
            where: { id: socialAccountId },
            data: {
              dailyPostCount: { increment: 1 },
              lastPostAt: now,
              healthScore: { increment: 5 },
            },
          }),
        ]);
        // Clamp healthScore at 100 via a second update if needed (Prisma doesn't support cap in single update)
        await db.socialAccount.updateMany({
          where: { id: socialAccountId, healthScore: { gt: 100 } },
          data: { healthScore: 100 },
        });

        // Update linked DistributeItem if this publish came from distribution
        const distItem = await db.distributeItem.findFirst({
          where: { publishJobId },
          select: { id: true, distributeJobId: true },
        });
        if (distItem) {
          await db.distributeItem.update({
            where: { id: distItem.id },
            data: { status: 'published', publishedAt: now },
          });
          // Increment published count and check if distribution is complete
          const distJob = await db.distributeJob.update({
            where: { id: distItem.distributeJobId },
            data: { publishedCount: { increment: 1 } },
            select: { publishedCount: true, failedCount: true, totalItems: true },
          });
          if (distJob.publishedCount + distJob.failedCount >= distJob.totalItems) {
            await db.distributeJob.update({
              where: { id: distItem.distributeJobId },
              data: { status: 'completed', completedAt: now },
            });
          }
        }

        logger.info({ publishJobId, platform, externalPostId }, 'Publish: success');

        // Schedule shadow-ban check ~45 min after publish
        if (shadowBanCheckQueue) {
          await shadowBanCheckQueue.add(
            `shadow-ban-${publishJobId}`,
            {
              publishJobId,
              socialAccountId,
              tenantId,
              platform,
              externalPostId,
              hashtags: publishJob.hashtags ?? [],
            } satisfies ShadowBanCheckPayload,
            { delay: 45 * 60_000, attempts: 1 },
          );
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ publishJobId, platform, err: errorMsg }, 'Publish: failed');

        const now = new Date();
        const isRateLimit = /rate.?limit|too.?many|429|action.?block/i.test(errorMsg);
        const healthDelta = isRateLimit ? -30 : -20;
        await db.$transaction([
          db.publishJob.update({
            where: { id: publishJobId },
            data: { status: 'failed', error: errorMsg },
          }),
          db.socialAccount.update({
            where: { id: socialAccountId },
            data: {
              healthScore: { increment: healthDelta },
              ...(isRateLimit ? { lastError: errorMsg } : {}),
            },
          }),
        ]);
        // Clamp healthScore at 0
        await db.socialAccount.updateMany({
          where: { id: socialAccountId, healthScore: { lt: 0 } },
          data: { healthScore: 0 },
        });

        // Update linked DistributeItem on failure so distribution can complete
        const distItem = await db.distributeItem.findFirst({
          where: { publishJobId },
          select: { id: true, distributeJobId: true },
        });
        if (distItem) {
          await db.distributeItem.update({
            where: { id: distItem.id },
            data: { status: 'failed', error: errorMsg },
          });
          const distJob = await db.distributeJob.update({
            where: { id: distItem.distributeJobId },
            data: { failedCount: { increment: 1 } },
            select: { publishedCount: true, failedCount: true, totalItems: true },
          });
          if (distJob.publishedCount + distJob.failedCount >= distJob.totalItems) {
            await db.distributeJob.update({
              where: { id: distItem.distributeJobId },
              data: { status: 'completed', completedAt: now },
            });
          }
        }

        throw err; // Let BullMQ handle retries
      }
    },
    {
      connection,
      concurrency: QUEUES['publish'].concurrency,
    },
  );
}

function buildCaption(caption: string | null, hashtags: string[]): string {
  const parts: string[] = [];
  if (caption) parts.push(caption);
  if (hashtags.length > 0) {
    const tags = hashtags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
    parts.push(tags);
  }
  return parts.join('\n\n');
}
