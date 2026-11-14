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
import axios from 'axios';
import { Worker, Queue, DelayedError, UnrecoverableError, type ConnectionOptions } from 'bullmq';
import { QUEUES, type PublishJobPayload, type ShadowBanCheckPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { IStorageClient } from '@kmmzavod/storage';
import { TikTokClient } from '../clients/social/tiktok.client';
import { InstagramClient } from '../clients/social/instagram.client';
import { PostBridgeClient } from '../clients/social/postbridge.client';
import { YouTubeClient } from '../clients/social/youtube.client';
import { config } from '../config';
import { logger as rootLogger } from '../logger';
import { decrypt, encrypt } from '../lib/crypto';
import { normalizeCaption } from '../lib/caption';
import { getRedisConnection } from '../lib/redis';
import type Redis from 'ioredis';
import { publisherService, describePublisherError } from '../services/publisher';
import {
  deviceAgentService,
  describeDeviceAgentError,
  DEVICE_PUBLISH_TIMEOUT_MS,
  type DevicePublishResult,
} from '../services/device-agent';
import { rotateIpForFarmDevice } from '../lib/astroproxy';

/** Username the device-agent opens to verify the post: from stored device credentials, else accountName. */
function deviceUsername(sessionData: string | null, accountName: string): string | undefined {
  let name: unknown;
  if (sessionData) {
    try { name = (JSON.parse(decrypt(sessionData)) as { username?: unknown }).username; } catch { /* fall back */ }
  }
  // The login can be an email or phone number — not a profile handle. Use the first
  // candidate that looks like a username, falling back to accountName.
  const valid = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const clean = v.replace(/^@+/, '').trim();
    return /^[\w.]{1,60}$/.test(clean) && !/^\+?\d{6,}$/.test(clean) ? clean : undefined;
  };
  return valid(name) ?? valid(accountName);
}

const logger = rootLogger.child({ worker: 'publish' });

/** A busy phone re-queues the job after this delay without burning an attempt. */
const DEVICE_BUSY_RETRY_MS = 90_000;

/**
 * Per-device publish lock. The value is a random owner token so a worker whose lock
 * already expired can never delete a lock that another worker acquired since.
 * Returns the token, or null if the device stayed busy for `waitMs`.
 */
export async function acquireDeviceLock(redis: Redis, deviceId: string, ttlSec: number, waitMs = 5_000): Promise<string | null> {
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

export async function releaseDeviceLock(redis: Redis, deviceId: string, owner: string): Promise<void> {
  await redis.eval(RELEASE_LOCK_LUA, 1, `lock:device:${deviceId}`, owner).catch(() => {});
}

/**
 * Failures that say nothing about the social account itself (our services, network,
 * storage, config). They must not lower the account's healthScore — otherwise a
 * publisher outage drives every account below the 30-point safety floor.
 */
const INFRA_ERROR_RE =
  /unreachable|did not answer in time|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|socket hang up|not configured|has no outputKey|has no outputUrl|NoSuchKey|cannot read stored session|занят|не подтверждена|ADBKeyboard|не распознан|не удалось дойти|отклонило видео|не установлено|не автоматизирована|прокси|утечк|шлюз|без сети|не удалось проверить установленные|disabled|health score too low|paused for safety|cancelled/i;

export function isInfrastructureError(message: string): boolean {
  return INFRA_ERROR_RE.test(message);
}

/** Errors raised before the request could reach the service — nothing was posted, safe to retry. */
const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * True when a long publish call failed after the request was sent and we never got an
 * answer (timeout, dropped connection, the service crashing mid-flow): the post may be live.
 * `serverErrorsUnknown` also counts 5xx — the device-agent answers handled failures with a
 * structured result, so a 5xx from it means it died somewhere inside the flow.
 */
export function isOutcomeUnknown(err: unknown, serverErrorsUnknown: boolean): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response) return serverErrorsUnknown && err.response.status >= 500;
  return !PRE_CONNECT_CODES.has(err.code ?? '');
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
      ? { status: 'published', publishedAt: outcome.at, error: null }
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

