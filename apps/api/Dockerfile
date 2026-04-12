FROM node:22-alpine AS base
RUN npm install -g pnpm@9.15.0
RUN apk add --no-cache python3 make g++ libc6-compat openssl

# ── Зависимости ───────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml turbo.json ./
COPY package.json pnpm-lock.yaml .npmrc* ./
COPY packages/queue/package.json ./packages/queue/
COPY packages/storage/package.json ./packages/storage/
COPY packages/db/package.json ./packages/db/
COPY packages/db/prisma/schema.prisma ./packages/db/prisma/
COPY packages/queue/tsconfig.json ./packages/queue/
COPY packages/storage/tsconfig.json ./packages/storage/
COPY packages/db/tsconfig.json ./packages/db/
COPY apps/api/package.json ./apps/api/
COPY apps/orchestrator/package.json ./apps/orchestrator/
COPY apps/web/package.json ./apps/web/
COPY apps/video-processor/package.json ./apps/video-processor/
RUN pnpm install --frozen-lockfile --filter @kmmzavod/api...

# ── Сборка ────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY packages/ ./packages/
COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json ./apps/api/
COPY tsconfig.base.json ./
RUN pnpm --filter @kmmzavod/db exec prisma generate
RUN pnpm --filter @kmmzavod/queue run build
RUN pnpm --filter @kmmzavod/storage run build
RUN pnpm --filter @kmmzavod/db run build
RUN pnpm --filter @kmmzavod/api build

# ── Продакшн образ ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache openssl
# Копируем только нужное
COPY --from=builder /app/node_modules ./node_modules

# Заменяем симлинки pnpm на реальные директории с compiled dist
# (Docker копирует симлинки как есть — в runner они dangling)
RUN rm -rf ./node_modules/@kmmzavod
COPY --from=builder /app/packages/queue/package.json    ./node_modules/@kmmzavod/queue/package.json
COPY --from=builder /app/packages/queue/dist            ./node_modules/@kmmzavod/queue/dist
COPY --from=builder /app/packages/storage/package.json  ./node_modules/@kmmzavod/storage/package.json
COPY --from=builder /app/packages/storage/dist          ./node_modules/@kmmzavod/storage/dist
COPY --from=builder /app/packages/db/package.json       ./node_modules/@kmmzavod/db/package.json
COPY --from=builder /app/packages/db/dist               ./node_modules/@kmmzavod/db/dist

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/db/prisma/schema.prisma ./packages/db/prisma/schema.prisma
COPY --from=builder /app/packages/db/prisma/migrations ./packages/db/prisma/migrations

# Права безопасности — не root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
