import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { StoragePaths } from '@kmmzavod/storage';

const CreateProductBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  features: z.array(z.string().max(500)).max(20).default([]),
  targetAudience: z.string().max(1000).optional(),
  brandVoice: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  price: z.string().max(100).optional(),
  websiteUrl: z.string().url().max(2000).optional(),
  images: z.array(z.string()).max(10).default([]),
  projectId: z.string().uuid().optional(),
});

const UpdateProductBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  features: z.array(z.string().max(500)).max(20).optional(),
  targetAudience: z.string().max(1000).optional(),
  brandVoice: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  price: z.string().max(100).optional(),
  websiteUrl: z.string().url().max(2000).optional(),
  images: z.array(z.string()).max(10).optional(),
});

const ListProductsQuery = z.object({
  projectId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function productRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // POST /api/v1/products — создать продукт
  app.post('/', async (req, reply) => {
    const body = CreateProductBody.parse(req.body);
    const { tenantId, userId } = req.user;

    if (body.projectId) {
      const project = await db.project.findFirst({
        where: { id: body.projectId, tenantId },
      });
      if (!project) {
        return reply.code(404).send({ error: 'NotFound', message: 'Проект не найден' });
      }
    }

    const product = await db.product.create({
      data: {
        tenantId,
        projectId: body.projectId ?? null,
        createdBy: userId,
        name: body.name,
        description: body.description ?? null,
        features: body.features,
        targetAudience: body.targetAudience ?? null,
        brandVoice: body.brandVoice ?? null,
        category: body.category ?? null,
        price: body.price ?? null,
        websiteUrl: body.websiteUrl ?? null,
        images: body.images,
      },
    });

    return reply.code(201).send(product);
  });

  // GET /api/v1/products — список продуктов
  app.get('/', async (req, reply) => {
    const query = ListProductsQuery.parse(req.query);
    const { tenantId } = req.user;

    const where = {
      tenantId,
      isArchived: false,
      ...(query.projectId && { projectId: query.projectId }),
    };

    const [products, total] = await Promise.all([
      db.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { _count: { select: { videos: true } } },
      }),
      db.product.count({ where }),
    ]);

    return reply.send({
      data: products,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    });
  });

  // GET /api/v1/products/:id — детали продукта
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const product = await db.product.findFirst({
      where: { id, tenantId },
      include: {
        videos: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            title: true,
            status: true,
            thumbnailUrl: true,
            durationSec: true,
            createdAt: true,
          },
        },
      },
    });

    if (!product) {
      return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
    }

    return reply.send(product);
  });

  // PATCH /api/v1/products/:id — обновить продукт
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = UpdateProductBody.parse(req.body);
    const { tenantId } = req.user;

    const existing = await db.product.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
    }

    const product = await db.product.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.features !== undefined && { features: body.features }),
        ...(body.targetAudience !== undefined && { targetAudience: body.targetAudience }),
        ...(body.brandVoice !== undefined && { brandVoice: body.brandVoice }),
        ...(body.category !== undefined && { category: body.category }),
        ...(body.price !== undefined && { price: body.price }),
        ...(body.websiteUrl !== undefined && { websiteUrl: body.websiteUrl }),
        ...(body.images !== undefined && { images: body.images }),
      },
    });

    return reply.send(product);
  });

  // DELETE /api/v1/products/:id — удалить (архивировать) продукт
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const product = await db.product.findFirst({ where: { id, tenantId } });
    if (!product) {
      return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
    }

    await db.product.update({ where: { id }, data: { isArchived: true } });

    return reply.code(204).send();
  });

  // POST /api/v1/products/upload — загрузить изображение продукта
  app.post('/upload', async (req, reply) => {
    const { tenantId } = req.user;
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Файл не передан' });
    }

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Допустимые форматы: JPEG, PNG, WebP, GIF' });
    }

    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      size += chunk.length;
      if (size > MAX_SIZE) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Максимальный размер файла — 10 МБ' });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const assetId = randomUUID();
    const ext = file.filename.split('.').pop() ?? 'jpg';
    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5);
    const key = StoragePaths.asset(tenantId, assetId, `product.${safeExt}`);

    await req.server.storage.uploadBuffer(key, buffer, { contentType: file.mimetype });
    const url = await req.server.storage.presignedUrl(key, 86400);

    return reply.send({ key, url });
  });

  // GET /api/v1/products/:id/image-preview — получить presigned URL для изображения продукта
  app.get('/:id/image-preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { key } = req.query as { key?: string };
    const { tenantId } = req.user;

    if (!key || typeof key !== 'string') {
      return reply.code(400).send({ error: 'BadRequest', message: 'Параметр key обязателен' });
    }

    const product = await db.product.findFirst({ where: { id, tenantId } });
    if (!product) {
      return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
    }

    // Verify the key belongs to this product
    if (!product.images.includes(key)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Изображение не принадлежит продукту' });
    }

    const url = await req.server.storage.presignedUrl(key, 3600);
    return reply.redirect(url);
  });

  // POST /api/v1/products/scrape-wb — скрапинг товара с Wildberries по ссылке
  app.post('/scrape-wb', async (req, reply) => {
    const body = z.object({ url: z.string().min(1) }).parse(req.body);

    // Извлекаем артикул из URL или чистого числа
    const stripped = body.url.trim();
    const articleMatch = stripped.match(/(?:catalog\/|nm=)(\d+)/);
    const directNum = /^\d{5,15}$/.test(stripped) ? stripped : null;
    const articleId = articleMatch?.[1] ?? directNum;
    if (!articleId) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Не удалось извлечь артикул из ссылки. Пример: https://www.wildberries.ru/catalog/310531916/detail.aspx' });
    }

    // SSRF protection
    if (stripped.startsWith('http')) {
      try {
        const parsed = new URL(stripped);
        if (!parsed.hostname.endsWith('wildberries.ru')) {
          return reply.code(400).send({ error: 'BadRequest', message: 'Поддерживаются только ссылки с wildberries.ru' });
        }
      } catch {
        return reply.code(400).send({ error: 'BadRequest', message: 'Некорректная ссылка' });
      }
    }

    const fetchWithTimeout = async (url: string, timeoutMs = 15000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': '*/*',
          },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const nmId = Number(articleId);
      const vol = Math.floor(nmId / 100000);
      const part = Math.floor(nmId / 1000);
      const basketNum = getWbBasket(vol);
      const basePath = `https://basket-${basketNum}.wbbasket.ru/vol${vol}/part${part}/${articleId}`;

      // ── 1. Карточка товара с basket CDN ───────────────────────────────────
      const cardRes = await fetchWithTimeout(`${basePath}/info/ru/card.json`);
      if (!cardRes.ok) {
        return reply.code(404).send({ error: 'NotFound', message: 'Товар не найден на Wildberries' });
      }
      const card = await cardRes.json() as any;

      const name = card.imt_name ?? '';
      const brand = card.selling?.brand_name ?? '';
      const description = card.description ?? '';

      // Характеристики из options
      let characteristics: string[] = [];
      if (Array.isArray(card.options)) {
        characteristics = card.options
          .filter((o: any) => o.name && o.value)
          .map((o: any) => `${o.name}: ${o.value}`)
          .slice(0, 20);
      }

      // ── 2. Цена из price-history ──────────────────────────────────────────
      let priceRub: number | null = null;
      try {
        const priceRes = await fetchWithTimeout(`${basePath}/info/price-history.json`);
        if (priceRes.ok) {
          const priceHistory = await priceRes.json() as any[];
          if (priceHistory.length > 0) {
            const latest = priceHistory[priceHistory.length - 1];
            const kopecks = latest?.price?.RUB;
            if (typeof kopecks === 'number') {
              priceRub = Math.round(kopecks / 100);
            }
          }
        }
      } catch {
        // Цена недоступна — не критично
      }

      // ── 3. URL-ы изображений ──────────────────────────────────────────────
      const photoCount = card.media?.photo_count ?? 3;
      const imageUrls: string[] = [];
      for (let i = 1; i <= Math.min(photoCount, 5); i++) {
        imageUrls.push(`${basePath}/images/big/${i}.webp`);
      }

      return reply.send({
        articleId,
        name: brand ? `${brand} — ${name}` : name,
        description,
        price: priceRub ? `${priceRub.toLocaleString('ru-RU')} ₽` : null,
        brand,
        characteristics,
        imageUrls,
        sourceUrl: `https://www.wildberries.ru/catalog/${articleId}/detail.aspx`,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return reply.code(504).send({ error: 'Timeout', message: 'Wildberries не ответил за 15 секунд' });
      }
      app.log.error({ err: err.message, articleId }, 'WB scrape failed');
      return reply.code(502).send({ error: 'UpstreamError', message: 'Ошибка при загрузке данных с Wildberries' });
    }
  });
}

// Определение basket-сервера WB по volume (обновлено 2025)
function getWbBasket(vol: number): string {
  if (vol <= 143) return '01';
  if (vol <= 287) return '02';
  if (vol <= 431) return '03';
  if (vol <= 719) return '04';
  if (vol <= 1007) return '05';
  if (vol <= 1061) return '06';
  if (vol <= 1115) return '07';
  if (vol <= 1169) return '08';
  if (vol <= 1313) return '09';
  if (vol <= 1601) return '10';
  if (vol <= 1655) return '11';
  if (vol <= 1919) return '12';
  if (vol <= 2045) return '13';
  if (vol <= 2189) return '14';
  if (vol <= 2405) return '15';
  if (vol <= 2621) return '16';
  if (vol <= 2837) return '17';
  if (vol <= 3053) return '18';
  if (vol <= 3269) return '19';
  if (vol <= 3485) return '20';
  if (vol <= 3701) return '21';
  if (vol <= 3917) return '22';
  if (vol <= 4133) return '23';
  if (vol <= 4349) return '24';
  if (vol <= 4565) return '25';
  if (vol <= 4781) return '26';
  return '27';
}