/** Idempotent success bookkeeping (M5): preserves dailyPostCount, lastPostAt, verifiedAt and healthScore. */
export async function finalizePublishSuccess(
  db: PrismaClient,
  publishJobId: string,
  socialAccountId: string,
  data: {
    externalPostId?: string | null;
    verifiedAt?: Date | null;
    publishNote?: string | null;
  }
): Promise<void> {
  const now = new Date();
  await db.publishJob.update({
    where: { id: publishJobId },
    data: {
      status: 'published',
      publishedAt: now,
      externalPostId: data.externalPostId,
      verifiedAt: data.verifiedAt,
      error: data.publishNote,
    },
  }).catch(() => {});

  await db.socialAccount.update({
    where: { id: socialAccountId },
    data: {
      dailyPostCount: { increment: 1 },
      lastPostAt: now,
      healthScore: { increment: 5 },
    },
  }).catch(() => {});

  await db.socialAccount.updateMany({
    where: { id: socialAccountId, healthScore: { gt: 100 } },
    data: { healthScore: 100 },
  }).catch(() => {});

  await settleDistributeItem(db, publishJobId, { status: 'published', at: now }).catch(() => {});
}

async function setAutopilotLiveProgress(
  redis: any,
  autopilotId: string | null | undefined,
  progress: {
    deviceId?: string;
    accountName?: string;
    platform?: string;
    step: string;
    detail?: string;
    percent?: number;
    stage?: string;
  }
) {
  if (!autopilotId || !redis) return;
  try {
    const payload = JSON.stringify({
      ...progress,
      updatedAt: Date.now(),
    });
    if (progress.deviceId) {
      await redis.hset(`autopilot:live:${autopilotId}`, progress.deviceId, payload);
      await redis.expire(`autopilot:live:${autopilotId}`, 180);
    }
    await redis.set(`autopilot:live:${autopilotId}`, payload, 'EX', 180);
  } catch {
    // Redis write failure shouldn't kill worker
  }
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
      // Every handled exit resets 'uploading' (pending/failed/published), so seeing it here
      // means the previous run died mid-upload (crash, SIGKILL, stalled job). The post may
      // already be live — re-running could publish it twice.
      if (existing.status === 'uploading') {
        const msg = 'Публикация прервана перезапуском во время загрузки и не подтверждена — проверьте профиль вручную';
        logger.error({ publishJobId, platform }, 'Publish: found in uploading state on entry, not re-running');
        await finalizePublishFailure(db, publishJobId, msg);
        return;
      }

      let accountName = socialAccountId;
      /** Set the moment the platform accepted the post — from then on, never retry. */
      let posted = false;
      let externalPostId: string | undefined;
      /** Set when the post was found on the account's profile (device path). */
      let verifiedAt: Date | null = null;
      /** Non-fatal remark from the publisher, kept in PublishJob.error of a published job. */
      let publishNote: string | null = null;

      // Check early if linked distribution was cancelled before changing statuses
      const linkedDistItem = await db.distributeItem.findFirst({
        where: { publishJobId },
        select: { id: true, distributeJobId: true, distributeJob: { select: { status: true, autopilotId: true } } },
      });
      const autopilotId = linkedDistItem?.distributeJob?.autopilotId ?? null;
      if (linkedDistItem?.distributeJob?.status === 'cancelled') {
        logger.info({ publishJobId, distributeJobId: linkedDistItem.distributeJobId }, 'Publish: distribution cancelled, aborting');
        await finalizePublishFailure(db, publishJobId, 'Distribution cancelled');
        return;
      }

      // Mark as uploading
      await db.publishJob.update({
        where: { id: publishJobId },
        data: { status: 'uploading' },
      });
      await db.distributeItem.updateMany({
        where: { publishJobId, status: { in: ['pending', 'scheduled'] } },
        data: { status: 'publishing' },
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
          throw new UnrecoverableError(`Social account ${socialAccountId} is disabled`);
        }
        if ((accountRaw.healthScore ?? 100) < 30) {
          throw new UnrecoverableError(`Social account ${socialAccountId} health score too low (${accountRaw.healthScore}) — paused for safety`);
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
            if (isOutcomeUnknown(err, false)) {
              throw new UnrecoverableError(`publisher-${platform}: ${describePublisherError(err)}. Публикация не подтверждена — проверьте профиль вручную`);
            }
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
          await setAutopilotLiveProgress(redis, autopilotId, {
            deviceId: accountRaw.deviceId,
            accountName,
            platform,
            step: 'Ожидание очереди стойки плат...',
            percent: 5,
          });
          // TTL covers the whole agent call (incl. waiting for the shared farm proxy) plus margin.
          const lockOwner = await acquireDeviceLock(redis, accountRaw.deviceId, Math.ceil(DEVICE_PUBLISH_TIMEOUT_MS / 1000) + 300);
          if (!lockOwner) {
            // A busy phone is not the account's fault: re-queue later without consuming an
            // attempt or touching healthScore, and free this worker slot meanwhile.
            await db.publishJob.update({
              where: { id: publishJobId },
              data: { status: 'pending', error: `Телефон ${accountRaw.deviceId} занят — повтор через ~${Math.round(DEVICE_BUSY_RETRY_MS / 1000)} с` },
            });
            await db.distributeItem.updateMany({
              where: { publishJobId },
              data: { status: 'scheduled', error: `Телефон занят — повтор через ~${Math.round(DEVICE_BUSY_RETRY_MS / 1000)} с` },
            });
            await job.moveToDelayed(Date.now() + DEVICE_BUSY_RETRY_MS, token);
            throw new DelayedError();
          }

          // Detect farm proxy mode (shared_sequential vs private_parallel)
          let proxyMode: 'shared_sequential' | 'private_parallel' = 'shared_sequential';
          try {
            const modeState = await deviceAgentService.getProxyMode();
            if (modeState?.mode) {
              proxyMode = modeState.mode;
            }
          } catch {
            // Keep default shared_sequential for traffic safety
          }

          let farmProxyLockOwner: string | null = null;
          if (proxyMode === 'shared_sequential') {
            await setAutopilotLiveProgress(redis, autopilotId, {
              deviceId: accountRaw.deviceId,
              accountName,
              platform,
              step: 'Ожидание общего модема стойки AstroProxy...',
              percent: 8,
            });
            // Shared farm proxy lock: serializes posts across phones to save expensive AstroProxy traffic
            // Wait up to 150 seconds for previous phone to finish upload & release proxy lock
            farmProxyLockOwner = await acquireDeviceLock(redis, 'farm:shared-proxy', Math.ceil(DEVICE_PUBLISH_TIMEOUT_MS / 1000) + 60, 150_000);
            if (!farmProxyLockOwner) {
  
              await releaseDeviceLock(redis, accountRaw.deviceId, lockOwner);
              await db.publishJob.update({
                where: { id: publishJobId },
                data: { status: 'pending', error: `Общий прокси фермы занят другой платой — повтор через ~60 с` },
              });
              await db.distributeItem.updateMany({
                where: { publishJobId },
                data: { status: 'scheduled', error: 'Общий прокси фермы занят другой платой — повтор через ~60 с' },
              });
              await job.moveToDelayed(Date.now() + 60_000, token);
              throw new DelayedError();
            }

            // In shared mode: move proxy to target device
            logger.info({ deviceId: accountRaw.deviceId, platform }, 'Publish: переключение общего прокси фермы на целевую плату...');
            await setAutopilotLiveProgress(redis, autopilotId, {
              deviceId: accountRaw.deviceId,
              accountName,
              platform,
              step: 'Переключение мобильного модема AstroProxy на целевую плату...',
              percent: 10,
            });
            try {
              await deviceAgentService.switchActiveDevice(accountRaw.deviceId, true);
            } catch (switchErr) {
              logger.warn({ err: String(switchErr), deviceId: accountRaw.deviceId }, 'Publish: предупреждение switchActiveDevice');
            }

            // In shared mode: rotate IP so account receives a clean mobile IP before posting
            logger.info({ deviceId: accountRaw.deviceId, platform }, 'Publish: ротация IP AstroProxy для платы перед публикацией...');
            await setAutopilotLiveProgress(redis, autopilotId, {
              deviceId: accountRaw.deviceId,
              accountName,
              platform,
              step: 'Ротация мобильного IP через AstroProxy...',
              percent: 12,
            });
            try {
              const rot = await rotateIpForFarmDevice(db, accountRaw.deviceId, accountRaw.proxyUrl);
              if (rot.newIp) {
                logger.info({ deviceId: accountRaw.deviceId, newIp: rot.newIp }, 'Publish: получен свежий IP AstroProxy для платы');
              }
            } catch (rotErr) {
              logger.warn({ err: String(rotErr), deviceId: accountRaw.deviceId }, 'Publish: ротация IP вернула предупреждение, продолжаем с текущим IP');
            }
          } else {
            logger.info({ deviceId: accountRaw.deviceId, platform }, 'Publish: режим Private Parallel — параллельная публикация без блокировки стойки');
          }

          let result: DevicePublishResult;
          let pollInterval: NodeJS.Timeout | null = null;
          if (autopilotId && accountRaw.deviceId) {
            pollInterval = setInterval(async () => {
              try {
                const prog = await deviceAgentService.getPublishProgress(accountRaw.deviceId!);
                if (prog) {
                  await setAutopilotLiveProgress(redis, autopilotId, {
                    deviceId: accountRaw.deviceId!,
                    accountName,
                    platform,
                    step: prog.step,
                    detail: prog.detail,
                    percent: prog.percent,
                    stage: prog.stage,
                  });
                }
              } catch {
                // ignore
              }
            }, 1500);
          }

          try {
            result = await deviceAgentService.publish({
              deviceId: accountRaw.deviceId,
              platform,
              videoUrl: presignedUrl,
              caption: fullCaption,
              username: deviceUsername(accountRaw.sessionData, accountRaw.accountName),
              claudehubApiKey: config.CLAUDEHUB_API_KEY || undefined,
              aiModel: config.CLAUDEHUB_VISION_MODEL || 'gemini-flash-3.8',
            });
          } catch (err: unknown) {
            const msg = describeDeviceAgentError(err);
            // If the shared proxy or lease queue was busy, delay and re-queue without burning attempts
            if (/общий прокси занят/i.test(msg) || /занят задачей/i.test(msg) || /превышено время ожидания очереди/i.test(msg)) {
              await db.publishJob.update({
                where: { id: publishJobId },
                data: { status: 'pending', error: `Общий прокси занят — повтор через ~${Math.round(DEVICE_BUSY_RETRY_MS / 1000)} с` },
              });
              await job.moveToDelayed(Date.now() + DEVICE_BUSY_RETRY_MS, token);
              throw new DelayedError();
            }
            // Transport failure. A timeout means the agent may still be mid-upload → not safe to retry.
            if (/did not answer in time/i.test(msg) || isOutcomeUnknown(err, true)) {
              throw new UnrecoverableError(`device-${platform}: ${msg}. Публикация не подтверждена — проверьте профиль вручную`);
            }
            throw new Error(`device-${platform}: ${msg}`);
          } finally {
            if (pollInterval) clearInterval(pollInterval);
            if (farmProxyLockOwner) await releaseDeviceLock(redis, 'farm:shared-proxy', farmProxyLockOwner);
            await releaseDeviceLock(redis, accountRaw.deviceId, lockOwner);
          }

          if (!result.ok) {
            await setAutopilotLiveProgress(redis, autopilotId, {
              deviceId: accountRaw.deviceId,
              accountName,
              platform,
              step: `Ошибка публикации: ${result.detail ?? 'не подтверждено'}`,
              percent: 0,
              stage: 'failed',
            });
            const where = result.debugSnapshot ? ` [снимок экрана: ${result.debugSnapshot}]` : '';
            const msg = `device-${platform}: ${result.detail ?? 'device-agent reported failure'}${where}`;
            // Share was tapped but the post was not confirmed → never retry (could post twice).
            if (result.posted === 'unknown') throw new UnrecoverableError(`${msg} (публикация не подтверждена)`);
            if (result.retryable === false) throw new UnrecoverableError(msg);
            throw new Error(msg);
          }
          posted = true;
          await setAutopilotLiveProgress(redis, autopilotId, {
            deviceId: accountRaw.deviceId,
            accountName,
            platform,
            step: 'Публикация успешно завершена и подтверждена в профиле!',
            percent: 100,
            stage: 'done',
          });
          // The agent re-read the profile and found the new post.
          if (result.verified?.profile) verifiedAt = new Date();
          if (result.detail) publishNote = result.detail; // e.g. caption could not be checked
          if (result.exitIp) {
            logger.info({ deviceId: accountRaw.deviceId, platform, exitIp: result.exitIp, country: result.country }, 'Publish: phone upload confirmed with rotated proxy IP');
            publishNote = publishNote ? `${publishNote} (IP: ${result.exitIp})` : `Опубликовано с IP: ${result.exitIp}`;
          }
          // No external post id available from real-app UI automation.
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
        await finalizePublishSuccess(db, publishJobId, socialAccountId, {
          externalPostId,
          verifiedAt,
          publishNote,
        });

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
          await finalizePublishSuccess(db, publishJobId, socialAccountId, {
            externalPostId,
            verifiedAt,
            publishNote: `Опубликовано; ошибка учёта: ${errorMsg}`.slice(0, 2000),
          });
          return;
        }

        const maxAttempts = job.opts?.attempts ?? 1;
        // UnrecoverableError: BullMQ will not retry it regardless of attempts left.
        const isFinal = err instanceof UnrecoverableError || job.attemptsMade + 1 >= maxAttempts;
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
          const isRateLimit = /\b(rate_limit|rate.?limit|too_many_requests|status[:\s]+429|http\s*429|action.?block|spammer|spam)\b/i.test(errorMsg);
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
  if (hashtags && hashtags.length > 0) {
    const missing = hashtags
      .map((t) => t.replace(/^#+/, '').trim())
      .filter((t) => Boolean(t) && !caption?.toLowerCase().includes(`#${t.toLowerCase()}`))
      .map((t) => `#${t}`);
    if (missing.length > 0) {
      parts.push(missing.join(' '));
    }
  }
  return normalizeCaption(parts.join('\n\n'));
}
