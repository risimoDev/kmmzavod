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
import {
  writeScript, fishTts, firstSentence, paceFor, voiceGender, DEFAULT_VOICE_ID, SCRIPT_STYLES,
  type ScriptStyle, type CtaType,
} from '@kmmzavod/ai';
import { getLlm, getFishConfig, getPaceTable, recordPace } from '../lib/ai';
import { journal, failBatch } from '../autopilot/journal';

const logger = rootLogger.child({ worker: 'autopilot-produce' });

interface Deps {
  db: PrismaClient;
  storage: MinioStorageClient;
  editorAnalyzeQueue: Queue<EditorAnalyzeJobPayload>;
  connection: ConnectionOptions;
}

const STYLE_IDS = SCRIPT_STYLES.map((s) => s.id) as string[];

/** The montage needs a little tail after the last word so the CTA isn't clipped. */
const VOICE_TAIL_SEC = 0.8;

/** Stable positive int seed from a UUID (same batch ⇒ same storyboard on retry). */
function seedFromId(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 8), 16) % 1_000_000_007;
}

/**
 * Footage ranges used by this autopilot's recent montages, keyed by storage key,
 * so the editor deprioritises them and every new video looks new.
 */
async function usedRangesByKey(db: PrismaClient, autopilotId: string, exceptBatchId: string) {
  const prior = await db.autopilotBatch.findMany({
    where: { autopilotId, id: { not: exceptBatchId }, editProjectId: { not: null }, status: { not: 'failed' } },
    select: { editProjectId: true },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  const projectIds = prior.map((p) => p.editProjectId!).filter(Boolean);
  if (projectIds.length === 0) return {};
  const [sources, clips] = await Promise.all([
    db.editSource.findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, order: true, storageKey: true } }),
    db.editClip.findMany({ where: { projectId: { in: projectIds }, included: true }, select: { projectId: true, edl: true } }),
  ]);
  // src_idx in an EDL = index into that project's sources sorted by `order`.
  const keysByProject = new Map<string, string[]>();
  for (const pid of projectIds) {
    keysByProject.set(pid, sources.filter((s) => s.projectId === pid).sort((a, b) => a.order - b.order).map((s) => s.storageKey));
  }
  const out: Record<string, [number, number][]> = {};
  for (const c of clips) {
    const segs = ((c.edl ?? {}) as { segments?: { src_idx: number; start: number; end: number }[] }).segments ?? [];
    const keys = keysByProject.get(c.projectId) ?? [];
    for (const seg of segs) {
      const key = keys[seg.src_idx];
      if (!key) continue;
      const list = (out[key] ??= []);
      if (list.length < 200) list.push([Number(seg.start), Number(seg.end)]);
    }
  }
  return out;
}

export function createAutopilotProduceWorker(deps: Deps): Worker {
  const { db, storage, editorAnalyzeQueue, connection } = deps;

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
          .filter((s): s is ScriptStyle => STYLE_IDS.includes(s));
        const style: ScriptStyle = styles.length ? styles[seq % styles.length] : 'blogger';
        // Voice first: its gender drives grammar, its calibrated pace the length.
        const voiceId = ap.voiceIds.length ? ap.voiceIds[seq % ap.voiceIds.length] : DEFAULT_VOICE_ID;
        const speed = Number(ap.voiceSpeed) || 1.0;
        const paceTable = await getPaceTable();

        // Recent hooks of this autopilot — the next video must open differently.
        const recent = await db.autopilotBatch.findMany({
          where: { autopilotId: ap.id, id: { not: batchId }, script: { not: null } },
          select: { script: true },
          orderBy: { createdAt: 'desc' },
          take: 12,
        });

        // No template fallback: without a working LLM the batch fails loudly
        // instead of publishing a generic script to the farm.
        const script = await writeScript(await getLlm(), {
          product: ap.project.name,
          productInfo: ap.productInfo ?? ap.project.description ?? undefined,
          style,
          seconds: ap.targetSeconds,
          wps: paceFor(paceTable, voiceId, speed),
          narrator: voiceGender(voiceId),
          cta: { type: (ap.ctaType as CtaType) ?? 'article', word: ap.directWord ?? undefined },
          avoidHooks: recent.map((r) => firstSentence(r.script!)),
          captionsCount: Math.max(1, Math.min(batch.variantCount || 1, 30)),
          allowTemplate: false,
        });
        if (script.notes.length) {
          await journal(db, ap, 'info', `Сценарий: ${script.notes.join('; ')}`, { summary: { batchId, provider: script.provider, model: script.model } });
        }

        // ── 2. Voiceover ────────────────────────────────────────────────────
        const tts = await fishTts(await getFishConfig(), { text: script.script, voiceId, speed });
        const voiceoverKey = `tenants/${ap.tenantId}/autopilot/${ap.id}/${batchId}/voiceover.mp3`;
        await storage.uploadBuffer(voiceoverKey, tts.audio, { contentType: 'audio/mpeg' });
        await recordPace(voiceId, speed, tts.words, tts.durationSec);
        const voiceDuration = tts.durationSec > 0 ? tts.durationSec : ap.targetSeconds;

        // ── 3. Montage project ──────────────────────────────────────────────
        const bgmKey = ap.bgmKeys.length ? ap.bgmKeys[seq % ap.bgmKeys.length] : undefined;
        // Exact length: the editor fills the montage to this and fits it to the voice.
        const clipSeconds = Math.max(8, Math.round((voiceDuration + VOICE_TAIL_SEC) * 10) / 10);
        const excludeRanges = await usedRangesByKey(db, ap.id, batchId);
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
              // Variety: a per-batch seed + fragments earlier montages used.
              seed: seedFromId(batchId),
              pace: ap.pace,
              hookFirst: true,
              variantCount: 1,
              excludeRanges,
              voiceoverKey: voiceoverKey,
              voiceId,
              voiceoverText: script.script,
              productInfo: ap.productInfo ?? undefined,
              ...(bgmKey ? { bgmKey } : {}),
              generatedScript: script.script,
              scriptHook: script.hook,
              scriptTitle: script.title,
              socialCaptions: script.captions,
              aiModelUsed: `${script.provider}/${script.model}`,
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
            voiceoverKey: voiceoverKey,
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
