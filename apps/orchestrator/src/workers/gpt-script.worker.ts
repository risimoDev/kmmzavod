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

/**
 * Strip optional markdown code fences (```json ... ```) before JSON.parse.
 * Claude models sometimes wrap JSON in fences even when instructed not to.
 */
function safeParseJson<T>(raw: string): T {
  const cleaned = raw.trim()
    .replace(/^```[a-z]*\r?\n?/m, '')
    .replace(/\r?\n?```\s*$/m, '')
    .trim();
  return JSON.parse(cleaned) as T;
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
Analyze every attached product image. Build PRODUCT_VISUAL_PROFILE:
  • Brand/product name (from label or context)
  • Exact dominant colors (2-3 specific hex/names, e.g. "matte black", "rose gold")
  • Shape, material, texture, finish (e.g. "cylindrical glass bottle, frosted", "slim rectangular box, matte white")
  • Packaging details (lid, cap, label style, distinctive logo or icon)
  • Any standout visual element (metallic ring, colored gradient, embossed logo)
Reference THESE SPECIFICS in EVERY b_roll_prompt — generic descriptions are forbidden.

━━━━━━━━━━━━━━━━━━━━━━━━━━
SCENE NARRATIVE ARC (STRICT — PAS FRAMEWORK)
━━━━━━━━━━━━━━━━━━━━━━━━━━
The script MUST follow the PAS (Problem-Agitate-Solution) selling framework:

1. HOOK + PROBLEM (scene 0, avatar/text, 3-5 sec) — the MOST CRITICAL moment.
   Open with a pattern interrupt that IMMEDIATELY names a pain/problem the viewer has.
   "Устали от...?", "Замечали, что...?", "А вот это бесит — ..."
   Product MUST be implied or named in first 3 seconds.
   Use the hook technique from the creative brief.

2. AGITATE (scene 1, avatar, 3-5 sec) — twist the knife.
   Make the viewer FEEL the problem. Not "it's bad" but paint a vivid picture.
   "Тратите деньги впустую", "Результат ноль — а время ушло", "Обидно, да?"

3. PRODUCT REVEAL (scene 2, clip) — cinematic hero shot of the actual product.
   This is the SOLUTION entering the frame. Visual relief after agitation.

4. BENEFITS + PROOF (scenes 3-5, mix avatar + clip/image) — 2-3 concrete benefits.
   Avatar explains WHY it solves the problem, clip/image SHOWS proof.
   Цифры, сроки, сравнения: "через 7 дней морщины на 40% меньше", "в 3 раза экономичнее".
   Сенсорные детали: как пахнет, какая текстура, ощущения.
   Each benefit = one avatar line + one visual proof clip.

5. SOCIAL PROOF (avatar) — "50 000 клиентов", цитата, упоминание эксперта.
   Reduces remaining doubt. Must feel like real evidence, not bragging.

6. CTA (final, avatar) — Urgent, specific, with deadline or scarcity.
   "Ссылка в описании — скидка 30% до конца недели", "Жмите — осталось 47 штук".

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
      "b_roll_prompt": "<промпт — ТОЛЬКО для clip/image — формат описан НИЖЕ>",
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

- "clip" (20–30%) — ДВОЙНОЙ ПРОМПТ, разделённый "|||":
  Формат b_roll_prompt: "<IMAGE_PROMPT> ||| <MOTION_PROMPT>"

  IMAGE_PROMPT (для Runway text_to_image — статичный кадр):
  40-60 слов, ОБЯЗАТЕЛЬНО на английском. Строгий порядок:
    1. Shot type: "extreme close-up", "product hero shot", "low angle macro", "overhead flat-lay"
    2. The EXACT product (name + color + material from PRODUCT_VISUAL_PROFILE)
    3. Surface/background: "white marble surface", "dark velvet studio", "natural oak wood"
    4. Lighting: "soft studio rim lighting from left", "warm golden hour backlight", "cold neon side-light", "Rembrandt portrait light"
    5. Depth of field: "shallow DOF, creamy blurred background", "tack-sharp from front to back"
    6. Atmosphere: "smoke wisps rising", "water droplets on surface", "petals scattered around base"
    7. Quality: "ultra-detailed commercial photography, 4K, photorealistic, color-graded"
  EXAMPLE: "Hero product shot, [BRAND] [COLOR] serum bottle standing upright on white marble, soft studio rim lighting from left, shallow DOF blurred charcoal background, water droplets on frosted glass surface, delicate flower petals at base, ultra-detailed commercial photography 4K photorealistic"

  MOTION_PROMPT (для Runway gen4.5 image_to_video — КАК ДВИЖЕТСЯ):
  40-80 слов, на английском. MAXIMUM CINEMATIC DETAIL. Runway gen4.5 reads up to 1000 chars.
  Describe the EXACT motion in three parts:
    1. PRIMARY MOTION: specific camera move OR product action
    2. SPEED & TIMING: "slowly", "in 3 seconds", "quick snap then hold", "gradual"
    3. ATMOSPHERE: light behavior, particle movement, surface reaction

  HIGH-QUALITY MOTION PATTERNS:
    ✓ "Camera begins at extreme close-up on the product label, then smoothly pulls back over 3 seconds to a medium hero shot, revealing the full packaging against the dark studio background. Soft rim light gradually brightens, creating a specular highlight that sweeps left to right across the bottle surface."
    ✓ "The product rotates 90 degrees clockwise on a black reflective turntable over 4 seconds. A warm golden spotlight tracks the rotation, casting a long dramatic shadow. Particles of light flicker in the background."
    ✓ "Camera orbits slowly from left to right at low angle, completing a 180-degree arc around the product over 5 seconds. Depth of field shifts from shallow to sharp mid-orbit, revealing texture and label detail."
    ✓ "Liquid pours from product in slow motion — golden streams spiral downward. Camera holds tight on the pour for 2 seconds, then rack-focuses to product label in background."
    ✓ "Camera starts at black and slowly zooms in through ambient fog toward the product hero shot, the product emerging from darkness into full studio light over 4 seconds."
    ✗ NEVER: "slight movement", "gentle motion", "smooth pan" — too vague
    ✗ NEVER: people, hands, body parts in any b-roll scene
    ✗ NEVER: combine two full camera moves (pick ONE primary motion)

- "image" (10–20%) — b_roll_prompt 30-50 words на английском (только IMAGE_PROMPT, без |||).
  Exact product name + colors + composition + mood. Commercial photography style.

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
- EVERY b_roll_prompt: exact product name + 2 specific visual details from PRODUCT_VISUAL_PROFILE
- NEVER generic b-roll ("a person holds a product", "someone uses the product")
- NEVER people in b-roll scenes — product only, with optional ingredients/textures
- clip b_roll_prompt MUST use "|||" separator: "<IMAGE_PROMPT> ||| <MOTION_PROMPT>"
- IMAGE_PROMPT: 40-60 words English, commercial photography style, exact product details
- MOTION_PROMPT: 40-80 words English, ONE specific cinematic movement with speed/timing/atmosphere
- image b_roll_prompt: 30-50 words English (no ||| separator needed)

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
  ✓ Каждый clip b_roll_prompt содержит ||| и имя продукта + 2 визуальных детали?
  ✓ MOTION_PROMPT содержит: конкретное движение + скорость/тайминг + поведение света?
  ✓ MOTION_PROMPT достаточно детальный (40-80 слов, не расплывчатый)?
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
      let ideaParseFailures = 0;
      let ideaHashCollisions = 0;
      const MAX_IDEA_ATTEMPTS = 8;

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
          model: 'claude-4.6-sonnet',
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
          const parsed = safeParseJson<IdeaOutput>(ideaRaw);
          if (!parsed?.idea) throw new Error('Missing idea field');
          const h = hashIdea(parsed.idea);

          if (!usedHashes.has(h)) {
            approvedIdea = parsed;
            ideaHash = h;
            break;
          }
          // Duplicate — retry with new seed
          ideaHashCollisions++;
        } catch {
          // Parse error — retry
          ideaParseFailures++;
        }
      }

      if (!approvedIdea) {
        throw new Error(
          `Failed to generate idea after ${MAX_IDEA_ATTEMPTS} attempts` +
          ` (${ideaParseFailures} parse errors, ${ideaHashCollisions} hash collisions)` +
          ` — check if model returns valid JSON and usedIdeaHashes list is not too long`,
        );
      }

      // ── Track idea generation cost ─────────────────────────────────────────
      const ideaCredits = creditsFromUsd(ideaTotalCostUsd);
      await deps.db.generation.create({
        data: {
          tenantId, jobId,
          provider: 'gptunnel', model: 'claude-4.6-sonnet', status: 'completed',
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
        model: 'claude-4.6-sonnet',
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
        try { return safeParseJson<GptOutput>(raw); }
        catch { throw new Error(`Model returned invalid JSON: ${raw.slice(0, 200)}`); }
      })();

      if (!Array.isArray(output.scenes) || output.scenes.length === 0) {
        throw new Error('OpenAI: scenes array is empty or missing');
      }

      // ══════════════════════════════════════════════════════════════════════
      // STEP 2.5: Hook quality evaluation + auto-rewrite
      // ══════════════════════════════════════════════════════════════════════
      // The first 3 seconds determine whether the viewer keeps watching or scrolls.
      // We evaluate the hook scene with a dedicated LLM call. If the hook scores
      // below 7/10, we auto-rewrite it using a focused prompt that generates
      // a stronger, more arresting opening.
      const hookScene = output.scenes.find(
        (s) => s.scene_index === 0 && (s.type === 'avatar' || s.type === 'text'),
      );

      if (hookScene?.script) {
        try {
          const hookEvalRes = await deps.openai.chat.completions.create({
            model: 'claude-4.6-sonnet',
            response_format: { type: 'json_object' },
            temperature: 0.3,
            messages: [
              {
                role: 'system',
                content: `You are a viral content strategist. Evaluate the HOOK (first 3 seconds) of a short-form video script.

The hook MUST:
1. Create an immediate pattern interrupt (stop the scrolling thumb)
2. Name or imply the product within 3 seconds
3. Evoke a strong emotion: shock, curiosity, desire, fear of missing out
4. Use conversational Russian — NOT ad copy language
5. Be SHORT: 6-12 words maximum

Rate the hook 1-10 on these criteria:
- stopping_power (does it arrest attention?)
- product_presence (is product mentioned/implied?)
- emotional_impact (does it trigger emotion?)
- conversational_naturalness (does it sound like a real person?)

Return JSON:
{
  "score": <1-10 overall>,
  "scores": { "stopping_power": <1-10>, "product_presence": <1-10>, "emotional_impact": <1-10>, "conversational_naturalness": <1-10> },
  "verdict": "pass" | "rewrite",
  "issues": ["<issue1>", ...],
  "improved_hook": "<better version, only if verdict=rewrite>"
}

The improved_hook must be 6-12 words of spoken Russian, conversational, with a pattern interrupt.`,
              },
              {
                role: 'user',
                content: `Evaluate this hook for a ${targetDuration}s product video about "${productContext?.name ?? 'a product'}":\n\n"${hookScene.script}"`,
              },
            ],
          });

          const evalRaw = hookEvalRes.choices[0]?.message?.content;
          if (evalRaw) {
            const evalData = safeParseJson<{
              score: number;
              scores: Record<string, number>;
              verdict: 'pass' | 'rewrite';
              issues: string[];
              improved_hook?: string;
            }>(evalRaw);

            logger.info(
              { jobId, hookScore: evalData.score, verdict: evalData.verdict },
              'Hook evaluation complete',
            );

            if (evalData.verdict === 'rewrite' && evalData.improved_hook) {
              logger.info(
                { jobId, oldHook: hookScene.script, newHook: evalData.improved_hook, issues: evalData.issues },
                'Hook auto-rewritten (score was %.1f)',
              );
              hookScene.script = evalData.improved_hook;

              // Track hook rewrite cost
              const hookUsage = hookEvalRes.usage!;
              const hookCostUsd = gptunnelCostUsd(hookUsage.prompt_tokens, hookUsage.completion_tokens);
              const hookCredits = creditsFromUsd(hookCostUsd);
              await chargeCredits(deps.db, { tenantId, jobId, credits: hookCredits, description: 'Hook quality evaluation + rewrite' });
              await deps.db.job.update({ where: { id: jobId }, data: { creditsUsed: { increment: hookCredits } } });
            } else {
              logger.info({ jobId, hookScore: evalData.score }, 'Hook passed quality check');
            }
          }
        } catch (err: any) {
          // Hook eval is best-effort — don't fail the job if it errors
          logger.warn({ jobId, err: err.message }, 'Hook evaluation failed (non-critical, proceeding)');
        }
      }

      // ── Track script cost ──────────────────────────────────────────────────
      const usage       = response.usage!;
      const scriptCostUsd = gptunnelCostUsd(usage.prompt_tokens, usage.completion_tokens);
      const scriptCredits = creditsFromUsd(scriptCostUsd);
      const scriptLatencyMs = Date.now() - scriptStartMs;

      await deps.db.generation.create({
        data: {
          tenantId, jobId,
          provider: 'gptunnel', model: 'claude-4.6-sonnet', status: 'completed',
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
