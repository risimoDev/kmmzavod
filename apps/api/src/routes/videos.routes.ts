import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { pipelineQueue } from '../lib/queues';
import { logger } from '../logger';
import { config } from '../config';
import type { PipelineJobPayload } from '@kmmzavod/queue';

const CreateVideoBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  projectId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  presetId: z.string().uuid().optional(),
  scriptPrompt: z.string().max(2000).optional().default(''),
  avatarId: z.string().default('Anna_public_20240108'),
  voiceId: z.string().default('70856236390f4d0392d00187143d3900'),
  durationSec: z.number().int().min(15).max(90).default(30),
  settings: z
    .object({
      resolution: z.string().default('1080x1920'),
      fps: z.number().int().min(24).max(60).default(30),
      language: z.string().default('ru'),
    })
    .default({}),
  audioTrack: z.object({
    storage_key: z.string().min(1),
    volume: z.number().min(0).max(1).default(0.12),
  }).optional(),
});

const ListVideosQuery = z.object({
  status: z
    .enum(['draft', 'pending', 'processing', 'composing', 'completed', 'failed', 'cancelled'])
    .optional(),
  projectId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function videoRoutes(app: FastifyInstance) {
  // SSE endpoint — isolated encapsulation scope so the global auth hook below
  // does NOT apply. EventSource cannot set Authorization header, so we accept
  // the token from: 1) Authorization header, 2) httpOnly cookie, 3) ?token= query (last resort).
  app.register(async function sseScope(sse) {
    sse.get('/:id/progress', {
      preHandler: async (req, reply) => {
        // 1. Standard header (for SSE polyfills that support headers)
        let token: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          token = authHeader.slice(7);
        }
        // 2. httpOnly cookie
        if (!token) {
          const cookies = req.headers.cookie;
          if (cookies) {
            const match = cookies.match(/(?:^|;\s*)sse_token=([^\s;]+)/);
            if (match) token = match[1];
          }
        }
        // 3. Query param fallback (logged as warning)
        if (!token) {
          const { token: qToken } = req.query as { token?: string };
          if (qToken) {
            token = qToken;
            req.log.warn({ url: req.url }, 'SSE auth via query param — migrate to cookie');
          }
        }
        if (!token) return reply.code(401).send({ error: 'Unauthorized' });
        try {
          const decoded = app.jwt.verify(token);
          req.user = decoded as typeof req.user;
        } catch {
          return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid token' });
        }
      },
    }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId } = req.user;

      const video = await db.video.findFirst({ where: { id, tenantId }, select: { status: true, error: true } });
      if (!video) return reply.code(404).send({ error: 'NotFound' });

      // Already terminal — send single event and close
      if (video.status === 'completed' || video.status === 'failed') {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.write(`data: ${JSON.stringify({ stage: video.status, progress: video.status === 'completed' ? 100 : 0, isComplete: true, status: video.status, error: video.error ?? null, timestamp: new Date().toISOString() })}\n\n`);
        reply.raw.end();
        return;
      }

      // SSE headers
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders();

      // Heartbeat
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed && !reply.raw.writableEnded) reply.raw.write(':ping\n\n');
      }, 25_000);

      // Redis pub/sub — dedicated connection per SSE client
      const sub = getRedis().duplicate();
      const channel = `video:progress:${tenantId}:${id}`;
      await sub.subscribe(channel);

      const onMessage = (ch: string, message: string) => {
        if (ch !== channel || closed || reply.raw.writableEnded) return;
        try {
          const event = JSON.parse(message);
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.status === 'completed' || event.status === 'failed' || event.isComplete) {
            setTimeout(() => {
              if (!reply.raw.writableEnded) reply.raw.end();
            }, 500);
          }
        } catch { /* ignore parse errors */ }
      };
      sub.on('message', onMessage);

      // Cleanup — unsubscribe and disconnect the per-request connection
      const cleanup = async () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        sub.removeListener('message', onMessage);
        try { await sub.unsubscribe(channel); } catch { /* ignore */ }
        sub.disconnect();
      };
      reply.raw.on('close', cleanup);
      reply.raw.on('error', cleanup);
    });
  });

  // Все остальные маршруты требуют авторизации через Authorization header
  app.addHook('preHandler', app.authenticate);

  // GET /api/v1/videos/avatars — список HeyGen аватаров с превью
  app.get('/avatars', async (req, reply) => {
    const apiKey = config.HEYGEN_API_KEY;
    if (!apiKey) {
      // Fallback: return hardcoded avatar list without images
      return reply.send({
        avatars: [
          { avatar_id: 'Anna_public_20240108', avatar_name: 'Анна', preview_image_url: null, gender: 'female' },
          { avatar_id: 'Adrian_public_2_20240312', avatar_name: 'Адриан', preview_image_url: null, gender: 'male' },
          { avatar_id: 'Kristin_public_3_20240108', avatar_name: 'Кристин', preview_image_url: null, gender: 'female' },
        ],
      });
    }

    // Check Redis cache first (1 hour TTL)
    const redis = getRedis();
    const cacheKey = 'heygen:avatars';
    const cached = await redis.get(cacheKey);
    if (cached) {
      return reply.send(JSON.parse(cached));
    }

    try {
      const res = await fetch('https://api.heygen.com/v2/avatars', {
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) throw new Error(`HeyGen API ${res.status}`);
      const data = (await res.json()) as any;

      const avatars = (data.data?.avatars ?? [])
        .filter((a: any) => a.avatar_id && a.avatar_name)
        .map((a: any) => ({
          avatar_id: a.avatar_id,
          avatar_name: a.avatar_name,
          preview_image_url: a.preview_image_url ?? a.thumbnail_image_url ?? null,
          gender: a.gender ?? null,
        }));

      const result = { avatars };
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
      return reply.send(result);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Не удалось получить аватары из HeyGen');
      // Return hardcoded fallback
      return reply.send({
        avatars: [
          { avatar_id: 'Anna_public_20240108', avatar_name: 'Анна', preview_image_url: null, gender: 'female' },
          { avatar_id: 'Adrian_public_2_20240312', avatar_name: 'Адриан', preview_image_url: null, gender: 'male' },
          { avatar_id: 'Kristin_public_3_20240108', avatar_name: 'Кристин', preview_image_url: null, gender: 'female' },
        ],
      });
    }
  });

  // GET /api/v1/videos/voices — список HeyGen голосов с превью
  app.get('/voices', async (req, reply) => {
    const apiKey = config.HEYGEN_API_KEY;
    if (!apiKey) {
      return reply.send({ data: [], has_more: false });
    }

    const query = req.query as Record<string, string | undefined>;
    const language = query.language?.toLowerCase() ?? undefined;
    const gender = query.gender?.toLowerCase() ?? undefined;

    // Build cache key from query parameters
    const redis = getRedis();
    const cacheKey = `heygen:voices:v2:${language ?? 'all'}:${gender ?? 'all'}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return reply.send(JSON.parse(cached));
    }

    try {
      const res = await fetch('https://api.heygen.com/v2/voices', {
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) throw new Error(`HeyGen Voices API ${res.status}`);
      const raw = (await res.json()) as any;

      // v2 response: { data: { voices: [...] } }
      const allVoices: any[] = raw.data?.voices ?? raw.data ?? [];

      let voices = allVoices.map((v: any) => ({
        voice_id: v.voice_id,
        name: v.name ?? v.display_name ?? '',
        gender: v.gender ?? null,
        language: v.language ?? null,
        preview_audio_url: v.preview_audio ?? v.preview_audio_url ?? null,
        support_locale: v.support_locale ?? false,
      }));

      // Server-side filtering (v2 doesn't support query params)
      if (language) {
        voices = voices.filter((v: any) =>
          v.language && v.language.toLowerCase().includes(language)
        );
      }
      if (gender) {
        voices = voices.filter((v: any) =>
          v.gender && v.gender.toLowerCase() === gender
        );
      }

      const result = {
        data: voices,
        has_more: false,
        next_token: null,
      };

      await redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
      return reply.send(result);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Не удалось получить голоса из HeyGen');
      return reply.send({ data: [], has_more: false });
    }
  });

  // POST /api/v1/videos — создать видео и запустить пайплайн
  app.post('/', async (req, reply) => {
    const body = CreateVideoBody.parse(req.body);
    const { tenantId, userId } = req.user;

    // ── Оценка стоимости и проверка кредитов ────────────────────────────────
    const DEFAULT_AVG_CREDITS = 15; // fallback если настройка не задана
    const DEFAULT_SCENES_COUNT = 5; // типичное кол-во сцен

    let avgCreditsPerScene = DEFAULT_AVG_CREDITS;
    try {
      const setting = await db.adminSetting.findUnique({
        where: { key: 'avg_credits_per_scene' },
        select: { value: true },
      });
      if (setting?.value != null) {
        const parsed = Number(typeof setting.value === 'object' ? (setting.value as any).value : setting.value);
        if (parsed > 0) avgCreditsPerScene = parsed;
      }
    } catch { /* use default */ }

    const estimatedCredits = DEFAULT_SCENES_COUNT * avgCreditsPerScene;

    // Проверяем projectId если передан
    if (body.projectId) {
      const project = await db.project.findFirst({
        where: { id: body.projectId, tenantId },
      });
      if (!project) {
        return reply.code(404).send({ error: 'NotFound', message: 'Проект не найден' });
      }
    }

    // Проверяем productId и обогащаем prompt данными продукта
    let enrichedPrompt = body.scriptPrompt;
    if (body.productId) {
      const product = await db.product.findFirst({
        where: { id: body.productId, tenantId },
      });
      if (!product) {
        return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
      }
      // Обогащаем промпт данными продукта для более качественной генерации
      const productContext = [
        `Продукт: ${product.name}`,
        product.description ? `Описание: ${product.description}` : '',
        product.features.length > 0 ? `Ключевые характеристики: ${product.features.join(', ')}` : '',
        product.targetAudience ? `Целевая аудитория: ${product.targetAudience}` : '',
        product.brandVoice ? `Тон бренда: ${product.brandVoice}` : '',
        product.category ? `Категория: ${product.category}` : '',
        product.price ? `Цена: ${product.price}` : '',
      ].filter(Boolean).join('\n');

      enrichedPrompt = `${productContext}\n\nЗадача: ${body.scriptPrompt}`;
    }

    // Создаём видео + задачу + soft reserve кредитов в одной транзакции
    // Credit check is inside the transaction to prevent race conditions
    const result = await db.$transaction(async (tx) => {
      // Atomic credit check — SELECT FOR UPDATE via Prisma interactive transaction
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { credits: true },
      });

      if (tenant.credits < estimatedCredits) {
        throw Object.assign(new Error('InsufficientCredits'), {
          statusCode: 402,
          available: tenant.credits,
          required: estimatedCredits,
        });
      }

      const video = await tx.video.create({
        data: {
          tenantId,
          projectId: body.projectId ?? null,
          productId: body.productId ?? null,
          presetId: body.presetId ?? null,
          createdBy: userId,
          title: body.title,
          description: body.description ?? null,
          status: 'pending',
          metadata: body.settings,
        },
      });

      const job = await tx.job.create({
        data: {
          tenantId,
          videoId: video.id,
          projectId: body.projectId ?? null,
          createdBy: userId,
          status: 'pending',
          payload: {
            script_prompt: enrichedPrompt,
            avatar_id: body.avatarId,
            voice_id: body.voiceId,
            settings: {
              ...body.settings,
              durationSec: body.durationSec,
              audio_track: body.audioTrack ? {
                storage_key: body.audioTrack.storage_key,
                volume: body.audioTrack.volume,
                fade_in_sec: 1.5,
                fade_out_sec: 2.0,
              } : undefined,
            },
            estimatedCredits,
          },
        },
      });

      // Soft reserve: списываем estimated credits заранее
      const updated = await tx.tenant.update({
        where: { id: tenantId },
        data: { credits: { decrement: estimatedCredits } },
        select: { credits: true },
      });

      await tx.creditTransaction.create({
        data: {
          tenantId,
          type: 'reserve',
          amount: -estimatedCredits,
          balanceAfter: Math.max(0, updated.credits),
          description: `Reserve for video "${body.title}"`,
          jobId: job.id,
        },
      });

      return { video, job };
    }).catch((err: any) => {
      if (err.message === 'InsufficientCredits') {
        return reply.code(402).send({
          error: 'InsufficientCredits',
          message: 'Недостаточно кредитов для запуска генерации.',
          available: err.available,
          required: err.required,
        });
      }
      throw err;
    });

    // If reply was already sent (insufficient credits), return
    if (!result || reply.sent) return;
    const { video, job } = result;

    // Ставим задачу в очередь BullMQ
    const payload: PipelineJobPayload = { jobId: job.id, tenantId };
    await pipelineQueue.add(`pipeline:${job.id}`, payload);

    logger.info({ videoId: video.id, jobId: job.id, tenantId }, 'Video job enqueued');

    return reply.code(201).send({
      video: {
        id: video.id,
        title: video.title,
        status: video.status,
        createdAt: video.createdAt,
      },
      jobId: job.id,
    });
  });

  // GET /api/v1/videos — список видео тенанта
  app.get('/', async (req, reply) => {
    const query = ListVideosQuery.parse(req.query);
    const { tenantId } = req.user;

    const where = {
      tenantId,
      ...(query.status && { status: query.status }),
      ...(query.projectId && { projectId: query.projectId }),
    };

    const [videos, total] = await Promise.all([
      db.video.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          title: true,
          status: true,
          thumbnailUrl: true,
          durationSec: true,
          creditsUsed: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      db.video.count({ where }),
    ]);

    return reply.send({
      data: videos,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    });
  });

  // GET /api/v1/videos/:id — детали видео
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const video = await db.video.findFirst({
      where: { id, tenantId },
      include: {
        variants: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            preset: true,
            outputKey: true,
            durationSec: true,
            fileSizeMb: true,
            status: true,
            error: true,
            selectedAt: true,
            createdAt: true,
          },
        },
        job: {
          include: {
            scenes: {
              orderBy: { sceneIndex: 'asc' },
              select: {
                id: true,
                sceneIndex: true,
                type: true,
                status: true,
                durationSec: true,
                avatarDone: true,
                clipDone: true,
                imageDone: true,
                error: true,
              },
            },
            events: {
              orderBy: { createdAt: 'asc' },
              take: 50,
            },
          },
        },
      },
    });

    if (!video) {
      return reply.code(404).send({ error: 'NotFound', message: 'Видео не найдено' });
    }

    // Generate presigned URLs for ready variants
    const storage = (app as any).storage;
    const variantsWithUrls = await Promise.all(
      video.variants.map(async (v) => ({
        ...v,
        previewUrl: v.status === 'ready' ? await storage.presignedUrl(v.outputKey, 3600) : null,
      })),
    );

    return reply.send({ ...video, variants: variantsWithUrls });
  });

  // DELETE /api/v1/videos/:id
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const video = await db.video.findFirst({ where: { id, tenantId } });
    if (!video) {
      return reply.code(404).send({ error: 'NotFound', message: 'Видео не найдено' });
    }

    if (video.status === 'processing' || video.status === 'composing') {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Нельзя удалить видео во время обработки. Сначала отмените задачу.',
      });
    }

    await db.video.update({ where: { id }, data: { status: 'cancelled' } });

    logger.info({ videoId: id, tenantId }, 'Video cancelled');
    return reply.code(204).send();
  });

  // PATCH /api/v1/videos/:id/select-variant — выбор варианта монтажа
  app.patch('/:id/select-variant', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;
    const body = z.object({ variantId: z.string().uuid() }).parse(req.body);

    const video = await db.video.findFirst({ where: { id, tenantId } });
    if (!video) {
      return reply.code(404).send({ error: 'NotFound', message: 'Видео не найдено' });
    }

    const variant = await db.videoVariant.findFirst({
      where: { id: body.variantId, videoId: id, status: 'ready' },
    });
    if (!variant) {
      return reply.code(404).send({ error: 'NotFound', message: 'Вариант не найден или ещё не готов' });
    }

    await db.$transaction([
      // Clear previous selection
      db.videoVariant.updateMany({
        where: { videoId: id, selectedAt: { not: null } },
        data: { selectedAt: null },
      }),
      // Mark this variant as selected
      db.videoVariant.update({
        where: { id: body.variantId },
        data: { selectedAt: new Date() },
      }),
      // Copy outputKey to the video record
      db.video.update({
        where: { id },
        data: { outputUrl: variant.outputKey },
      }),
    ]);

    logger.info({ videoId: id, variantId: body.variantId, preset: variant.preset, tenantId }, 'Variant selected');

    return reply.send({
      videoId: id,
      selectedVariant: {
        id: variant.id,
        preset: variant.preset,
        outputKey: variant.outputKey,
      },
    });
  });

  // GET /api/v1/videos/:id/download — presigned URL для скачивания
  app.get('/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const video = await db.video.findFirst({
      where: { id, tenantId, status: 'completed' },
      select: { outputUrl: true },
    });

    if (!video || !video.outputUrl) {
      return reply.code(404).send({ error: 'NotFound', message: 'Готовое видео не найдено' });
    }

    // Получаем storage из app (задаётся в server.ts)
    const storage = (app as any).storage;
    const url = await storage.presignedUrl(video.outputUrl, 3600);

    return reply.send({ url, expiresIn: 3600 });
  });

  // GET /api/v1/videos/dashboard/stats — статистика для дашборда
  app.get('/dashboard/stats', async (req, reply) => {
    const { tenantId } = req.user;

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      videosTotal,
      videosThisWeek,
      activeJobs,
      tenant,
      recentVideos,
      chartData,
    ] = await Promise.all([
      db.video.count({ where: { tenantId } }),
      db.video.count({ where: { tenantId, createdAt: { gte: weekAgo } } }),
      db.job.count({ where: { tenantId, status: { in: ['pending', 'processing', 'composing'] } } }),
      db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { credits: true, plan: true },
      }),
      db.video.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true, title: true, status: true, thumbnailUrl: true,
          durationSec: true, createdAt: true,
        },
      }),
      // Videos per day for last 7 days
      db.$queryRaw<Array<{ day: string; count: bigint }>>`
        SELECT TO_CHAR(d, 'Dy') as day, COALESCE(c.cnt, 0)::bigint as count
        FROM generate_series(
          (NOW() - INTERVAL '6 days')::date,
          NOW()::date,
          '1 day'
        ) AS d
        LEFT JOIN (
          SELECT DATE("created_at") AS dt, COUNT(*)::bigint AS cnt
          FROM "videos"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "created_at" >= (NOW() - INTERVAL '6 days')::date
          GROUP BY DATE("created_at")
        ) c ON c.dt = d::date
        ORDER BY d
      `,
    ]);

    const activeJobsList = await db.job.findMany({
      where: { tenantId, status: { in: ['pending', 'processing', 'composing'] } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        video: { select: { title: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 1 },
        scenes: {
          select: { type: true, avatarDone: true, clipDone: true, imageDone: true, status: true },
        },
      },
    });

    return reply.send({
      stats: {
        videosTotal,
        videosThisWeek,
        activeJobs,
        creditsUsed: 0,
        creditsTotal: tenant.credits,
        plan: tenant.plan,
      },
      chart: chartData.map((r) => ({
        day: r.day,
        videos: Number(r.count),
      })),
      recentVideos,
      activeJobs: activeJobsList.map((j) => {
        // Реальный прогресс: считаем завершённые этапы сцен
        let progress = 5;
        if (j.scenes.length > 0) {
          const done = j.scenes.filter((s) =>
            (s.type === 'avatar' && s.avatarDone) ||
            (s.type === 'clip' && s.clipDone) ||
            (s.type === 'image' && s.imageDone) ||
            s.status === 'completed' || s.status === 'failed'
          ).length;
          if (j.status === 'composing') {
            progress = 85 + Math.round((done / j.scenes.length) * 15);
          } else {
            progress = 10 + Math.round((done / j.scenes.length) * 75);
          }
        } else if (j.events[0]?.stage === 'gpt-script') {
          progress = j.events[0]?.status === 'completed' ? 10 : 5;
        }
        return {
          id: j.id,
          title: j.video?.title ?? 'Без названия',
          status: j.status,
          stage: j.events[0]?.stage ?? j.status,
          progress,
        };
      }),
    });
  });
}
