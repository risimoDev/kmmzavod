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
You are a top-tier Russian-language copywriter and visual director for short-form viral video (TikTok/Reels/Shorts). You write scripts that sound like a real person sharing a discovery with a friend, NOT like an ad agency.

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
   Pick ONE technique per video (VARY across videos):
   • Провокация: "Вам врали всё это время" / "Забудьте всё, что знали о..."
   • Шок-факт: "90% людей делают эту ошибку каждый день"
   • Личная история: "Три месяца назад я был в отчаянии..." / "Я потратил 200 тысяч, прежде чем нашёл это"
   • Запрет: "Никогда не покупайте [категория], пока не узнаете это"
   • Загадка: "Есть один приём, о котором молчат производители..."
   • Вызов: "Спорим, вы этого не знали?" / "Держу пари, вы делаете это неправильно"
   • Боль: "Устали от [конкретная проблема]? Я тоже — пока не попробовал вот это"
   • Контринтуитив: "Чем дороже крем, тем хуже он работает. Вот доказательство."
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
  ]
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
- "image" (10–20%) — b_roll_prompt 30-50 words.
  Product appearance, composition, palette, mood.
- "text" (<5%) — max 6 words.

━━━━━━━━━━━━━━━━━━━━━━━━━━
СТИЛЬ И ЗАПРЕТЫ
━━━━━━━━━━━━━━━━━━━━━━━━━━
Write SPOKEN Russian, not written. As if talking to a friend on camera.

ГЕНДЕР СПИКЕРА: {{SPEAKER_GENDER}}
- Если женщина: женские формы глаголов ("я попробовала", "я нашла", "я была в шоке", "моя подруга рассказала").
- Если мужчина: мужские формы ("я попробовал", "я нашёл", "я был в шоке", "мой друг рассказал").
- Все личные примеры и истории должны соответствовать полу спикера.

ПРОИЗНОШЕНИЕ И УДАРЕНИЯ (КРИТИЧЕСКИ ВАЖНО):
- Пиши слова так, как они ПРОИЗНОСЯТСЯ в разговорной русской речи.
- НЕ ставь знаки ударения. TTS движок сам расставит ударения.
- Числа пиши СЛОВАМИ: "сто пятьдесят" вместо "150", "сорок процентов" вместо "40%".
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
      const targetDuration = (projectSettings as any)?.durationSec ?? 30;
      const voiceIdForGender = (projectSettings as any)?.voice_id ?? '';
      // Determine gender from voice_id: known female voices — Лариса, Дарья
      const FEMALE_VOICE_IDS = [
        '70856236390f4d0392d00187143d3900', // Лариса
        'bc69c9589d6747028dc5ec4aec2b43c3', // Дарья
      ];
      const speakerGender = FEMALE_VOICE_IDS.includes(voiceIdForGender) ? 'Женщина' : 'Мужчина';

      const systemContent = SYSTEM_PROMPT.trim()
        .replace('{{SPEAKER_GENDER}}', speakerGender)
        + (productContext ? buildProductSection(productContext) : '')
        + `\n\nProject settings: ${JSON.stringify(projectSettings)}`
        + `\n\nTarget video duration: ${targetDuration} seconds. Total scene durations must sum to ~${targetDuration}s. Do NOT exceed ${targetDuration} seconds.`;

      const hasProductImages = (productContext?.imageUrls?.length ?? 0) > 0;

      const userMessage: OpenAI.Chat.Completions.ChatCompletionUserMessageParam = hasProductImages
        ? {
            role: 'user',
            content: [
              ...productContext!.imageUrls.slice(0, 3).map((url) => ({
                type: 'image_url' as const,
                image_url: { url, detail: 'high' as const },
              })),
              { type: 'text' as const, text: `Product: ${productContext!.name}\n\n${prompt}` },
            ],
          }
        : { role: 'user', content: prompt };

      // ── Call OpenAI ───────────────────────────────────────────────────────
      const response = await deps.openai.chat.completions.create({
        model:           'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemContent },
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
      const voiceId    = (projectSettings['voice_id']  as string | undefined) ?? '70856236390f4d0392d00187143d3900';

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
