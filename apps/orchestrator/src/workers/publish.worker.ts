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
import { Worker, type ConnectionOptions } from 'bullmq';
import { QUEUES, type PublishJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { IStorageClient } from '@kmmzavod/storage';
import { TikTokClient } from '../clients/social/tiktok.client';
import { InstagramClient } from '../clients/social/instagram.client';
import { logger as rootLogger } from '../logger';

const logger = rootLogger.child({ worker: 'publish' });

interface Deps {
  db: PrismaClient;
  storage: IStorageClient;
  connection: ConnectionOptions;
  tiktokClientKey?: string;
  tiktokClientSecret?: string;
  instagramAppId?: string;
  instagramAppSecret?: string;
}

export function createPublishWorker(deps: Deps): Worker {
  const { db, storage, connection } = deps;

  const tiktok = deps.tiktokClientKey && deps.tiktokClientSecret
    ? new TikTokClient(deps.tiktokClientKey, deps.tiktokClientSecret)
    : null;
  const instagram = deps.instagramAppId && deps.instagramAppSecret
    ? new InstagramClient(deps.instagramAppId, deps.instagramAppSecret)
    : null;

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

      // Load social account
      const account = await db.socialAccount.findUniqueOrThrow({
        where: { id: socialAccountId },
      });

      if (!account.isActive) {
        throw new Error(`Social account ${socialAccountId} is disabled`);
      }

      // Load publish job for caption/hashtags + determine video storage key
      const publishJob = await db.publishJob.findUniqueOrThrow({
        where: { id: publishJobId },
        select: { caption: true, hashtags: true, variantId: true },
      });

      let storageKey: string;

      if (publishJob.variantId) {
        const variant = await db.videoVariant.findUniqueOrThrow({
          where: { id: publishJob.variantId },
          select: { outputKey: true },
        });
        storageKey = variant.outputKey;
      } else {
        const video = await db.video.findUniqueOrThrow({
          where: { id: videoId },
          select: { outputUrl: true },
        });
        if (!video.outputUrl) throw new Error(`Video ${videoId} has no outputUrl`);
        storageKey = video.outputUrl;
      }

      let externalPostId: string | undefined;

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
                  accessToken: result.newAccessToken,
                  refreshToken: result.newRefreshToken ?? account.refreshToken,
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

          const presignedUrl = await storage.presignedUrl(storageKey, 3600);
          const result = await instagram.uploadReel(
            account.accessToken,
            account.accountName,
            presignedUrl,
            publishJob.caption ?? '',
            publishJob.hashtags as string[] | undefined,
          );
          externalPostId = result.mediaId;
          break;
        }

        case 'youtube_shorts': {
          throw new Error('YouTube Shorts publishing not yet implemented');
        }

        default:
          throw new Error(`Unknown platform: ${platform}`);
      }

      // Mark as published
      await db.publishJob.update({
        where: { id: publishJobId },
        data: {
          status: 'published',
          publishedAt: new Date(),
          externalPostId,
        },
      });

      logger.info({ publishJobId, platform, externalPostId }, 'Publish: success');
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
