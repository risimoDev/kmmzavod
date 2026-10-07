/**
 * Autopilot-produce worker — first stage of one AutopilotBatch.
 *
 *   1. Fresh AI script for this montage (OpenRouter, rotating delivery styles)
 *      + one caption/hashtag set per future unique variant.
 *   2. Voiceover (Fish Audio, rotating voices) → exact MP3 duration.
 *   3. EditProject (smart_montage · mix · replace audio · 1 clip sized to the
 *      voiceover) with the batch's pre-selected project sources → editor-analyze.
 *
 * Everything after analyze (auto-confirm storyboard → render → uniquify) is
 * advanced by the scheduler loop (autopilot/loop.ts) by polling entity status,
 * so a lost event or a restarted container never strands a batch.
 */
import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { QUEUES, type AutopilotProducePayload, type EditorAnalyzeJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { MinioStorageClient } from '@kmmzavod/storage';
import { logger as rootLogger } from '../logger';
import { OpenRouterService, type ScriptStyle } from '../services/openrouter';
import { FishAudioService, DEFAULT_FISH_VOICE_ID } from '../services/fish-audio';
import { getAiKey } from '../lib/ai-keys';
import { journal, failBatch } from '../autopilot/journal';

const logger = rootLogger.child({ worker: 'autopilot-produce' });

interface Deps {
  db: PrismaClient;
  storage: MinioStorageClient;
  editorAnalyzeQueue: Queue<EditorAnalyzeJobPayload>;
  connection: ConnectionOptions;
}

const SCRIPT_STYLES: ScriptStyle[] = ['blogger', 'story', 'review', 'hype', 'educational', 'sales', 'humor', 'minimal'];

/** The montage needs a little tail after the last word so the CTA isn't clipped. */
const VOICE_TAIL_SEC = 0.8;

export function createAutopilotProduceWorker(deps: Deps): Worker {
  const { db, storage, editorAnalyzeQueue, connection } = deps;
  const openRouter = new OpenRouterService();
  const fish = new FishAudioService(storage);

  return new Worker<AutopilotProducePayload>(
    QUEUES['autopilot-produce'].name,
    async (job) => {
      const { batchId } = job.data;
      const batch = await db.autopilotBatch.findUnique({
        where: { id: batchId },
        include: { autopilot: { include: { project: { select: { id: true, name: true, description: true } } } } },
      });
      if (!batch) return;
      // Idempotent: only pending/scripting batches are produced here (a retry
      // after the EditProject was created must not create a second one).
      if (batch.status !== 'pending' && batch.status !== 'scripting') return;
      if (batch.editProjectId) return;

      const ap = batch.autopilot;
      await db.autopilotBatch.update({
        where: { id: batchId },
        data: { status: 'scripting', stageStartedAt: new Date() },
      });

      try {
        const sources = await db.sourceVideo.findMany({
          where: { id: { in: batch.sourceVideoIds }, tenantId: ap.tenantId },
          select: { id: true, storageKey: true, title: true },
        });
        // Keep the batch's chosen order (freshest first).
        const ordered = batch.sourceVideoIds
          .map((id) => sources.find((s) => s.id === id))
          .filter((s): s is NonNullable<typeof s> => Boolean(s?.storageKey));
        if (ordered.length === 0) throw new Error('Исходники батча удалены или недоступны');

        // ── 1. Script ───────────────────────────────────────────────────────
        // Sequence number of this batch → deterministic rotation of styles/voices/music.
        const seq = await db.autopilotBatch.count({
          where: { autopilotId: ap.id, createdAt: { lt: batch.createdAt } },
        });
        const styles = (ap.scriptStyles.length ? ap.scriptStyles : ['blogger'])
          .filter((s): s is ScriptStyle => (SCRIPT_STYLES as string[]).includes(s));
        const style: ScriptStyle = styles.length ? styles[seq % styles.length] : 'blogger';

        const openRouterKey = await getAiKey(db, 'OPENROUTER_API_KEY');
        const script = await openRouter.generateScript({
          topic: ap.project.name,
          projectName: ap.project.name,
          productInfo: ap.productInfo ?? ap.project.description ?? '',
          style,
          targetSeconds: ap.targetSeconds,
          ctaType: (ap.ctaType as 'article' | 'direct' | 'auto') ?? 'article',
          directWord: ap.directWord ?? undefined,
          language: 'ru',
          variantCount: Math.max(1, Math.min(batch.variantCount || 1, 30)),
          apiKey: openRouterKey,
        });
        if (!script.script?.trim()) throw new Error('Пустой сценарий от OpenRouter');
        if (script.modelUsed.startsWith('mock')) {
          await journal(db, ap, 'info',
            'OpenRouter недоступен или ключ не задан — использован шаблонный сценарий. Задайте ключ в Админ → Настройки (OPENROUTER_API_KEY).',
            { summary: { batchId, modelUsed: script.modelUsed } });
        }

        // ── 2. Voiceover ────────────────────────────────────────────────────
        const voiceId = ap.voiceIds.length ? ap.voiceIds[seq % ap.voiceIds.length] : DEFAULT_FISH_VOICE_ID;
        const fishKey = await getAiKey(db, 'FISH_AUDIO_API_KEY');
        const tts = await fish.ttsCreate({
          text: script.script,
          voiceId,
          speed: Number(ap.voiceSpeed) || 1.0,
          tenantId: ap.tenantId,
          destinationKey: `tenants/${ap.tenantId}/autopilot/${ap.id}/${batchId}/voiceover.mp3`,
          apiKey: fishKey,
        });
        const voiceDuration = tts.durationSec > 0 ? tts.durationSec : ap.targetSeconds;

        // ── 3. Montage project ──────────────────────────────────────────────
        const bgmKey = ap.bgmKeys.length ? ap.bgmKeys[seq % ap.bgmKeys.length] : undefined;
        const clipSeconds = Math.max(8, Math.ceil(voiceDuration + VOICE_TAIL_SEC));
        const project = await db.editProject.create({
          data: {
            tenantId: ap.tenantId,
            name: `${ap.name} · автопилот #${seq + 1}`,
            mode: 'smart_montage',
            geometry: 'mix',
            aspect: ap.aspect,
            fps: 30,
            smartCrop: ap.smartCrop,
            audioMode: 'replace',
            subtitleStyle: ap.subtitleStyle,
            useVision: false,
            targetClipCount: 1,
            targetClipSeconds: clipSeconds,
            config: {
              autopilotId: ap.id,
              autopilotBatchId: batchId,
              voiceoverKey: tts.storageKey,
              voiceId,
              voiceoverText: script.script,
              productInfo: ap.productInfo ?? undefined,
              ...(bgmKey ? { bgmKey } : {}),
              generatedScript: script.script,
              scriptHook: script.hook,
              scriptTitle: script.title,
              socialCaptions: script.captions,
              aiModelUsed: script.modelUsed,
            } as object,
            sources: {
              create: ordered.map((s, order) => ({ storageKey: s.storageKey, order })),
            },
          },
        });

        await db.autopilotBatch.update({
          where: { id: batchId },
          data: {
            status: 'analyzing',
            stageStartedAt: new Date(),
            editProjectId: project.id,
            script: script.script,
            scriptStyle: style,
            caption: script.captions?.[0]?.caption ?? script.title ?? null,
            voiceId,
            voiceoverKey: tts.storageKey,
            voiceDuration,
          },
        });
        await editorAnalyzeQueue.add(
          `autopilot-analyze-${project.id}`,
          { projectId: project.id, tenantId: ap.tenantId },
          QUEUES['editor-analyze'].defaultJobOptions as any,
        );

        await journal(db, ap, 'produce', `Монтаж #${seq + 1}: сценарий «${style}», озвучка ${voiceDuration.toFixed(1)}с, исходников ${ordered.length}`, {
          summary: { batchId, editProjectId: project.id, style, voiceId, voiceDuration, sources: ordered.map((s) => s.title) },
        });
        logger.info({ batchId, autopilotId: ap.id, editProjectId: project.id, voiceDuration }, 'Autopilot: montage project created');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ batchId, err: msg }, 'Autopilot: produce failed');
        // Retry transient errors once (BullMQ attempts); on the final attempt fail the batch.
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (final) {
          await failBatch(db, batchId, `Сценарий/озвучка: ${msg}`);
          return;
        }
        await db.autopilotBatch.update({ where: { id: batchId }, data: { status: 'pending' } }).catch(() => {});
        throw err;
      }
    },
    { connection, concurrency: QUEUES['autopilot-produce'].concurrency },
  );
}
