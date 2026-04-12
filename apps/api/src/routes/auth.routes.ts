import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { logger } from '../logger';

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(2).max(100).optional(),
  tenantName: z.string().min(2).max(100),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

const RefreshBody = z.object({
  refreshToken: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  // POST /api/v1/auth/register
  app.post('/register', async (req, reply) => {
    const body = RegisterBody.parse(req.body);

    const existing = await db.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email уже используется' });
    }

    const slug = body.tenantName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 50);

    const uniqueSlug = `${slug}-${Date.now().toString(36)}`;

    const passwordHash = await bcrypt.hash(body.password, 12);

    const tenant = await db.tenant.create({
      data: {
        name: body.tenantName,
        slug: uniqueSlug,
        credits: 0, // кредиты начисляются после выбора тарифа
        users: {
          create: {
            email: body.email,
            passwordHash,
            role: 'owner',
            displayName: body.displayName ?? body.email.split('@')[0],
            emailVerifiedAt: null,
          },
        },
      },
      include: { users: true },
    });

    const user = tenant.users[0]!;
    const tokens = generateTokens(app, user, tenant.id);

    await saveRefreshToken(user.id, tokens.refreshToken, req);

    logger.info({ userId: user.id, tenantId: tenant.id }, 'New user registered');

    return reply.code(201).send({
      user: { id: user.id, email: user.email, role: user.role, platformRole: user.platformRole },
      tenant: { id: tenant.id, slug: tenant.slug },
      ...tokens,
    });
  });

  // POST /api/v1/auth/login
  app.post('/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);

    const user = await db.user.findUnique({
      where: { email: body.email },
      include: { tenant: { select: { id: true, slug: true, plan: true, isActive: true } } },
    });

    if (!user || !user.passwordHash) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Неверный email или пароль' });
    }

    if (!user.isActive) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Аккаунт заблокирован' });
    }

    if (!user.tenant.isActive) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Организация заблокирована' });
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Неверный email или пароль' });
    }

    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = generateTokens(app, user, user.tenant.id);
    await saveRefreshToken(user.id, tokens.refreshToken, req);

    logger.info({ userId: user.id, tenantId: user.tenantId }, 'User logged in');

    return reply.send({
      user: { id: user.id, email: user.email, role: user.role, platformRole: user.platformRole, displayName: user.displayName },
      tenant: { id: user.tenant.id, slug: user.tenant.slug, plan: user.tenant.plan },
      ...tokens,
    });
  });

  // POST /api/v1/auth/refresh
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = RefreshBody.parse(req.body);

    const session = await db.userSession.findUnique({
      where: { refreshToken },
      include: {
        user: {
          include: { tenant: { select: { id: true, isActive: true } } },
        },
      },
    });

    if (!session || session.expiresAt < new Date()) {
      await db.userSession.deleteMany({ where: { refreshToken } });
      return reply.code(401).send({ error: 'Unauthorized', message: 'Refresh token невалиден' });
    }

    if (!session.user.isActive || !session.user.tenant.isActive) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Аккаунт заблокирован' });
    }

    // Ротация: удаляем старый, выдаём новый
    await db.userSession.delete({ where: { id: session.id } });
    const tokens = generateTokens(app, session.user, session.user.tenant.id);
    await saveRefreshToken(session.user.id, tokens.refreshToken, req);

    return reply.send(tokens);
  });

  // POST /api/v1/auth/logout
  app.post('/logout', { preHandler: app.authenticate }, async (req, reply) => {
    const { refreshToken } = RefreshBody.parse(req.body);
    await db.userSession.deleteMany({
      where: { refreshToken, userId: req.user.userId },
    });
    return reply.code(204).send();
  });
}

// ─── helpers ───────────────────────────────────────────────────────────────

function generateTokens(
  app: FastifyInstance,
  user: { id: string; email: string; role: string; platformRole: string },
  tenantId: string
) {
  const payload = {
    userId: user.id,
    tenantId,
    email: user.email,
    role: user.role as 'owner' | 'admin' | 'member' | 'viewer',
    platformRole: user.platformRole as 'super_admin' | 'user',
  };

  const accessToken = app.jwt.sign(payload, { expiresIn: '15m' });
  const refreshToken = app.jwt.sign({ ...payload, type: 'refresh' } as any, { expiresIn: '30d' });

  return { accessToken, refreshToken };
}

async function saveRefreshToken(userId: string, refreshToken: string, req?: { ip?: string; headers?: Record<string, string | string[] | undefined> }) {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.userSession.create({
    data: {
      userId,
      refreshToken,
      expiresAt,
      ipAddress: req?.ip,
      userAgent: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : undefined,
    },
  });
}
