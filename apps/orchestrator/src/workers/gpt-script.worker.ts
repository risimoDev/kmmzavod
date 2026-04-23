// GPT script worker — generates UNIQUE idea + structured scene plan via GPTunnel (OpenAI-compatible)
// Two-step process:
//   Step 1: Generate unique creative IDEA (with dedup check against preset.usedIdeaHashes)
//   Step 2: Generate full SCRIPT from the approved idea
// Fan-out: clip scenes → image-gen (purpose=runway-frame) → runway-clip (chained)

import { Worker, type Job } from 'bullmq';
import OpenAI from 'openai';
import { createHash } from 'crypto';
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
  social_metadata?: {
    description: string;
    hashtags: string[];
  };
}

interface IdeaOutput {
  idea: string;
  hook_technique: string;
  creative_angle: string;
}

interface Deps {
  db:             PrismaClient;
  openai:         OpenAI;
  heygenQueue:    Queue;
  runwayQueue:    Queue;
  imageGenQueue:  Queue;
  connection:     ConnectionOptions;
}

/** Hash an idea string for dedup comparison */
function hashIdea(idea: string): string {
  return createHash('sha256').update(idea.toLowerCase().trim()).digest('hex').slice(0, 16);
}

const IDEA_SYSTEM_PROMPT = `
You are a top-tier Russian-language creative director for short-form viral video (TikTok/Reels/Shorts).
Your job: generate ONE unique creative idea/concept for a product advertisement video.

REQUIREMENTS:
- The idea must be HIGHLY SPECIFIC and ORIGINAL — not a generic "show the product".
- Include: creative_angle (1 line), hook_technique (which hook pattern to use), idea (3-5 sentences describing the full creative concept).
- The concept must naturally showcase the product's benefits while entertaining the viewer.
- Think like a top TikTok creator, not an ad agency.

RESPONSE FORMAT (JSON only, no markdown):
{
  "creative_angle": "<краткий угол подачи, 5-10 слов>",
  "hook_technique": "<тип хука: провокация/шок-факт/личная_история/запрет/загадка/вызов/боль/контринтуитив>",
  "idea": "<Полное описание идеи на русском: что происходит, какая история, какой поворот, какая эмоция. 3-5 предложений.>"
}

ANTI-REPEAT: The following creative angles have ALREADY been used. You MUST create something COMPLETELY DIFFERENT:
{{USED_IDEAS}}

VARIETY SEED: {{SEED}}
`;

