import type { Prisma, PrismaClient } from '@kmmzavod/db';
import { addOrReplace, nextCronDate, type PipelineJobPayload } from '@kmmzavod/queue';
import type { Queue } from 'bullmq';
import { logger } from '../logger';

async function reserveJob(tx: Prisma.TransactionClient, video: Prisma.VideoUncheckedCreateInput, settings: Prisma.InputJsonObject, credits: number, scheduleId?: string) {
  const reserved = await tx.tenant.updateMany({
    where: { id: video.tenantId, isActive: true, credits: { gte: credits } },
    data: { credits: { decrement: credits } },
  });
  if (!reserved.count) return null;
  const row = await tx.video.create({ data: video });
  const job = await tx.job.create({ data: {
    tenantId: video.tenantId, videoId: row.id, status: 'pending',
    payload: { script_prompt: '', settings, estimatedCredits: credits, scheduleId },
  } });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: video.tenantId }, select: { credits: true } });
  await tx.creditTransaction.create({ data: {
    tenantId: video.tenantId, jobId: job.id, type: 'reserve', amount: -credits,
    balanceAfter: tenant.credits, description: `Reserve for scheduled video ${row.title}`,
  } });
  return job;
}

export async function runScheduledVideoJobs(db: PrismaClient, queue: Queue<PipelineJobPayload>, now: Date) {
  const [presets, schedules, creditSetting] = await Promise.all([
    db.videoPreset.findMany({ where: { status: 'active', nextRunAt: { lte: now } }, include: { product: { select: { name: true } } } }),
    db.videoSchedule.findMany({ where: { isActive: true, nextRunAt: { lte: now } } }),
    db.adminSetting.findUnique({ where: { key: 'avg_credits_per_scene' }, select: { value: true } }),
  ]);
  const raw = creditSetting?.value;
  const avg = Number(raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw);
  const credits = Number.isFinite(avg) && avg > 0 ? Math.ceil(avg * 5) : 75;

  for (const preset of presets) {
    const nextRunAt = preset.cronExpression ? nextCronDate(preset.cronExpression, preset.timezone, now) : null;
    const editStyle = preset.editStyle === 'random' ? ['dynamic', 'smooth', 'minimal'][Math.floor(Math.random() * 3)]! : preset.editStyle;
    try {
      const job = await db.$transaction(async tx => {
        const claimed = await tx.videoPreset.updateMany({
          where: { id: preset.id, status: 'active', nextRunAt: preset.nextRunAt },
          data: { nextRunAt },
        });
        if (!claimed.count || !preset.product) return null;
        const work = await reserveJob(tx, {
          tenantId: preset.tenantId, presetId: preset.id, productId: preset.productId,
          title: `${preset.product.name} — авто`, status: 'pending',
          metadata: { presetId: preset.id, autoPublish: preset.autoPublish, editStyle },
        }, {
          avatar_id: preset.heygenAvatarId, voice_id: preset.heygenVoiceId,
          durationSec: preset.targetDurationSec, bgm_enabled: true, editStyle,
        }, credits);
        if (work) await tx.videoPreset.update({
          where: { id: preset.id }, data: { lastRunAt: now, totalRuns: { increment: 1 } },
        });
        return work;
      });
      if (job) await enqueuePipeline(queue, job);
    } catch (err) {
      logger.error({ err, presetId: preset.id }, 'Scheduled preset could not start');
    }
  }

  for (const schedule of schedules) {
    const nextRunAt = nextCronDate(schedule.cronExpression, schedule.timezone, now);
    try {
      const job = await db.$transaction(async tx => {
        const claimed = await tx.videoSchedule.updateMany({
          where: { id: schedule.id, isActive: true, nextRunAt: schedule.nextRunAt },
          data: { nextRunAt, ...(!nextRunAt && { isActive: false }) },
        });
        if (!claimed.count || !nextRunAt) return null;
        const product = await tx.product.findFirst({
          where: { id: schedule.productId, tenantId: schedule.tenantId }, select: { name: true },
        });
        if (!product) return null;
        const work = await reserveJob(tx, {
          tenantId: schedule.tenantId, productId: schedule.productId,
          title: `${product.name} — ${schedule.name}`, status: 'pending',
        }, {
          avatar_id: schedule.avatarId, voice_id: schedule.voiceId,
          durationSec: schedule.durationSec, language: schedule.language, bgm_enabled: schedule.bgmEnabled,
        }, credits, schedule.id);
        if (work) await tx.videoSchedule.update({
          where: { id: schedule.id }, data: { lastRunAt: now, totalRuns: { increment: 1 } },
        });
        return work;
      });
      if (job) await enqueuePipeline(queue, job);
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'Scheduled video could not start');
    }
  }

  const pending = await db.job.findMany({
    where: {
      status: 'pending', updatedAt: { lt: new Date(now.getTime() - 60_000) },
      video: { status: 'pending' },
    },
    orderBy: { updatedAt: 'asc' },
    select: { id: true, tenantId: true },
    take: 100,
  });
  for (const job of pending) {
    const existing = await queue.getJob(job.id);
    if (!existing) await enqueuePipeline(queue, job);
  }
}

function enqueuePipeline(queue: Queue<PipelineJobPayload>, job: { id: string; tenantId: string }) {
  return addOrReplace(queue, `pipeline:${job.id}`, { jobId: job.id, tenantId: job.tenantId }, { jobId: job.id });
}
