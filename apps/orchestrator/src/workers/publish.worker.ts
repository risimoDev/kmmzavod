/**
 * Publish worker — публикует финальное видео в соцсети.
 *
 * TikTok:   скачивает видео из MinIO во temp файл → uploadVideo() → удаляет файл
 * Instagram: генерирует presigned URL → uploadReel() (Instagram сам скачивает)
 *
 * Retry: BullMQ retries (attempts: 3, fixed backoff 30s). Между попытками → status: pending,
 * при финальном провале → status: failed (и один штраф healthScore, если виноват не наш сервис).
 * Занятый телефон откладывает задачу без расхода попытки. Опубликованное повторно не постится.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker, Queue, DelayedError, type ConnectionOptions } from 'bullmq';
import { QUEUES, type PublishJobPayload, type ShadowBanCheckPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { IStorageClient } from '@kmmzavod/storage';
import { TikTokClient } from '../clients/social/tiktok.client';
import { InstagramClient } from '../clients/social/instagram.client';
import { PostBridgeClient } from '../clients/social/postbridge.client';
import { YouTubeClient } from '../clients/social/youtube.client';
import { logger as rootLogger } from '../logger';
import { decrypt, encrypt } from '../lib/crypto';
import { getRedisConnection } from '../lib/redis';
import type Redis from 'ioredis';
import { publisherService, describePublisherError } from '../services/publisher';
import { deviceAgentService, describeDeviceAgentError } from '../services/device-agent';

const logger = rootLogger.child({ worker: 'publish' });

/** A busy phone re-queues the job after this delay without burning an attempt. */
const DEVICE_BUSY_RETRY_MS = 90_000;

/**
 * Per-device publish lock. The value is a random owner token so a worker whose lock
 * already expired can never delete a lock that another worker acquired since.
 * Returns the token, or null if the device stayed busy for `waitMs`.
 */
async function acquireDeviceLock(redis: Redis, deviceId: string, ttlSec: number, waitMs = 5_000): Promise<string | null> {
  const key = `lock:device:${deviceId}`;
  const owner = randomUUID();
  const start = Date.now();
  do {
    if ((await redis.set(key, owner, 'EX', ttlSec, 'NX')) === 'OK') return owner;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() - start < waitMs);
  return null;
}

const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

async function releaseDeviceLock(redis: Redis, deviceId: string, owner: string): Promise<void> {
  await redis.eval(RELEASE_LOCK_LUA, 1, `lock:device:${deviceId}`, owner).catch(() => {});
}

/**
 * Failures that say nothing about the social account itself (our services, network,
 * storage, config). They must not lower the account's healthScore — otherwise a
 * publisher outage drives every account below the 30-point safety floor.
 */
const INFRA_ERROR_RE =
  /unreachable|did not answer in time|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|socket hang up|not configured|has no outputKey|has no outputUrl|NoSuchKey|cannot read stored session|занят/i;

export function isInfrastructureError(message: string): boolean {
  return INFRA_ERROR_RE.test(message);
}

const DIST_ITEM_OPEN = ['pending', 'scheduled', 'publishing'] as const;

/**
 * Records the final outcome of a publish on its DistributeItem (if any) exactly once:
 * the item is claimed with a conditional update, so retries, the worker and the
 * BullMQ `failed` handler can all call this without double-counting.
 */
export async function settleDistributeItem(
  db: PrismaClient,
  publishJobId: string,
  outcome: { status: 'published'; at: Date } | { status: 'failed'; error: string },
): Promise<void> {
  const item = await db.distributeItem.findFirst({
    where: { publishJobId },
    select: { id: true, distributeJobId: true },
  });
  if (!item) return;

  const claimed = await db.distributeItem.updateMany({
    where: { id: item.id, status: { in: [...DIST_ITEM_OPEN] } },
    data: outcome.status === 'published'
      ? { status: 'published', publishedAt: outcome.at }
      : { status: 'failed', error: outcome.error },
  });
  if (claimed.count === 0) return; // already settled

  const distJob = await db.distributeJob.update({
    where: { id: item.distributeJobId },
    data: outcome.status === 'published' ? { publishedCount: { increment: 1 } } : { failedCount: { increment: 1 } },
    select: { publishedCount: true, failedCount: true, totalItems: true },
  });
  if (distJob.publishedCount + distJob.failedCount >= distJob.totalItems) {
    await db.distributeJob.update({
      where: { id: item.distributeJobId },
      data: { status: 'completed', completedAt: new Date() },
    });
  }
}

