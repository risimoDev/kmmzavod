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
You are an expert scriptwriter and visual director for short-form viral video content (TikTok/Reels/Shorts) focused on PRODUCT advertising.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — PRODUCT VISUAL ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before writing any scene, carefully analyze every attached product image.
Extract and memorize these visual characteristics — you will use them in EVERY clip/image prompt:
  • Dominant colors and color palette
  • Shape & form factor (bottle, box, tube, gadget, clothing item, etc.)
  • Material & texture (matte plastic, glossy glass, brushed metal, fabric, etc.)
  • Approximate size (palm-sized, handheld, tabletop, wearable, etc.)
  • Packaging details (label design, brand logo placement, cap/lid style)
  • Distinctive features (LED indicator, transparent window, embossed lettering, etc.)
Store this as PRODUCT_VISUAL_PROFILE — reference it by name in every b_roll_prompt below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT SCHEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "title": "<compelling video title, max 80 chars>",
  "scenes": [
    {
      "scene_index": 0,
      "type": "avatar" | "clip" | "image" | "text",
      "script": "<spoken text — ONLY for avatar/text>",
      "b_roll_prompt": "<cinematic prompt — ONLY for clip/image>",
      "duration_sec": 5
    }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCENE TYPE SELECTION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "avatar"  → introductions, key explanations, emotional moments, calls-to-action (40–60% of scenes)
- "clip"    → demonstrating processes, transitions, dynamic action with the product (20–30%)
- "image"   → product showcase, statistics, comparisons, fact cards (10–20%)
- "text"    → title cards or credit sequences only (max 6 words in script)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"clip" SCENE b_roll_prompt REQUIREMENTS (50-80 words, MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every clip b_roll_prompt MUST include ALL of these elements:
1. Shot type: extreme close-up / medium shot / wide shot / over-the-shoulder
2. Camera movement: slow dolly in / tracking shot / static locked-off / crane rising / orbit 360°
3. Lighting setup: soft box diffused / golden hour side-light / studio white seamless / dramatic rim light / neon accent
4. Product placement: held in hand / placed on marble surface / in active use / floating center-frame
5. Background: blurred bokeh / clean studio white / lifestyle setting (kitchen, gym, desk) / gradient sweep
6. Action: person demonstrates [specific feature], product rotates 360° revealing [detail], hand opens packaging showing [element]
7. Technical quality: cinematic 4K, shallow depth of field, film grain, anamorphic lens flare

The product MUST be named explicitly: use the product name and describe its exact appearance from PRODUCT_VISUAL_PROFILE (color, shape, material, distinctive markings).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"image" SCENE b_roll_prompt REQUIREMENTS (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every image b_roll_prompt MUST include ALL of these elements:
1. Exact product appearance: describe the product using color, shape, material, and branding from PRODUCT_VISUAL_PROFILE
2. Composition style: flat lay / hero shot / lifestyle context / editorial minimal
3. Color palette: harmonize with brandVoice tone (warm/cool/vibrant/muted) — specify 2-3 hex or named colors
4. Text overlay instructions (if applicable): pricing, stats, comparison data — specify font style, position, size
5. Mood & style: photorealistic product photography / 3D render / illustrated infographic

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HARD CONSTRAINTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Return VALID JSON ONLY — no markdown, no code fences, no commentary
- avatar/text scenes MUST have "script"; clip/image scenes MUST have "b_roll_prompt"
- duration_sec: 4–8 for avatar, 3–6 for clip/image, 2–4 for text
- EVERY clip/image b_roll_prompt MUST contain the product name AND at least 2 visual details from PRODUCT_VISUAL_PROFILE (e.g. color + material, shape + texture)
- NEVER generate generic b-roll without explicit product reference (no "a person holds a product", no "item on table")
- clip b_roll_prompt must be 50-80 words — count them

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL SELF-CHECK (execute before returning JSON)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review every scene in your output. For each clip/image scene:
  ✓ Does b_roll_prompt mention the product by name?
  ✓ Does it include at least 2 specific visual details from the product analysis?
  ✓ For clips: is the word count between 50-80?
  ✓ For clips: are all 7 required elements present (shot, camera, lighting, placement, background, action, quality)?
  ✓ For images: are all 5 required elements present?
If any check fails — rewrite that scene's b_roll_prompt before returning.
`;

function buildProductSection(ctx: NonNullable<import('@kmmzavod/queue').ProductContext>): string {
  const lines: string[] = ['\n--- Product Information ---'];
  lines.push(`Product name: ${ctx.name}`);
  if (ctx.description)    lines.push(`Description: ${ctx.description}`);
  if (ctx.features.length) lines.push(`Key features: ${ctx.features.join('; ')}`);
  if (ctx.targetAudience) lines.push(`Target audience: ${ctx.targetAudience}`);
  if (ctx.brandVoice)     lines.push(`Brand voice / tone: ${ctx.brandVoice}`);
  if (ctx.imageUrls.length)
    lines.push(`Product images are attached — use them as reference for image/clip scene prompts.`);
  lines.push('--- End Product Information ---');
  return lines.join('\n');
}

export function createGptScriptWorker(deps: Deps): Worker {
  return new Worker<GptScriptJobPayload>(
    QUEUE_DEFS.GPT_SCRIPT.name,
    async (job: Job<GptScriptJobPayload>) => {
      const { jobId, tenantId, prompt, projectSettings, productContext } = job.data;
      const startMs = Date.now();

      await deps.db.jobEvent.create({
        data: { jobId, tenantId, stage: 'gpt-script', status: 'started' },
      });

      // ── Look up job for videoId ───────────────────────────────────────────
      const jobRow = await deps.db.job.findUniqueOrThrow({
        where:  { id: jobId },
        select: { videoId: true },
      });

      // ── Build messages with optional product vision ────────────────────────
      const systemContent = SYSTEM_PROMPT.trim()
        + (productContext ? buildProductSection(productContext) : '')
        + `\n\nProject settings: ${JSON.stringify(projectSettings)}`;

      const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        { type: 'text', text: prompt },
      ];

      if (productContext?.imageUrls?.length) {
        for (const url of productContext.imageUrls) {
          userContent.push({ type: 'image_url', image_url: { url, detail: 'low' } });
        }
      }

      // ── Call OpenAI ───────────────────────────────────────────────────────
      const response = await deps.openai.chat.completions.create({
        model:           'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user',   content: userContent },
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
          requestPayload:    { prompt, projectSettings: projectSettings as Record<string, string> },
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
            {
              jobId, sceneId: scene.id, tenantId,
              prompt: scene.bRollPrompt,
              referenceImageKeys: productContext?.imageUrls ?? [],
            },
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

      // Публикуем прогресс: скрипт готов, сцены созданы → 10%
      if (jobRow.videoId) {
        const { publishProgress } = await import('../lib/progress');
        await publishProgress(tenantId, jobRow.videoId, 'gpt-script', 'completed', 10, `${scenes.length} scenes created`);
      }
    },
    {
      connection:  deps.connection,
      concurrency: QUEUE_DEFS.GPT_SCRIPT.concurrency,
    }
  );
}
