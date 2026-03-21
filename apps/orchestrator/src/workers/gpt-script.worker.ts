// GPT script worker — generates structured scene plan via GPTunnel (OpenAI-compatible)
// Output: N scene rows in DB + fan-out to heygen/runway/image queues

import { Worker, type Job } from 'bullmq';
import OpenAI from 'openai';
import { QUEUE_DEFS, type GptScriptJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { gptunnelCostUsd, creditsFromUsd } from '../lib/costs';
import { chargeCredits } from '../lib/credits';

interface SceneOutput {
  scene_index: number;
  type: 'avatar' | 'clip' | 'image' | 'text';
  script?: string;
  b_roll_prompt?: string;
  duration_sec: number;
}

interface GptOutput {
  title: string;
  scenes: SceneOutput[];
}

interface Deps {
  db:             PrismaClient;
  openai:         OpenAI;
  heygenQueue:    Queue;
  runwayQueue:    Queue;
  imageGenQueue:  Queue;
  connection:     ConnectionOptions;
}

const SYSTEM_PROMPT = `
You are an expert scriptwriter for short-form viral video content (TikTok/Reels/Shorts).
Generate a complete, structured video script as a JSON object.

Output schema:
{
  "title": "<compelling video title, max 80 chars>",
  "scenes": [
    {
      "scene_index": 0,
      "type": "avatar" | "clip" | "image" | "text",
      "script": "<natural spoken text — ONLY for avatar/text scenes>",
      "b_roll_prompt": "<detailed cinematic visual description — ONLY for clip/image scenes>",
      "duration_sec": 5
    }
  ]
}

Scene type selection rules:
- "avatar"  → introductions, key explanations, emotional moments, calls-to-action (40–60% of scenes)
- "clip"    → demonstrating processes, transitions, dynamic action (20–30%)
- "image"   → product showcase, statistics, comparisons, fact cards (10–20%)
- "text"    → title cards or credit sequences only (max 6 words in script)

Constraints:
- Return valid JSON only — no markdown, no code fences
- avatar/text scenes MUST have script; clip/image scenes MUST have b_roll_prompt
- duration_sec: 4–8 for avatar, 3–6 for clip/image, 2–4 for text
`;

export function createGptScriptWorker(deps: Deps): Worker {
  return new Worker<GptScriptJobPayload>(
    QUEUE_DEFS.GPT_SCRIPT.name,
    async (job: Job<GptScriptJobPayload>) => {
      const { jobId, tenantId, prompt, projectSettings } = job.data;
      const startMs = Date.now();

      await deps.db.jobEvent.create({
        data: { jobId, tenantId, stage: 'gpt-script', status: 'started' },
      });

      // ── Look up job for videoId ───────────────────────────────────────────
      const jobRow = await deps.db.job.findUniqueOrThrow({
        where:  { id: jobId },
        select: { videoId: true },
      });

      // ── Call OpenAI ───────────────────────────────────────────────────────
      const response = await deps.openai.chat.completions.create({
        model:           'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          {
            role:    'system',
            content: SYSTEM_PROMPT.trim() + `\n\nProject settings: ${JSON.stringify(projectSettings)}`,
          },
          { role: 'user', content: prompt },
        ],
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error('OpenAI returned empty content');

      const output: GptOutput = (() => {
        try { return JSON.parse(raw) as GptOutput; }
        catch { throw new Error(`OpenAI returned invalid JSON: ${raw.slice(0, 200)}`); }
      })();

      if (!Array.isArray(output.scenes) || output.scenes.length === 0) {
        throw new Error('OpenAI: scenes array is empty or missing');
      }

      // ── Track cost ───────────────────────────────────────────────────────
      const usage       = response.usage!;
      const costUsd     = gptunnelCostUsd(usage.prompt_tokens, usage.completion_tokens);
      const credits     = creditsFromUsd(costUsd);
      const latencyMs   = Date.now() - startMs;

      await deps.db.generation.create({
        data: {
          tenantId,
          jobId,
          provider:          'gptunnel',
          model:             'gpt-4o',
          status:            'completed',
          promptTokens:      usage.prompt_tokens,
          completionTokens:  usage.completion_tokens,
          requestPayload:    { prompt, projectSettings },
          responsePayload:   { title: output.title, sceneCount: output.scenes.length },
          costUsd,
          creditsCharged:    credits,
          latencyMs,
          startedAt:         new Date(startMs),
          completedAt:       new Date(),
        },
      });

      await chargeCredits(deps.db, { tenantId, jobId, credits, description: 'GPTunnel script generation' });

      // ── Persist scenes ────────────────────────────────────────────────────
      await deps.db.$transaction(
        output.scenes.map((s) =>
          deps.db.scene.create({
            data: {
              jobId,
              videoId:     jobRow.videoId ?? undefined,
              tenantId,
              sceneIndex:  s.scene_index,
              type:        s.type,
              script:      s.script      ?? null,
              bRollPrompt: s.b_roll_prompt ?? null,
              durationSec: s.duration_sec,
            },
          })
        )
      );

      // ── Update job + video title ──────────────────────────────────────────
      await deps.db.job.update({ where: { id: jobId }, data: { status: 'scenes_ready' } });

      if (jobRow.videoId && output.title) {
        await deps.db.video.update({
          where: { id: jobRow.videoId },
          data:  { title: output.title },
        });
      }

      // ── Fan-out to per-scene provider queues ──────────────────────────────
      const scenes     = await deps.db.scene.findMany({ where: { jobId } });
      const avatarId   = (projectSettings['avatar_id'] as string | undefined) ?? 'default';
      const voiceId    = (projectSettings['voice_id']  as string | undefined) ?? 'default';

      for (const scene of scenes) {
        if (scene.type === 'avatar' && scene.script) {
          await deps.heygenQueue.add(
            `heygen:${scene.id}`,
            { jobId, sceneId: scene.id, tenantId, avatarId, voiceId, script: scene.script },
            QUEUE_DEFS.HEYGEN_RENDER.defaultJobOptions,
          );
        } else if (scene.type === 'clip' && scene.bRollPrompt) {
          await deps.runwayQueue.add(
            `runway:${scene.id}`,
            { jobId, sceneId: scene.id, tenantId, prompt: scene.bRollPrompt, durationSec: Number(scene.durationSec ?? 5) },
            QUEUE_DEFS.RUNWAY_CLIP.defaultJobOptions,
          );
        } else if (scene.type === 'image' && scene.bRollPrompt) {
          await deps.imageGenQueue.add(
            `imggen:${scene.id}`,
            { jobId, sceneId: scene.id, tenantId, prompt: scene.bRollPrompt, referenceImageKeys: [] },
            QUEUE_DEFS.IMAGE_GEN.defaultJobOptions,
          );
        }
        // text scenes: no external generation needed — handled at compose time
      }

      await deps.db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'gpt-script',
          status:  'completed',
          message: `${scenes.length} scenes created — $${costUsd.toFixed(4)}`,
          meta:    { sceneCount: scenes.length, costUsd, creditsCharged: credits },
        },
      });
    },
    {
      connection:  deps.connection,
      concurrency: QUEUE_DEFS.GPT_SCRIPT.concurrency,
    }
  );
}