/** Final (all attempts used) failure bookkeeping. Idempotent. */
export async function finalizePublishFailure(db: PrismaClient, publishJobId: string, errorMsg: string): Promise<void> {
  await db.publishJob.updateMany({
    where: { id: publishJobId, status: { not: 'published' } },
    data: { status: 'failed', error: errorMsg },
  });
  await settleDistributeItem(db, publishJobId, { status: 'failed', error: errorMsg });
}

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

  return new Worker<PublishJobPayload>(
    QUEUES['publish'].name,
    async (job, token) => {
      const { publishJobId, videoId, tenantId, platform, socialAccountId } = job.data;
      logger.info({ publishJobId, platform, videoId, attempt: job.attemptsMade + 1 }, 'Publish: старт');

      // Idempotency: a retry (or a duplicate enqueue) must never post the same job twice.
      const existing = await db.publishJob.findUnique({ where: { id: publishJobId }, select: { status: true } });
      if (!existing) {
        logger.warn({ publishJobId }, 'Publish: PublishJob not found, skipping');
        return;
      }
      if (existing.status === 'published') {
        logger.warn({ publishJobId }, 'Publish: already published, skipping duplicate run');
        return;
      }

      let accountName = socialAccountId;
      /** Set the moment the platform accepted the post — from then on, never retry. */
      let posted = false;
      let externalPostId: string | undefined;

      // Mark as uploading
      await db.publishJob.update({
        where: { id: publishJobId },
        data: { status: 'uploading' },
      });

      // Social clients are created per job: their `proxyUrl` is mutable state, and with
      // concurrency > 1 shared instances let one account post through another's proxy.
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

      try {
        // Load social account and decrypt tokens
        const accountRaw = await db.socialAccount.findUniqueOrThrow({
          where: { id: socialAccountId },
        });
        accountName = accountRaw.accountName;
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

            posted = true;
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
        } else if (
          accountRaw.authMethod === 'device' && (platform === 'instagram' || platform === 'tiktok' || platform === 'youtube_shorts')
        ) {
          // ── Device path (real phone farm via native ADB + apps/device-agent) ──
          if (!accountRaw.deviceId) {
            throw new Error(`device-${platform}: account has authMethod=device but no deviceId set`);
          }
          const presignedUrl = await storage.presignedUrl(storageKey, 3600);
          const fullCaption = buildCaption(publishJob.caption, publishJob.hashtags);

          const redis = getRedisConnection();
          // TTL covers the agent call (600s): it may wait for the shared farm proxy before uploading.
          const lockOwner = await acquireDeviceLock(redis, accountRaw.deviceId, 660);
          if (!lockOwner) {
            // A busy phone is not the account's fault: re-queue later without consuming an
            // attempt or touching healthScore, and free this worker slot meanwhile.
            await db.publishJob.update({
              where: { id: publishJobId },
              data: { status: 'pending', error: `Телефон ${accountRaw.deviceId} занят — повтор через ~${Math.round(DEVICE_BUSY_RETRY_MS / 1000)} с` },
            });
            await job.moveToDelayed(Date.now() + DEVICE_BUSY_RETRY_MS, token);
            throw new DelayedError();
          }

          try {
            const result = await deviceAgentService.publish({
              deviceId: accountRaw.deviceId,
              platform,
              videoUrl: presignedUrl,
              caption: fullCaption,
            });
            if (!result.ok) throw new Error(result.detail ?? 'device-agent reported failure');
            posted = true;
            // No external post id available from real-app UI automation.
          } catch (err: unknown) {
            throw new Error(`device-${platform}: ${describeDeviceAgentError(err)}`);
          } finally {
            await releaseDeviceLock(redis, accountRaw.deviceId, lockOwner);
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
              posted = true;
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
            posted = true;
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
              posted = true;
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
              posted = true;
              externalPostId = result.id;
            } finally {
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            break;
          }

          default:
            throw new Error(`Unknown platform: ${platform}`);
        }

        // Mark as published FIRST (on its own): if any later bookkeeping fails, the catch
        // block sees `posted` and will not hand the job back to BullMQ for a re-post.
        const now = new Date();
        await db.publishJob.update({
          where: { id: publishJobId },
          data: { status: 'published', publishedAt: now, externalPostId, error: null },
        });
        await db.socialAccount.update({
          where: { id: socialAccountId },
          data: {
            dailyPostCount: { increment: 1 },
            lastPostAt: now,
            healthScore: { increment: 5 },
          },
        });
        // Clamp healthScore at 100 via a second update if needed (Prisma doesn't support cap in single update)
        await db.socialAccount.updateMany({
          where: { id: socialAccountId, healthScore: { gt: 100 } },
          data: { healthScore: 100 },
        });

        await settleDistributeItem(db, publishJobId, { status: 'published', at: now });

        logger.info({ publishJobId, platform, externalPostId }, 'Publish: success');

        await db.notification.create({
          data: {
            tenantId,
            type: 'system',
            title: `Видео опубликовано (${platform.toUpperCase()})`,
            body: `Аккаунт: ${accountRaw.accountName}${accountRaw.deviceId ? ` · Телефон ${accountRaw.deviceId}` : ''}`,
            actionUrl: `/uniquify`,
          },
        }).catch(() => {});

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
        if (err instanceof DelayedError) throw err; // phone busy → re-queued, not a failure

        const errorMsg = err instanceof Error ? err.message : String(err);

        if (posted) {
          // The platform already has the post. Retrying would publish it twice, so only
          // make sure the job is recorded as published and swallow the error.
          logger.error({ publishJobId, platform, err: errorMsg }, 'Publish: posted, but bookkeeping failed — not retrying');
          const now = new Date();
          await db.publishJob.update({
            where: { id: publishJobId },
            data: { status: 'published', publishedAt: now, externalPostId, error: `Опубликовано; ошибка учёта: ${errorMsg}`.slice(0, 2000) },
          }).catch(() => {});
          await settleDistributeItem(db, publishJobId, { status: 'published', at: now }).catch(() => {});
          return;
        }

        const maxAttempts = job.opts?.attempts ?? 1;
        const isFinal = job.attemptsMade + 1 >= maxAttempts;
        logger.error({ publishJobId, platform, err: errorMsg, attempt: job.attemptsMade + 1, maxAttempts }, 'Publish: failed');

        if (!isFinal) {
          // BullMQ will retry: keep the job (and its distribution item) open.
          await db.publishJob.update({
            where: { id: publishJobId },
            data: { status: 'pending', error: `Попытка ${job.attemptsMade + 1}/${maxAttempts}: ${errorMsg}`.slice(0, 2000) },
          }).catch(() => {});
          throw err;
        }

        await finalizePublishFailure(db, publishJobId, errorMsg);

        // Penalize the account once per job, and only for account/platform-side failures.
        if (!isInfrastructureError(errorMsg)) {
          const isRateLimit = /rate.?limit|too.?many|429|action.?block/i.test(errorMsg);
          await db.socialAccount.update({
            where: { id: socialAccountId },
            data: {
              healthScore: { increment: isRateLimit ? -30 : -20 },
              ...(isRateLimit ? { lastError: errorMsg } : {}),
            },
          }).catch(() => {});
          await db.socialAccount.updateMany({
            where: { id: socialAccountId, healthScore: { lt: 0 } },
            data: { healthScore: 0 },
          });
        }

        await db.notification.create({
          data: {
            tenantId,
            type: 'job_failed',
            title: `Ошибка публикации (${platform.toUpperCase()})`,
            body: `Аккаунт: ${accountName}. Ошибка: ${errorMsg}`,
            actionUrl: `/uniquify`,
          },
        }).catch(() => {});

        throw err; // last attempt → BullMQ moves the job to failed
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