const SCRIPT_SYSTEM_PROMPT = `
You are a top-tier Russian-language copywriter and visual director for short-form viral video (TikTok/Reels/Shorts). You write scripts that sound like a real person sharing a discovery with a friend, NOT like an ad agency.

━━━━━━━━━━━━━━━━━━━━━━━━━━
CREATIVE BRIEF
━━━━━━━━━━━━━━━━━━━━━━━━━━
You MUST follow this pre-approved creative idea EXACTLY:
{{IDEA}}

━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — PRODUCT VISUAL ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━
Analyze every attached product image. Extract PRODUCT_VISUAL_PROFILE:
  • Dominant colors, shape, material, texture, packaging, logo, distinctive features.
Reference in every b_roll_prompt.

━━━━━━━━━━━━━━━━━━━━━━━━━━
SCENE NARRATIVE ARC (STRICT)
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. HOOK (scene 0, avatar/text, 3-5 sec) — the MOST CRITICAL moment. Pattern interrupt.
   Use the hook technique specified in the creative brief.
   Product MUST be mentioned in first 3 seconds.

2. PRODUCT REVEAL (scene 1, clip/image) — cinematic hero shot.

3. BENEFITS (scenes 2-4, mix avatar + clip/image) — 2-3 concrete benefits.
   Avatar explains WHY, clip/image SHOWS proof.
   Цифры, сроки, сравнения: "через 7 дней морщины на 40% меньше", "в 3 раза экономичнее".
   Сенсорные детали: как пахнет, какая текстура, ощущения.

4. SOCIAL PROOF (avatar) — "50 000 клиентов", цитата, упоминание эксперта.

5. CTA (final, avatar) — "Ссылка в описании", "закажите сейчас — скидка только до пятницы".

━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT SCHEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "title": "<цепляющий заголовок, до 80 символов, эмодзи ОК>",
  "scenes": [
    {
      "scene_index": 0,
      "type": "avatar" | "clip" | "image" | "text",
      "script": "<текст речи — ТОЛЬКО для avatar/text>",
      "b_roll_prompt": "<промпт — ТОЛЬКО для clip/image>",
      "duration_sec": 5
    }
  ],
  "social_metadata": {
    "description": "<описание для соцсетей, 100-200 символов, живым языком, с CTA>",
    "hashtags": ["хештег1", "хештег2", "...", "максимум 15 хештегов"]
  }
}

━━━━━━━━━━━━━━━━━━━━━━━━━━
SCENE TYPE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━
- "avatar" (40–60%) — разговорная речь. Рубленые фразы 6-14 слов. Обращение "вы".
  Связки: "Смотрите...", "Вот в чём фишка...", "А знаете, что самое крутое?"
  Усилители: "реально", "честно", "послушайте", "обратите внимание".
  Паузы "..." для эмфазы. Риторические вопросы.
- "clip" (20–30%) — b_roll_prompt 50-80 words. ВСЕ 7 элементов:
  1. Shot type  2. Camera movement  3. Lighting  4. Product placement
  5. Background  6. Action  7. Technical quality (4K, shallow DOF)
  ВАЖНО: clip-сцены будут сгенерированы как кадр → анимация через Runway.
  Описывай ДВИЖЕНИЕ и АНИМАЦИЮ: "camera slowly orbits around",
  "zoom in revealing texture", "product rotates on turntable with light sweep",
  "water droplets splash around the product", "golden hour light shifts across surface".
- "image" (10–20%) — b_roll_prompt 30-50 words.
  Product appearance, composition, palette, mood.
- "text" (<5%) — max 6 words.

━━━━━━━━━━━━━━━━━━━━━━━━━━
СТИЛЬ И ЗАПРЕТЫ
━━━━━━━━━━━━━━━━━━━━━━━━━━
Write SPOKEN Russian, not written. As if talking to a friend on camera.

ГЕНДЕР СПИКЕРА: {{SPEAKER_GENDER}}
- Если женщина: женские формы глаголов ("я попробовала", "я нашла", "я была в шоке").
- Если мужчина: мужские формы ("я попробовал", "я нашёл", "я был в шоке").

ПРОИЗНОШЕНИЕ И УДАРЕНИЯ (КРИТИЧЕСКИ ВАЖНО):
- Пиши слова так, как они ПРОИЗНОСЯТСЯ в разговорной русской речи.
- НЕ ставь знаки ударения. TTS движок сам расставит ударения.
- Числа пиши СЛОВАМИ: "сто пятьдесят" вместо "150".
- Аббревиатуры раскрывай: "эс пэ эф" вместо "SPF".

ЗАПРЕЩЁННЫЕ СЛОВА (НИКОГДА):
  ✗ "уникальный", "инновационный", "революционный", "лучший на рынке"
  ✗ "не упустите шанс", "спешите", "торопитесь"
  ✗ "данный продукт", "представляем вашему вниманию"
  ✗ "в современном мире", "в наше время", "каждый знает", "не секрет что"
  ✗ any phrase that sounds like an ad catalog

ОБЯЗАТЕЛЬНЫЕ ПРИЁМЫ (use 2-3 per script):
  ✓ Метафора/сравнение: "кожа как у младенца", "работает как швейцарские часы"
  ✓ Мини-история: "моя подруга попробовала и..."
  ✓ Конкретный пример использования: "утром нанесли — до вечера держится"
  ✓ Неожиданный поворот: "но подождите — это ещё не всё"
  ✓ Числа: "7 дней", "40%", "3 раза", "500 рублей"

━━━━━━━━━━━━━━━━━━━━━━━━━━
HARD CONSTRAINTS
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Return VALID JSON ONLY — no markdown, no code fences
- avatar/text: "script"; clip/image: "b_roll_prompt"
- duration_sec: 4–8 avatar, 3–6 clip/image, 2–4 text
- EVERY b_roll_prompt: product name + 2 visual details from PRODUCT_VISUAL_PROFILE
- NEVER generic b-roll ("a person holds a product")
- clip b_roll_prompt: 50-80 words, all 7 elements

━━━━━━━━━━━━━━━━━━━━━━━━━━
САМОПРОВЕРКА
━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Хук останавливает палец? Вызывает эмоцию?
  ✓ Продукт назван в первые 3 сек?
  ✓ Выгоды = конкретные цифры, не прилагательные?
  ✓ Нет запрещённых слов?
  ✓ Текст звучит как живая речь, а не рекламный буклет?
  ✓ Есть минимум 2 приёма из ОБЯЗАТЕЛЬНЫХ?
  ✓ CTA чёткий?
  ✓ Каждый b_roll_prompt: имя + 2 детали?
  ✓ clip = 50-80 слов с 7 элементами?
Если нет — перепиши эту сцену.
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
      const { jobId, tenantId, prompt, projectSettings, productContext, presetId, usedIdeaHashes } = job.data;
      const startMs = Date.now();

      await deps.db.jobEvent.create({
        data: { jobId, tenantId, stage: 'gpt-script', status: 'started' },
      });

      const jobRow = await deps.db.job.findUniqueOrThrow({
        where:  { id: jobId },
        select: { videoId: true },
      });

      // ── Resolve speaker gender ─────────────────────────────────────────────
      const voiceIdForGender = (projectSettings as any)?.voice_id ?? '';
      const FEMALE_VOICE_IDS = [
        '70856236390f4d0392d00187143d3900',
        'bc69c9589d6747028dc5ec4aec2b43c3',
      ];
      const speakerGender = FEMALE_VOICE_IDS.includes(voiceIdForGender) ? 'Женщина' : 'Мужчина';
      const targetDuration = (projectSettings as any)?.durationSec ?? 30;

      // ══════════════════════════════════════════════════════════════════════
      // STEP 1: Generate unique IDEA (with dedup)
      // ══════════════════════════════════════════════════════════════════════
      const usedHashes = new Set(usedIdeaHashes ?? []);
      let approvedIdea: IdeaOutput | null = null;
      let ideaHash = '';
      let ideaTotalCostUsd = 0;
      let ideaTotalPromptTokens = 0;
      let ideaTotalCompletionTokens = 0;
      const MAX_IDEA_ATTEMPTS = 5;

      const productInfo = productContext
        ? `\nProduct: ${productContext.name}${productContext.description ? ` — ${productContext.description}` : ''}`
        : '';
      const userPromptNote = prompt && prompt.trim().length >= 5
        ? `\nUser direction: ${prompt}`
        : '\nUser gave NO specific direction — come up with a completely original concept.';

      for (let attempt = 0; attempt < MAX_IDEA_ATTEMPTS; attempt++) {
        const seed = Math.random().toString(36).slice(2, 10);
        const usedIdeasText = usedHashes.size > 0
          ? [...usedHashes].slice(-20).join(', ')
          : 'None yet — be the first!';

        const ideaSystem = IDEA_SYSTEM_PROMPT
          .replace('{{USED_IDEAS}}', usedIdeasText)
          .replace('{{SEED}}', seed);

        const ideaResponse = await deps.openai.chat.completions.create({
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
          temperature: 1.2,
          messages: [
            { role: 'system', content: ideaSystem + productInfo },
            { role: 'user', content: `Generate a unique creative idea for a ${targetDuration}-second product video.${userPromptNote}` },
          ],
        });

        const ideaRaw = ideaResponse.choices[0]?.message?.content;
        if (!ideaRaw) continue;

        const usage = ideaResponse.usage!;
        ideaTotalCostUsd += gptunnelCostUsd(usage.prompt_tokens, usage.completion_tokens);
        ideaTotalPromptTokens += usage.prompt_tokens;
        ideaTotalCompletionTokens += usage.completion_tokens;

        try {
          const parsed = JSON.parse(ideaRaw) as IdeaOutput;
          const h = hashIdea(parsed.idea);

          if (!usedHashes.has(h)) {
            approvedIdea = parsed;
            ideaHash = h;
            break;
          }
          // Duplicate — retry with new seed
        } catch {
          // Parse error — retry
        }
      }

      if (!approvedIdea) {
        throw new Error('Failed to generate unique idea after max attempts — all ideas duplicated');
      }

      // ── Track idea generation cost ─────────────────────────────────────────
      const ideaCredits = creditsFromUsd(ideaTotalCostUsd);
      await deps.db.generation.create({
        data: {
          tenantId, jobId,
          provider: 'gptunnel', model: 'gpt-4o', status: 'completed',
          promptTokens: ideaTotalPromptTokens,
          completionTokens: ideaTotalCompletionTokens,
          requestPayload: { step: 'idea', productName: productContext?.name },
          responsePayload: { idea: approvedIdea.idea, hash: ideaHash },
          costUsd: ideaTotalCostUsd,
          creditsCharged: ideaCredits,
          latencyMs: Date.now() - startMs,
          startedAt: new Date(startMs),
          completedAt: new Date(),
        },
      });
      await chargeCredits(deps.db, { tenantId, jobId, credits: ideaCredits, description: 'GPT idea generation' });
      await deps.db.job.update({ where: { id: jobId }, data: { creditsUsed: { increment: ideaCredits } } });

      // ── Save idea to video + update preset usedIdeaHashes ──────────────────
      if (jobRow.videoId) {
        await deps.db.video.update({
          where: { id: jobRow.videoId },
          data: { ideaText: approvedIdea.idea, ideaFingerprint: ideaHash },
        });
      }
      if (presetId) {
        await deps.db.videoPreset.update({
          where: { id: presetId },
          data: { usedIdeaHashes: { push: ideaHash } },
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // STEP 2: Generate SCRIPT from approved idea
      // ══════════════════════════════════════════════════════════════════════
      const scriptStartMs = Date.now();
      const hasProductImages = (productContext?.imageUrls?.length ?? 0) > 0;

      const ideaBlock = `Творческий угол: ${approvedIdea.creative_angle}\nТехника хука: ${approvedIdea.hook_technique}\nИдея: ${approvedIdea.idea}`;

      const videoFormat = (projectSettings as any)?.video_format ?? 'standard';
      const slideshowInstruction = videoFormat === 'slideshow'
        ? `\n\n━━━ ФОРМАТ: СЛАЙДШОУ ━━━\nСоздай видео БЕЗ АВАТАРА. Все сцены — type "image" (или "text"). type "avatar" ЗАПРЕЩЁН.\nДлительность сцен: 3-5 секунд каждая.`
        : '';

      const scriptSystem = SCRIPT_SYSTEM_PROMPT
        .replace('{{IDEA}}', ideaBlock)
        .replace('{{SPEAKER_GENDER}}', speakerGender)
        + (productContext ? buildProductSection(productContext) : '')
        + `\n\nProject settings: ${JSON.stringify(projectSettings)}`
        + `\nTarget video duration: ${targetDuration} seconds. Total scene durations must sum to ~${targetDuration}s.`
        + `\nIMPORTANT: HeyGen TTS speaks Russian at ~2 words per second. For an avatar scene of N seconds, write NO MORE than N*2 words.`
        + slideshowInstruction;

      const userMessage: OpenAI.Chat.Completions.ChatCompletionUserMessageParam = hasProductImages
        ? {
            role: 'user',
            content: [
              ...productContext!.imageUrls.slice(0, 3).map((url) => ({
                type: 'image_url' as const,
                image_url: { url, detail: 'high' as const },
              })),
              { type: 'text' as const, text: `Product: ${productContext!.name}\n\nWrite the full script following the creative brief above.` },
            ],
          }
        : { role: 'user', content: `Product: ${productContext?.name ?? 'неизвестный продукт'}.\n\nWrite the full script following the creative brief above.` };

      const response = await deps.openai.chat.completions.create({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        temperature: 1.0,
        messages: [
          { role: 'system', content: scriptSystem },
          userMessage,
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

      // ── Track script cost ──────────────────────────────────────────────────
      const usage       = response.usage!;
      const scriptCostUsd = gptunnelCostUsd(usage.prompt_tokens, usage.completion_tokens);
      const scriptCredits = creditsFromUsd(scriptCostUsd);
      const scriptLatencyMs = Date.now() - scriptStartMs;

      await deps.db.generation.create({
        data: {
          tenantId, jobId,
          provider: 'gptunnel', model: 'gpt-4o', status: 'completed',
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          requestPayload: { step: 'script', idea: approvedIdea.creative_angle },
          responsePayload: { title: output.title, sceneCount: output.scenes.length },
          costUsd: scriptCostUsd,
          creditsCharged: scriptCredits,
          latencyMs: scriptLatencyMs,
          startedAt: new Date(scriptStartMs),
          completedAt: new Date(),
        },
      });
      await chargeCredits(deps.db, { tenantId, jobId, credits: scriptCredits, description: 'GPT script generation' });
      await deps.db.job.update({ where: { id: jobId }, data: { creditsUsed: { increment: scriptCredits } } });

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

      await deps.db.job.update({ where: { id: jobId }, data: { status: 'scenes_ready' } });

      if (jobRow.videoId && output.title) {
        const socialMeta = output.social_metadata;
        await deps.db.video.update({
          where: { id: jobRow.videoId },
          data: {
            title: output.title,
            description: socialMeta?.description ?? null,
            metadata: {
              ...(await deps.db.video.findUnique({ where: { id: jobRow.videoId }, select: { metadata: true } }))?.metadata as Record<string, unknown> ?? {},
              socialMetadata: socialMeta
                ? { description: socialMeta.description, hashtags: socialMeta.hashtags }
                : undefined,
            },
          },
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // FAN-OUT: distribute scenes to provider queues
      // ══════════════════════════════════════════════════════════════════════
      const scenes     = await deps.db.scene.findMany({ where: { jobId } });
      const avatarId   = (projectSettings['avatar_id'] as string | undefined) ?? 'default';
      const voiceId    = (projectSettings['voice_id']  as string | undefined) ?? '70856236390f4d0392d00187143d3900';
      const productImageUrls = productContext?.imageUrls ?? [];

      for (const scene of scenes) {
        if (scene.type === 'avatar' && scene.script) {
          // Avatar scenes handled in combined batch below
        } else if (scene.type === 'clip' && scene.bRollPrompt) {
          // Clip → image-gen (purpose=runway-frame) → then image-gen chains to runway-clip
          await deps.imageGenQueue.add(
            `imggen-frame:${scene.id}`,
            {
              jobId, sceneId: scene.id, tenantId,
              prompt: scene.bRollPrompt,
              referenceImageKeys: productImageUrls,
              purpose: 'runway-frame',
              clipDurationSec: Number(scene.durationSec ?? 5),
            },
            QUEUE_DEFS.IMAGE_GEN.defaultJobOptions,
          );
        } else if (scene.type === 'image' && scene.bRollPrompt) {
          // Static image → image-gen (purpose=scene-image)
          await deps.imageGenQueue.add(
            `imggen:${scene.id}`,
            {
              jobId, sceneId: scene.id, tenantId,
              prompt: scene.bRollPrompt,
              referenceImageKeys: productImageUrls,
              purpose: 'scene-image',
            },
            QUEUE_DEFS.IMAGE_GEN.defaultJobOptions,
          );
        }
        // text scenes: no external generation needed
      }

      // ── Combined HeyGen: ONE video for ALL avatar scenes ──────────────────
      // This matches the admin test flow and is cheaper / faster than per-scene renders.
      const avatarScenes = scenes
        .filter(s => s.type === 'avatar' && s.script)
        .sort((a, b) => a.sceneIndex - b.sceneIndex);

      if (avatarScenes.length > 0) {
        // Concatenate all avatar scripts in scene order with natural pause separator
        const combinedScript = avatarScenes.map(s => s.script!).join(' ');

        await deps.heygenQueue.add(
          `heygen-combined-${jobId}`,
          {
            jobId,
            sceneId: avatarScenes[0].id,        // primary scene for logging
            tenantId, avatarId, voiceId,
            script: combinedScript,
            isCombined: true,
            combinedSceneIds: avatarScenes.map(s => s.id),
          },
          QUEUE_DEFS.HEYGEN_RENDER.defaultJobOptions,
        );
      }

      const totalCostUsd = ideaTotalCostUsd + scriptCostUsd;
      const totalCredits = ideaCredits + scriptCredits;

      await deps.db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'gpt-script',
          status:  'completed',
          message: `${scenes.length} scenes, idea: "${approvedIdea.creative_angle}" — $${totalCostUsd.toFixed(4)}`,
          meta:    { sceneCount: scenes.length, costUsd: totalCostUsd, creditsCharged: totalCredits, ideaHash },
        },
      });

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
