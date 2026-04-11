FROM node:22-alpine AS base
RUN npm install -g pnpm@9.15.0

# ── Зависимости ───────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml turbo.json ./
COPY package.json pnpm-lock.yaml .npmrc* ./
COPY packages/queue/package.json ./packages/queue/
COPY packages/storage/package.json ./packages/storage/
COPY packages/db/package.json ./packages/db/
COPY apps/orchestrator/package.json ./apps/orchestrator/
RUN pnpm install --frozen-lockfile --filter @kmmzavod/orchestrator...

# ── Сборка ────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY packages/ ./packages/
COPY apps/orchestrator/src ./apps/orchestrator/src
COPY apps/orchestrator/tsconfig.json ./apps/orchestrator/
COPY tsconfig.base.json ./
RUN pnpm --filter @kmmzavod/db exec prisma generate
RUN pnpm --filter @kmmzavod/orchestrator build

# ── Продакшн образ ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/orchestrator/dist ./apps/orchestrator/dist
COPY --from=builder /app/apps/orchestrator/package.json ./apps/orchestrator/

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "const R=require('ioredis');const r=new R({host:process.env.REDIS_HOST||'localhost',port:parseInt(process.env.REDIS_PORT||'6379'),password:process.env.REDIS_PASSWORD});r.ping().then(()=>{r.disconnect();process.exit(0)}).catch(()=>process.exit(1))"

CMD ["node", "apps/orchestrator/dist/index.js"]
