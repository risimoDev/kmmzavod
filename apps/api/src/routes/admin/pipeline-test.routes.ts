/**
 * Admin pipeline-test routes — step-by-step pipeline testing & compose testing.
 *
 * Extracted from admin.routes.ts to keep modules manageable.
 * Route prefix inherited from parent: /api/v1/admin
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../../lib/db';
import { logger } from '../../logger';
import { config } from '../../config';
import { audit, solidPng } from './shared';

export async function pipelineTestRoutes(app: FastifyInstance) {

  // ── PIPELINE TEST (step-by-step) ─────────────────────────────────────────

  const PipelineTestScriptBody = z.object({
    productName: z.string().min(1).max(200),
    productDescription: z.string().max(2000).optional(),
    features: z.array(z.string()).default([]),
    targetAudience: z.string().max(500).optional(),
    brandVoice: z.string().max(100).optional(),
    prompt: z.string().min(10).max(2000),
    language: z.string().default('ru'),
    imageKeys: z.array(z.string()).default([]),
  });

  // POST /api/v1/admin/pipeline-test/script  — Step 1: generate script via GPT
  app.post('/pipeline-test/script', async (req, reply) => {
    const body = PipelineTestScriptBody.parse(req.body);
    const storage = (app as any).storage;

    // Build product context with presigned image URLs
    const imageUrls: string[] = [];
    for (const key of body.imageKeys.slice(0, 3)) {
      try {
        const url = await storage.presignedUrl(key, 3600);
        imageUrls.push(url);
      } catch { /* skip broken keys */ }
    }

    const productContext = {
      name: body.productName,
      description: body.productDescription,
      features: body.features,
      targetAudience: body.targetAudience,
      brandVoice: body.brandVoice,
      imageUrls,
    };

    // Call GPTunnel directly (no queue, no credits)
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({
      baseURL: config.GPTUNNEL_BASE_URL,
      apiKey: config.GPTUNNEL_API_KEY ?? '',
    });

    // Build the same system prompt used in production (synced with gpt-script.worker.ts)
    const SYSTEM_PROMPT_SHORT = `You are a top-tier Russian-language copywriter and visual director for short-form viral video (TikTok/Reels/Shorts). You write scripts that sound like a real person sharing a discovery with a friend, NOT like an ad agency.

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
   Pick ONE hook technique: провокация/шок-факт/личная_история/запрет/загадка/вызов/боль/контринтуитив

2. AGITATE (scene 1, avatar, 3-5 sec) — twist the knife.
   Make the viewer FEEL the problem. Not "it's bad" but paint a vivid picture.
   "Тратите деньги впустую", "Результат ноль — а время ушло", "Обидно, да?"

3. PRODUCT REVEAL (scene 2, clip) — cinematic hero shot of the actual product.
   This is the SOLUTION entering the frame. Visual relief after agitation.

4. BENEFITS + PROOF (scenes 3-5, mix avatar + clip/image) — 2-3 concrete benefits.
   Avatar explains WHY it solves the problem, clip/image SHOWS proof.
   Цифры, сроки, сравнения: "через 7 дней морщины на 40% меньше", "в 3 раза экономичнее".
   Each benefit = one avatar line + one visual proof clip.

5. SOCIAL PROOF (avatar) — "50 000 клиентов", цитата, упоминание эксперта.

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

  IMAGE_PROMPT (статичный кадр): 40-60 слов, на английском. Строгий порядок:
    1. Shot type  2. EXACT product  3. Surface/background  4. Lighting
    5. Depth of field  6. Atmosphere  7. Quality: "ultra-detailed commercial photography, 4K, photorealistic"

  MOTION_PROMPT (как движется): 40-80 слов, на английском. Три части:
    1. PRIMARY MOTION: конкретное движение камеры или продукта
    2. SPEED & TIMING: "slowly", "in 3 seconds", "gradual"
    3. ATMOSPHERE: поведение света, частиц
    ✗ NEVER: "slight movement", "gentle motion" — too vague
    ✗ NEVER: people, hands, body parts

- "image" (10–20%) — b_roll_prompt 30-50 words на английском (только IMAGE_PROMPT, без |||).
  Exact product name + colors + composition + mood. Commercial photography style.

- "text" (<5%) — max 6 words.

━━━━━━━━━━━━━━━━━━━━━━━━━━
СТИЛЬ И ЗАПРЕТЫ
━━━━━━━━━━━━━━━━━━━━━━━━━━
Write SPOKEN Russian, not written. As if talking to a friend on camera.

ПРОИЗНОШЕНИЕ: Числа пиши СЛОВАМИ ("сто пятьдесят" не "150"). Аббревиатуры раскрывай ("эс пэ эф" не "SPF").

ЗАПРЕЩЁННЫЕ СЛОВА (НИКОГДА):
  ✗ "уникальный", "инновационный", "революционный", "лучший на рынке"
  ✗ "не упустите шанс", "спешите", "торопитесь"
  ✗ "данный продукт", "представляем вашему вниманию"
  ✗ "в современном мире", "в наше время", "каждый знает", "не секрет что"

ОБЯЗАТЕЛЬНЫЕ ПРИЁМЫ (use 2-3 per script):
  ✓ Метафора/сравнение ✓ Мини-история ✓ Конкретный пример использования ✓ Неожиданный поворот ✓ Числа

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
Если нет — перепиши эту сцену.`;

    const productSection = [
      '\n--- Product Information ---',
      `Product name: ${productContext.name}`,
      productContext.description ? `Description: ${productContext.description}` : '',
      productContext.features.length ? `Key features: ${productContext.features.join('; ')}` : '',
      productContext.targetAudience ? `Target audience: ${productContext.targetAudience}` : '',
      productContext.brandVoice ? `Brand voice: ${productContext.brandVoice}` : '',
      imageUrls.length ? 'Product images are attached.' : '',
      '--- End Product Information ---',
    ].filter(Boolean).join('\n');

    const systemContent = SYSTEM_PROMPT_SHORT + productSection + `\n\nLanguage: ${body.language}`;

    const hasImages = imageUrls.length > 0;
    const userMessage: any = hasImages
      ? {
          role: 'user',
          content: [
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
            { type: 'text', text: `Product: ${productContext.name}\n\n${body.prompt}` },
          ],
        }
      : { role: 'user', content: body.prompt };

    const response = await openai.chat.completions.create({
      model: 'claude-4.6-sonnet',
      response_format: { type: 'json_object' },
      temperature: 1.0,
      messages: [
        { role: 'system', content: systemContent },
        userMessage,
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      return reply.code(500).send({ error: 'GPTError', message: 'OpenAI returned empty content' });
    }

    let output: { title: string; scenes: Array<{ scene_index: number; type: string; script?: string; b_roll_prompt?: string; duration_sec: number }>; social_metadata?: { description: string; hashtags: string[] } };
    try {
      output = JSON.parse(raw);
    } catch {
      return reply.code(500).send({ error: 'GPTError', message: 'Invalid JSON from GPT', raw: raw.slice(0, 500) });
    }

    const usage = response.usage;

    await audit(req.user.userId, 'pipeline-test.script', 'system', 'test', req.ip, {
      after: { sceneCount: output.scenes?.length, tokens: usage?.total_tokens },
    });

    return reply.send({
      title: output.title,
      scenes: output.scenes,
      social_metadata: output.social_metadata,
      usage: { prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens },
    });
  });

  // POST /api/v1/admin/pipeline-test/upload-scene — Upload video/image for a scene override
  app.post('/pipeline-test/upload-scene', async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Файл не передан' });
    }

    const ALLOWED_TYPES = [
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'video/webm', 'video/quicktime',
    ];
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Допустимые форматы: JPEG, PNG, WebP, MP4, WebM, MOV' });
    }

    const MAX_SIZE = 200 * 1024 * 1024; // 200MB
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      size += chunk.length;
      if (size > MAX_SIZE) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Максимальный размер файла — 200 МБ' });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const testId = crypto.randomUUID().slice(0, 8);
    const ext = file.filename.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) ?? 'mp4';
    const key = `test/pipeline/${testId}/scene_override.${ext}`;

    const storage = (app as any).storage;
    await storage.uploadBuffer(key, buffer, { contentType: file.mimetype });
    const url = await storage.presignedUrl(key, 86400);

    return reply.send({ key, url, size: buffer.length, mimetype: file.mimetype });
  });

  // ── Start avatar video generation via HeyGen (async — returns video_id immediately) ──
  const StartAvatarBody = z.object({
    script: z.string().min(1).max(5000),
    avatar_id: z.string().min(1),
    voice_id: z.string().min(1),
    bg_color: z.string().default('#00FF00'),
    target_duration: z.number().int().min(15).max(90).optional(),
  });

  app.post('/pipeline-test/start-avatar', async (req, reply) => {
    const body = StartAvatarBody.parse(req.body);
    const apiKey = config.HEYGEN_API_KEY;
    if (!apiKey) {
      return reply.code(400).send({ error: 'NoApiKey', message: 'HEYGEN_API_KEY не настроен' });
    }

    try {
      const createRes = await fetch('https://api.heygen.com/v2/video/generate', {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_inputs: [{
            character: { type: 'avatar', avatar_id: body.avatar_id, avatar_style: 'normal' },
            voice: { type: 'text', input_text: body.script, voice_id: body.voice_id },
            background: { type: 'color', value: body.bg_color },
          }],
          dimension: { width: 1080, height: 1920 },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        return reply.code(502).send({ error: 'HeyGenCreateFailed', message: `HeyGen HTTP ${createRes.status}: ${errText}` });
      }

      const createData = (await createRes.json()) as any;
      if (createData.error) {
        const errMsg = typeof createData.error === 'string'
          ? createData.error
          : (createData.error?.message ?? JSON.stringify(createData.error));
        return reply.code(502).send({ error: 'HeyGenCreateFailed', message: errMsg });
      }

      const videoId = createData.data?.video_id;
      if (!videoId) {
        return reply.code(502).send({ error: 'HeyGenCreateFailed', message: 'No video_id returned' });
      }

      logger.info({ videoId }, 'HeyGen avatar: задача создана');

      await audit(req.user.userId, 'pipeline-test.start-avatar', 'system', videoId, req.ip, {
        after: { videoId, avatarId: body.avatar_id, voiceId: body.voice_id },
      });

      return reply.send({ heygen_video_id: videoId });
    } catch (e: any) {
      logger.error({ err: e.message }, 'HeyGen start-avatar failed');
      return reply.code(500).send({ error: 'HeyGenError', message: e.message });
    }
  });

  // ── Poll avatar status (single check, no server-side loop) ──────────────
  app.get('/pipeline-test/avatar-status/:videoId', async (req, reply) => {
    const { videoId } = req.params as { videoId: string };
    const apiKey = config.HEYGEN_API_KEY;
    if (!apiKey) {
      return reply.code(400).send({ error: 'NoApiKey', message: 'HEYGEN_API_KEY не настроен' });
    }

    try {
      const statusRes = await fetch(
        `https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
        { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
      );

      if (!statusRes.ok) {
        return reply.code(502).send({ error: 'HeyGenStatusFailed', message: `HTTP ${statusRes.status}` });
      }

      const data = (await statusRes.json()) as any;
      const status = data.data?.status ?? 'unknown';
      const videoUrl = data.data?.video_url ?? null;
      const duration = data.data?.duration ?? 0;
      const error = data.data?.error ?? null;

      // If completed — download and upload to MinIO
      if (status === 'completed' && videoUrl) {
        const storage = (app as any).storage;
        const testId = crypto.randomUUID().slice(0, 8);

        try {
          const dlRes = await fetch(videoUrl, {
            signal: AbortSignal.timeout(120_000),
            redirect: 'follow',
          });
          if (!dlRes.ok) {
            logger.warn({ videoId, httpStatus: dlRes.status }, 'HeyGen download failed, returning direct URL');
            return reply.send({ status: 'completed', url: videoUrl, duration_sec: duration, direct: true });
          }
          const videoBuffer = Buffer.from(await dlRes.arrayBuffer());
          const key = `test/pipeline/${testId}/avatar_heygen.mp4`;
          await storage.uploadBuffer(key, videoBuffer, { contentType: 'video/mp4' });
          const url = await storage.presignedUrl(key, 86400);

          logger.info({ videoId, key, duration }, 'HeyGen avatar: видео загружено в MinIO');

          return reply.send({ status: 'completed', key, url, duration_sec: duration });
        } catch (dlErr: any) {
          // Download/upload failed — return HeyGen URL directly as fallback
          logger.warn({ videoId, err: dlErr.message }, 'HeyGen download to MinIO failed, returning direct URL');
          return reply.send({ status: 'completed', url: videoUrl, duration_sec: duration, direct: true });
        }
      }

      return reply.send({ status, error, duration_sec: duration });
    } catch (e: any) {
      logger.error({ err: e.message, videoId }, 'HeyGen avatar-status failed');
      return reply.code(500).send({ error: 'HeyGenError', message: e.message });
    }
  });

  const PipelineTestComposeBody = z.object({
    scenes: z.array(z.object({
      type: z.enum(['avatar', 'clip', 'image', 'text']),
      storage_key: z.string(),
      duration_sec: z.number().min(1).max(60),
      script: z.string().optional(),
    })).min(1).max(20),
    preset: z.enum(['dynamic', 'smooth', 'minimal']).default('dynamic'),
    with_subtitles: z.boolean().default(true),
    subtitle_style: z.enum(['tiktok', 'cinematic', 'minimal', 'default']).default('tiktok'),
  });

  // POST /api/v1/admin/pipeline-test/compose — Step 3: compose the final video
  app.post('/pipeline-test/compose', async (req, reply) => {
    let body;
    try {
      body = PipelineTestComposeBody.parse(req.body);
    } catch (e: any) {
      const issues = e.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? e.message;
      return reply.code(400).send({ error: 'ValidationError', message: `Ошибка валидации данных: ${issues}` });
    }
    const testId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();
    const storage = (app as any).storage;

    const vpUrl = config.VIDEO_PROCESSOR_URL;

    // Health check
    try {
      const hc = await fetch(`${vpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!hc.ok) {
        return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: `video-processor вернул HTTP ${hc.status}` });
      }
    } catch (e: any) {
      return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: `Не удалось подключиться к video-processor: ${e.message}` });
    }

    const PRESET_MAP: Record<string, { transition: string; transition_duration: number }> = {
      dynamic: { transition: 'fade', transition_duration: 0.3 },
      smooth:  { transition: 'smoothleft', transition_duration: 0.5 },
      minimal: { transition: 'cut', transition_duration: 0 },
    };
    const presetCfg = PRESET_MAP[body.preset];

    // Auto-generate placeholder images for text scenes without files
    for (const s of body.scenes) {
      if (!s.storage_key && s.type === 'text') {
        const png = solidPng(1080, 1920, 18, 18, 24); // dark background
        const placeholderKey = `test/pipeline/${testId}/text_placeholder_${crypto.randomUUID().slice(0, 6)}.png`;
        await storage.uploadBuffer(placeholderKey, png, { contentType: 'image/png' });
        s.storage_key = placeholderKey;
        (s as any)._auto_generated = true;
      }
    }

    // Validate all scenes have storage_key
    const missingSk = body.scenes.filter((s) => !s.storage_key);
    if (missingSk.length > 0) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: `Для ${missingSk.length} сцен не загружены файлы. Загрузите видео/изображения для всех сцен типа avatar, clip, image.`,
      });
    }

    const scenes = body.scenes.map((s, i) => ({
      scene_id: `ptest_${testId}_${i}`,
      type: (s as any)._auto_generated ? 'image' : s.type,
      storage_key: s.storage_key,
      duration_sec: s.duration_sec,
      transition: presetCfg.transition,
      transition_duration: presetCfg.transition_duration,
      ken_burns: (s.type === 'image' || (s as any)._auto_generated) ? 'auto' : undefined,
    }));

    // Build subtitles from avatar scripts
    const subtitles: Array<{ start_sec: number; end_sec: number; text: string }> = [];
    if (body.with_subtitles) {
      let cursor = 0;
      for (const s of body.scenes) {
        if (s.script) {
          subtitles.push({ start_sec: cursor, end_sec: cursor + s.duration_sec, text: s.script });
        }
        cursor += s.duration_sec;
        // Subtract transition overlap for non-last scenes
      }
    }

    const outputKey = `test/pipeline/${testId}/final_${body.preset}.mp4`;

    try {
      const composeRes = await fetch(`${vpUrl}/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: `ptest_${testId}`,
          tenant_id: 'system',
          output_key: outputKey,
          scenes,
          subtitles,
          settings: { subtitle_style: body.subtitle_style },
        }),
        signal: AbortSignal.timeout(600_000),
      });

      if (!composeRes.ok) {
        const errBody = await composeRes.text();
        return reply.code(composeRes.status).send({ error: 'ComposeFailed', message: `video-processor HTTP ${composeRes.status}`, detail: errBody });
      }

      const result = await composeRes.json();
      const outputUrl = await storage.presignedUrl(outputKey, 86400);
      const elapsed = Date.now() - startTime;

      await audit(req.user.userId, 'pipeline-test.compose', 'system', testId, req.ip, {
        after: { preset: body.preset, scenes: scenes.length, elapsed },
      });

      return reply.send({
        test_id: testId,
        preset: body.preset,
        compose_result: result,
        output_url: outputUrl,
        elapsed_ms: elapsed,
      });
    } catch (e: any) {
      return reply.code(500).send({ error: 'ComposeError', message: e.message });
    }
  });

  // ── Layout templates ──────────────────────────────────────────────────────
  const LAYOUT_TEMPLATES: Record<string, {
    name: string;
    description: string;
    segments: Array<{ layout: string; weight: number; bg_type: 'image' | 'video' }>;
  }> = {
    presenter: {
      name: 'Презентер',
      description: 'Чередование полноэкранного аватара и PIP в углу',
      segments: [
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'pip_bl',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'pip_bl',     weight: 0.25, bg_type: 'video' },
      ],
    },
    narrator: {
      name: 'Нарратор',
      description: 'Фокус на продукте — аватар сопровождает в PIP',
      segments: [
        { layout: 'pip_bl',     weight: 0.30, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.30, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
      ],
    },
    dynamic: {
      name: 'Динамичный',
      description: 'PIP перемещается по углам — энергичный монтаж',
      segments: [
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.20, bg_type: 'video' },
        { layout: 'pip_bl',     weight: 0.20, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_tr',     weight: 0.20, bg_type: 'video' },
      ],
    },
    focus: {
      name: 'Фокус',
      description: 'Аватар чередуется с озвучкой поверх продукта',
      segments: [
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'voiceover',  weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'voiceover',  weight: 0.25, bg_type: 'video' },
      ],
    },
    blogger: {
      name: 'Блогер',
      description: 'Стиль обзора — аватар комментирует продукт',
      segments: [
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_tr',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.15, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.20, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
      ],
    },
    expert: {
      name: 'Экспертный',
      description: 'Начинается с продукта, аватар меняет позицию',
      segments: [
        { layout: 'pip_bl',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
      ],
    },
  };

  app.get('/pipeline-test/layout-templates', async (_req, reply) => {
    return reply.send(LAYOUT_TEMPLATES);
  });

  // ── Generate continuous script (layout mode) ──────────────────────────────
  const LayoutScriptBody = z.object({
    productName: z.string().min(1),
    productDescription: z.string().optional(),
    features: z.array(z.string()).default([]),
    targetAudience: z.string().optional(),
    brandVoice: z.string().default('professional'),
    prompt: z.string().min(10).max(2000),
    language: z.string().default('ru'),
    imageKeys: z.array(z.string()).default([]),
    targetDuration: z.number().int().min(15).max(90).default(30),
    gender: z.enum(['male', 'female']).default('female'),
  });

  app.post('/pipeline-test/generate-script-layout', async (req, reply) => {
    const body = LayoutScriptBody.parse(req.body);
    const storage = (app as any).storage;

    const imageUrls: string[] = [];
    for (const key of body.imageKeys.slice(0, 3)) {
      try { imageUrls.push(await storage.presignedUrl(key, 3600)); } catch {}
    }

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({
      baseURL: config.GPTUNNEL_BASE_URL,
      apiKey: config.GPTUNNEL_API_KEY ?? '',
    });

    const LAYOUT_SYSTEM_PROMPT = `You are a top-tier Russian-language copywriter who writes scripts that sound like a friend talking, NOT like an ad. Your scripts must feel spontaneous, real, and impossible to skip.

━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — PRODUCT VISUAL ANALYSIS (if images attached)
━━━━━━━━━━━━━━━━━━━━━━━━━━
Analyze every attached product image. Extract and store as PRODUCT_VISUAL_PROFILE:
  • Dominant colors & palette, shape/form factor, material/texture
  • Packaging, logo, distinctive markings
Reference it in every b_roll_prompt.

━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR TASK
━━━━━━━━━━━━━━━━━━━━━━━━━━
Write ONE continuous, natural SPOKEN script for a talking-head avatar. Target duration: {{TARGET_DURATION}} seconds ({{WORD_MIN}}–{{WORD_MAX}} words). NEVER exceed {{WORD_MAX}} words — that is a HARD LIMIT.
HeyGen TTS speaks Russian at ~2 words per second. If you write more words than the limit, the avatar video WILL be longer than the target and will get CUT OFF mid-sentence.
The script must sound like a real person speaking on camera — NOT like a ChatGPT-generated ad.

━━━━━━━━━━━━━━━━━━━━━━━━━━
SCRIPT STRUCTURE (STRICT ARC)
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. HOOK (first 3 sec) — the most critical line. Pattern interrupt that stops thumbs.
   Pick ONE technique PER VIDEO (vary across outputs):
   • Провокация: "Вам врали всё это время" / "Забудьте всё, что знали о..."
   • Шок-факт: "90% людей делают эту ошибку каждый день"
   • Личная история: "Три месяца назад я был в отчаянии..." / "Я потратил 200 тысяч, прежде чем нашёл это"
   • Запрет: "Никогда не покупайте [категория], пока не узнаете это"
   • Загадка: "Есть один приём, о котором молчат производители..."
   • Вызов: "Спорим, вы этого не знали?" / "Держу пари, вы делаете это неправильно"
   • Боль: "Устали от [конкретная проблема]? Я тоже — пока не попробовал вот это"
   • Контринтуитив: "Чем дороже крем, тем хуже он работает. Вот доказательство."
   The hook MUST mention or reference the product.

2. ПРОБЛЕМА (1-2 предложения) — усиливаем боль.
   Конкретика: не "многие сталкиваются с проблемой", а "вы просыпаетесь утром, кожа тусклая, макияж ложится пятнами".
   Задайте вопрос: "Знакомо?"

3. РЕШЕНИЕ (1-2 предложения) — назовите продукт. Суть в одном предложении. Без воды.

4. ДОКАЗАТЕЛЬСТВА (2-3 предложения) — конкретные выгоды.
   Цифры, сроки, сравнения: "через 7 дней морщины на 40% меньше", "в 3 раза экономичнее аналогов".
   Сенсорные детали: как пахнет, какая текстура, как ощущается.

5. СОЦИАЛЬНОЕ ДОКАЗАТЕЛЬСТВО (1 предложение) — "50 000 клиентов", цитата, эксперт.

6. CTA (последнее предложение) — "Ссылка в описании", "закажите — скидка до пятницы".

━━━━━━━━━━━━━━━━━━━━━━━━━━
СТИЛЬ РЕЧИ
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Пиши КАК ГОВОРИШЬ, не как пишешь. Разговорная интонация.
- Короткие рубленые фразы (6-14 слов). Чередуй короткие с длиннее.
- Обращение "вы". Паузы: "..." для эмфазы.
- Риторические вопросы: "А знаете, что самое крутое?", "Понимаете, к чему я?"
- Связки: "Смотрите...", "Вот в чём фишка...", "И тут начинается самое интересное..."
- Усилители: "реально", "честно", "послушайте", "обратите внимание".
- NO stage directions, emoji, markdown — pure speech text.

ГЕНДЕР СПИКЕРА: {{SPEAKER_GENDER}}
- Если женщина: используй женские формы глаголов ("я попробовала", "я нашла", "я была в шоке", "моя подруга рассказала").
- Если мужчина: используй мужские формы ("я попробовал", "я нашёл", "я был в шоке", "мой друг рассказал").
- Все личные примеры, истории, обращения должны соответствовать полу спикера.

ПРОИЗНОШЕНИЕ И УДАРЕНИЯ (КРИТИЧЕСКИ ВАЖНО):
- Пиши слова так, как они ПРОИЗНОСЯТСЯ в разговорной русской речи.
- НЕ ставь знаки ударения (◌́). ТТС движок сам расставит ударения.
- Избегай слов, которые могут быть прочитаны неправильно TTS: "замок" (за́мок/замо́к), "мука" (му́ка/мука́) — используй контекст или альтернативные формулировки.
- Числа пиши СЛОВАМИ: "сто пятьдесят" вместо "150", "сорок процентов" вместо "40%".
- Аббревиатуры раскрывай: "эс пэ эф" вместо "SPF".

ЗАПРЕЩЁННЫЕ СЛОВА (НИКОГДА):
  ✗ "уникальный", "инновационный", "революционный", "лучший на рынке"
  ✗ "не упустите шанс", "спешите", "торопитесь"
  ✗ "данный продукт", "представляем вашему вниманию"
  ✗ "в современном мире", "в наше время", "каждый знает", "не секрет что"

ОБЯЗАТЕЛЬНЫЕ ПРИЁМЫ (2-3 в каждом скрипте):
  ✓ Метафора: "кожа как у младенца", "работает как швейцарские часы"
  ✓ Мини-история: "моя подруга попробовала и..."
  ✓ Конкретный пример: "утром нанесли — до вечера держится"
  ✓ Неожиданный поворот: "но подождите — это ещё не всё"
  ✓ Числа: "7 дней", "40%", "3 раза"

━━━━━━━━━━━━━━━━━━━━━━━━━━
b_roll_prompts — ФОНОВЫЕ ВИЗУАЛЫ
━━━━━━━━━━━━━━━━━━━━━━━━━━
2-3 промпта. "image" (30-50 слов): продукт + детали, композиция, палитра, настроение.
"video" (50-80 слов): тип кадра, камера, свет, размещение, фон, действие, качество 4K.
Каждый промпт: имя продукта + 2+ визуальных детали из PRODUCT_VISUAL_PROFILE.

━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT (VALID JSON ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "title": "<цепляющий заголовок, до 80 символов, эмодзи ОК>",
  "full_script": "<полный текст речи, 150-400 слов, без ремарок>",
  "b_roll_prompts": [
    { "type": "image"|"video", "prompt": "<промпт>" }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━
САМОПРОВЕРКА
━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Хук останавливает палец? Вызывает эмоцию?
  ✓ Продукт назван в первые 3 секунды?
  ✓ Выгоды конкретные (цифры/сроки)?
  ✓ Нет запрещённых слов?
  ✓ Текст звучит как живая речь, а не рекламный буклет?
  ✓ Есть минимум 2 приёма из ОБЯЗАТЕЛЬНЫХ?
  ✓ CTA чёткий? Каждый b_roll_prompt: имя + 2 визуальных детали?
Если нет — перепиши.`;

    const productSection = [
      '\n--- Product ---',
      `Name: ${body.productName}`,
      body.productDescription ? `Desc: ${body.productDescription}` : '',
      body.features.length ? `Features: ${body.features.join('; ')}` : '',
      body.targetAudience ? `Audience: ${body.targetAudience}` : '',
      body.brandVoice ? `Tone: ${body.brandVoice}` : '',
    ].filter(Boolean).join('\n');

    // HeyGen TTS speaks Russian at ~2 words/sec. Use conservative limits.
    const wordsPerSec = 2.0;
    const wordMin = Math.round(body.targetDuration * (wordsPerSec * 0.85));
    const wordMax = Math.round(body.targetDuration * wordsPerSec);

    const systemContent = LAYOUT_SYSTEM_PROMPT
      .replace(/\{\{TARGET_DURATION\}\}/g, String(body.targetDuration))
      .replace('{{WORD_MIN}}', String(wordMin))
      .replace('{{WORD_MAX}}', String(wordMax))
      .replace('{{SPEAKER_GENDER}}', body.gender === 'female' ? 'Женщина' : 'Мужчина')
      + productSection + `\n\nLanguage: ${body.language}\nTarget video duration: ${body.targetDuration} seconds. HARD LIMIT: ${wordMax} words maximum. Do NOT exceed this word count.`;

    const userMessage: any = imageUrls.length > 0
      ? {
          role: 'user',
          content: [
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
            { type: 'text', text: `Product: ${body.productName}\n\n${body.prompt}` },
          ],
        }
      : { role: 'user', content: body.prompt };

    const response = await openai.chat.completions.create({
      model: 'claude-4.6-sonnet',
      response_format: { type: 'json_object' },
      temperature: 1.0,
      messages: [
        { role: 'system', content: systemContent },
        userMessage,
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return reply.code(502).send({ error: 'EmptyResponse', message: 'GPT вернул пустой ответ' });

    let output: { title: string; full_script: string; b_roll_prompts: Array<{ type: string; prompt: string }> };
    try { output = JSON.parse(raw); } catch {
      return reply.code(502).send({ error: 'InvalidJSON', message: 'GPT вернул невалидный JSON' });
    }

    if (!output.full_script) {
      return reply.code(502).send({ error: 'NoScript', message: 'GPT не сгенерировал скрипт' });
    }

    await audit(req.user.userId, 'pipeline-test.generate-script-layout', 'system', '', req.ip, {
      after: { title: output.title, scriptLength: output.full_script.length, bRollCount: output.b_roll_prompts?.length },
    });

    return reply.send(output);
  });

  // ── Fallback subtitle timing from word count ────────────────────────────
  function _estimateSubtitleTiming(script: string): Array<{ start_sec: number; end_sec: number; text: string }> {
    const words = script.split(/\s+/).filter(Boolean);
    const chunkSize = 12;
    const totalChunks = Math.ceil(words.length / chunkSize);
    const estimatedDuration = words.length / 2.0;  // HeyGen TTS ~2 words/sec for Russian
    const perChunk = estimatedDuration / Math.max(totalChunks, 1);
    const subs: Array<{ start_sec: number; end_sec: number; text: string }> = [];
    for (let c = 0; c < totalChunks; c++) {
      subs.push({
        start_sec: +(c * perChunk).toFixed(2),
        end_sec: +((c + 1) * perChunk).toFixed(2),
        text: words.slice(c * chunkSize, (c + 1) * chunkSize).join(' '),
      });
    }
    return subs;
  }

  // ── Compose layout video ──────────────────────────────────────────────────
  const LayoutComposeBody = z.object({
    avatar_storage_key: z.string().min(1),
    backgrounds: z.array(z.object({
      storage_key: z.string().min(1),
      type: z.enum(['image', 'video']),
    })).min(1),
    layout_template: z.string().min(1),
    with_subtitles: z.boolean().default(true),
    subtitle_style: z.enum(['tiktok', 'cinematic', 'minimal', 'default']).default('tiktok'),
    full_script: z.string().optional(),
    audio_track: z.object({
      storage_key: z.string().min(1),
      volume: z.number().min(0).max(1).default(0.12),
    }).optional(),
  });

  app.post('/pipeline-test/compose-layout', async (req, reply) => {
    let body;
    try {
      body = LayoutComposeBody.parse(req.body);
    } catch (e: any) {
      const issues = e.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? e.message;
      return reply.code(400).send({ error: 'ValidationError', message: `Ошибка валидации: ${issues}` });
    }

    const template = LAYOUT_TEMPLATES[body.layout_template];
    if (!template) {
      return reply.code(400).send({ error: 'BadTemplate', message: `Шаблон "${body.layout_template}" не найден` });
    }

    const testId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();
    const storage = (app as any).storage;
    const vpUrl = config.VIDEO_PROCESSOR_URL;

    // Health check
    try {
      const hc = await fetch(`${vpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!hc.ok) return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: `HTTP ${hc.status}` });
    } catch (e: any) {
      return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: e.message });
    }

    // Map template segments to compose-layout segments.
    // Assign backgrounds round-robin: images for "image" slots, videos for "video" slots.
    const imgBgs = body.backgrounds.filter((b) => b.type === 'image');
    const vidBgs = body.backgrounds.filter((b) => b.type === 'video');

    // Build backgrounds array with dedup
    const allBgs = [...body.backgrounds];
    const segments = template.segments.map((seg, i) => {
      let bgIdx: number;
      if (seg.bg_type === 'image' && imgBgs.length > 0) {
        const bg = imgBgs[i % imgBgs.length];
        bgIdx = allBgs.findIndex((b) => b.storage_key === bg.storage_key);
      } else if (seg.bg_type === 'video' && vidBgs.length > 0) {
        const bg = vidBgs[i % vidBgs.length];
        bgIdx = allBgs.findIndex((b) => b.storage_key === bg.storage_key);
      } else {
        bgIdx = i % allBgs.length;
      }
      return { layout: seg.layout, bg_index: Math.max(0, bgIdx), weight: seg.weight };
    });

    // Build subtitles — use Whisper transcription for accurate timing
    let subtitles: Array<{ start_sec: number; end_sec: number; text: string }> = [];
    if (body.with_subtitles) {
      try {
        const transcribeRes = await fetch(`${vpUrl}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storage_key: body.avatar_storage_key,
            language: 'ru',
            max_words_per_chunk: 12,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (transcribeRes.ok) {
          const transcription = await transcribeRes.json() as {
            subtitles: Array<{ start_sec: number; end_sec: number; text: string }>;
            word_count: number;
            duration_sec: number;
          };
          subtitles = transcription.subtitles;
          req.log.info({ subtitles: subtitles.length, wordCount: transcription.word_count }, 'Whisper transcription OK');
        } else {
          req.log.warn({ status: transcribeRes.status }, 'Whisper transcription failed, falling back to estimate');
          // Fallback to word-count estimation
          if (body.full_script) {
            subtitles = _estimateSubtitleTiming(body.full_script);
          }
        }
      } catch (transcribeErr: any) {
        req.log.warn({ err: transcribeErr.message }, 'Whisper transcription error, falling back to estimate');
        if (body.full_script) {
          subtitles = _estimateSubtitleTiming(body.full_script);
        }
      }
    }

    const outputKey = `test/pipeline/${testId}/layout_${body.layout_template}.mp4`;

    try {
      const composeRes = await fetch(`${vpUrl}/compose-layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: `layout_${testId}`,
          tenant_id: 'system',
          output_key: outputKey,
          avatar_storage_key: body.avatar_storage_key,
          backgrounds: allBgs,
          segments,
          subtitles,
          audio_track: body.audio_track ? {
            storage_key: body.audio_track.storage_key,
            volume: body.audio_track.volume,
            fade_in_sec: 1.5,
            fade_out_sec: 2.0,
          } : undefined,
          settings: { subtitle_style: body.subtitle_style },
          chroma_color: '#00FF00',
          pip_scale: 0.30,
          pip_margin: 30,
          transition: 'fade',
          transition_duration: 0.3,
        }),
        signal: AbortSignal.timeout(600_000),
      });

      if (!composeRes.ok) {
        const errBody = await composeRes.text();
        return reply.code(composeRes.status).send({ error: 'LayoutComposeFailed', message: `video-processor HTTP ${composeRes.status}`, detail: errBody });
      }

      const result = await composeRes.json();
      const outputUrl = await storage.presignedUrl(outputKey, 86400);
      const elapsed = Date.now() - startTime;

      await audit(req.user.userId, 'pipeline-test.compose-layout', 'system', testId, req.ip, {
        after: { template: body.layout_template, segments: segments.length, elapsed },
      });

      return reply.send({
        test_id: testId,
        layout_template: body.layout_template,
        compose_result: result,
        output_url: outputUrl,
        elapsed_ms: elapsed,
      });
    } catch (e: any) {
      return reply.code(500).send({ error: 'LayoutComposeError', message: e.message });
    }
  });

  // ── Pipeline test runs — save / list / load / delete ────────────────────
  const SaveTestRunBody = z.object({
    productName: z.string().min(1),
    prompt: z.string().default(''),
    language: z.string().default('ru'),
    avatarId: z.string().min(1),
    voiceId: z.string().min(1),
    layoutTemplate: z.string().min(1),
    targetDuration: z.number().int().default(30),
    subtitleStyle: z.string().optional(),
    title: z.string().optional(),
    fullScript: z.string().optional(),
    outputUrl: z.string().optional(),
    outputKey: z.string().optional(),
    durationSec: z.number().optional(),
    fileSizeBytes: z.number().int().optional(),
    elapsedMs: z.number().int().optional(),
    params: z.record(z.any()).default({}),
    status: z.enum(['completed', 'failed']).default('completed'),
    error: z.string().optional(),
  });

  app.post('/pipeline-test/runs', async (req, reply) => {
    const body = SaveTestRunBody.parse(req.body);
    const run = await db.pipelineTestRun.create({
      data: {
        createdById: req.user.userId,
        productName: body.productName,
        prompt: body.prompt,
        language: body.language,
        avatarId: body.avatarId,
        voiceId: body.voiceId,
        layoutTemplate: body.layoutTemplate,
        targetDuration: body.targetDuration,
        subtitleStyle: body.subtitleStyle,
        title: body.title,
        fullScript: body.fullScript,
        outputUrl: body.outputUrl,
        outputKey: body.outputKey,
        durationSec: body.durationSec,
        fileSizeBytes: body.fileSizeBytes,
        elapsedMs: body.elapsedMs,
        params: body.params,
        status: body.status,
        error: body.error,
      },
    });
    return reply.send(run);
  });

  app.get('/pipeline-test/runs', async (req, reply) => {
    const { limit = '20', offset = '0' } = req.query as Record<string, string>;
    const [runs, total] = await Promise.all([
      db.pipelineTestRun.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(Number(limit) || 20, 100),
        skip: Number(offset) || 0,
        select: {
          id: true,
          productName: true,
          title: true,
          layoutTemplate: true,
          targetDuration: true,
          outputUrl: true,
          durationSec: true,
          status: true,
          createdAt: true,
          avatarId: true,
          voiceId: true,
        },
      }),
      db.pipelineTestRun.count(),
    ]);
    return reply.send({ data: runs, total });
  });

  app.get('/pipeline-test/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await db.pipelineTestRun.findUnique({ where: { id } });
    if (!run) return reply.code(404).send({ error: 'NotFound', message: 'Тест не найден' });

    // Refresh presigned URLs from params if keys exist
    const storage = (app as any).storage;
    const params = (run.params as any) ?? {};
    if (params.avatarKey) {
      try { params.avatarUrl = await storage.presignedUrl(params.avatarKey, 86400); } catch {}
    }
    if (params.backgrounds) {
      for (const bg of params.backgrounds) {
        if (bg.storage_key) {
          try { bg.url = await storage.presignedUrl(bg.storage_key, 86400); } catch {}
        }
      }
    }
    if (run.outputKey) {
      try { (run as any).outputUrl = await storage.presignedUrl(run.outputKey, 86400); } catch {}
    }
    if (params.bgmKey) {
      try { params.bgmUrl = await storage.presignedUrl(params.bgmKey, 86400); } catch {}
    }

    return reply.send({ ...run, params });
  });

  app.delete('/pipeline-test/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.pipelineTestRun.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // ── TEST COMPOSE ───────────────────────────────────────────────────────────

  const TestComposeBody = z.object({
    preset: z.enum(['dynamic', 'smooth', 'minimal']).default('dynamic'),
    scene_count: z.number().int().min(1).max(6).default(3),
    scene_duration: z.number().min(2).max(15).default(4),
    with_subtitles: z.boolean().default(true),
    scene_keys: z.array(z.string()).optional(),
  });

  // POST /api/v1/admin/test-compose
  app.post('/test-compose', async (req, reply) => {
    const body = TestComposeBody.parse(req.body ?? {});
    const testId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();
    const storage = (app as any).storage;

    // 1. Health check video-processor
    const vpUrl = config.VIDEO_PROCESSOR_URL;
    try {
      const hc = await fetch(`${vpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!hc.ok) {
        return reply.code(502).send({
          error: 'VideoProcessorUnavailable',
          message: `video-processor вернул HTTP ${hc.status}`,
        });
      }
    } catch (e: any) {
      return reply.code(502).send({
        error: 'VideoProcessorUnavailable',
        message: `Не удалось подключиться к video-processor (${vpUrl}): ${e.message}`,
      });
    }

    // 2. Prepare scene assets
    const TEST_COLORS = [
      { r: 220, g:  50, b:  50, label: 'red'    },
      { r:  50, g: 180, b:  80, label: 'green'  },
      { r:  50, g:  80, b: 220, label: 'blue'   },
      { r: 230, g: 180, b:  40, label: 'yellow' },
      { r: 180, g:  50, b: 200, label: 'purple' },
      { r:  40, g: 200, b: 200, label: 'cyan'   },
    ];

    let sceneKeys: string[];

    if (body.scene_keys?.length) {
      sceneKeys = body.scene_keys;
    } else {
      // Generate solid-color PNGs and upload
      sceneKeys = [];
      for (let i = 0; i < body.scene_count; i++) {
        const color = TEST_COLORS[i % TEST_COLORS.length];
        const png = solidPng(540, 960, color.r, color.g, color.b);
        const key = `test/compose/${testId}/scene_${i}_${color.label}.png`;
        await storage.uploadBuffer(key, png, { contentType: 'image/png' });
        sceneKeys.push(key);
      }
      logger.info({ testId, count: sceneKeys.length }, 'Uploaded test images to MinIO');
    }

    // 3. Build compose request
    const PRESET_TRANSITIONS: Record<string, { transition: string; transition_duration: number; subtitle_style: string }> = {
      dynamic: { transition: 'fade',        transition_duration: 0.3,  subtitle_style: 'tiktok'    },
      smooth:  { transition: 'smoothleft',  transition_duration: 0.5,  subtitle_style: 'cinematic' },
      minimal: { transition: 'cut',         transition_duration: 0,    subtitle_style: 'minimal'   },
    };
    const preset = PRESET_TRANSITIONS[body.preset];

    const scenes = sceneKeys.map((key, i) => ({
      scene_id: `test_${testId}_${i}`,
      type: 'image' as const,
      storage_key: key,
      duration_sec: body.scene_duration,
      transition: preset.transition,
      transition_duration: preset.transition_duration,
      ken_burns: 'auto',
    }));

    const subtitles = body.with_subtitles
      ? sceneKeys.map((_, i) => ({
          start_sec: i * body.scene_duration,
          end_sec:   (i + 1) * body.scene_duration,
          text: `Тестовая сцена ${i + 1} — Пресет: ${body.preset}`,
        }))
      : [];

    const outputKey = `test/compose/${testId}/output_${body.preset}.mp4`;

    const composeRequest = {
      job_id:    `test_${testId}`,
      tenant_id: 'test',
      output_key: outputKey,
      scenes,
      subtitles,
      settings: { subtitle_style: preset.subtitle_style },
    };

    // 4. Call video-processor
    logger.info({ testId, preset: body.preset, scenes: scenes.length }, 'Sending test compose request');

    try {
      const composeRes = await fetch(`${vpUrl}/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(composeRequest),
        signal: AbortSignal.timeout(600_000), // 10 min max
      });

      if (!composeRes.ok) {
        const errBody = await composeRes.text();
        logger.error({ testId, status: composeRes.status, body: errBody }, 'Test compose failed');
        return reply.code(composeRes.status).send({
          error: 'ComposeFailed',
          message: `video-processor вернул HTTP ${composeRes.status}`,
          detail: errBody,
        });
      }

      const result = await composeRes.json();

      // 5. Generate presigned URL for the output
      const outputUrl = await storage.presignedUrl(outputKey, 86400);

      const elapsed = Date.now() - startTime;
      logger.info({ testId, elapsed, outputKey }, 'Test compose completed');

      await audit(req.user.userId, 'test-compose', 'system', testId, req.ip, {
        after: { preset: body.preset, scenes: scenes.length, elapsed },
      });

      return reply.send({
        test_id: testId,
        preset: body.preset,
        compose_result: result,
        output_url: outputUrl,
        elapsed_ms: elapsed,
      });
    } catch (e: any) {
      logger.error({ testId, error: e.message }, 'Test compose error');
      return reply.code(500).send({
        error: 'ComposeError',
        message: e.message,
      });
    }
  });
}
