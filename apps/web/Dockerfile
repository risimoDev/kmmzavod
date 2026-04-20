FROM node:22-alpine AS base
RUN npm install -g pnpm@9.15.0
RUN apk add --no-cache python3 make g++ libc6-compat openssl

# ── Dependencies ───────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml turbo.json ./
COPY package.json pnpm-lock.yaml .npmrc* ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/orchestrator/package.json ./apps/orchestrator/
COPY apps/video-processor/package.json ./apps/video-processor/
COPY packages/queue/package.json ./packages/queue/
COPY packages/storage/package.json ./packages/storage/
COPY packages/db/package.json ./packages/db/
COPY packages/db/prisma/schema.prisma ./packages/db/prisma/
RUN pnpm install --frozen-lockfile --filter @kmmzavod/web

# ── Builder ────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY apps/web ./apps/web
COPY tsconfig.base.json ./

ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ARG DOCKER_BUILD=1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV DOCKER_BUILD=$DOCKER_BUILD
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @kmmzavod/web build

# ── Runner ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

RUN mkdir -p ./apps/web/public
COPY --from=builder /app/apps/web/public/       ./apps/web/public/
COPY --from=builder --chown=appuser:appgroup /app/apps/web/.next/standalone ./
COPY --from=builder --chown=appuser:appgroup /app/apps/web/.next/static ./apps/web/.next/static

USER appuser

EXPOSE 3001

ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3001/ || exit 1

CMD ["node", "apps/web/server.js"]
