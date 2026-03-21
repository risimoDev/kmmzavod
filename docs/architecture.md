# AI Content Factory — Production Architecture

## 1. Full Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            CLIENT LAYER                                      │
│   Next.js Web App (User)       │       Next.js Admin Panel                   │
└────────────────────┬───────────────────────────┬────────────────────────────┘
                     │ HTTPS/REST                 │ HTTPS/REST
┌────────────────────▼───────────────────────────▼────────────────────────────┐
│                       API GATEWAY  (Fastify + TypeScript)                    │
│                                                                              │
│   JWT Auth Middleware  │  Tenant Extraction  │  Rate Limiter (per tenant)    │
│   POST /api/v1/projects/{id}/jobs  → enqueue pipeline job                   │
│   GET  /api/v1/jobs/{id}/status    → poll job state                         │
│   POST /api/v1/admin/jobs/{id}/retry                                         │
│   GET  /api/v1/admin/tenants                                                 │
└──────────────────────┬────────────────────────────────┬─────────────────────┘
                       │                                │
              Enqueue Job                         Read / Write
                       │                                │
┌──────────────────────▼──────────┐    ┌───────────────▼──────────────────────┐
│         REDIS (BullMQ)          │    │     PostgreSQL  (primary store)       │
│                                 │    │                                       │
│  queue: pipeline              ◄─┼────┤  tenants, users, projects            │
│  queue: gpt-script              │    │  jobs, job_events (audit log)        │
│  queue: heygen-render           │    │  scenes, assets, videos              │
│  queue: kling-clip              │    │  admin_actions                       │
│  queue: image-gen               │    │                                       │
│  queue: video-compose           │    │  Row-level tenant isolation on        │
│                                 │    │  every table (tenant_id FK)          │
│  Session store                  │    └───────────────────────────────────────┘
│  Job state cache                │
└──────────────────┬──────────────┘
                   │  Workers consume
   ┌───────────────┼──────────────────────────────────────┐
   │               │                                      │
┌──▼───────────────▼──────────────────┐   ┌──────────────▼──────────────────────┐
│   ORCHESTRATOR  (Node.js process)   │   │  VIDEO PROCESSOR  (Python/FastAPI)  │
│                                     │   │                                     │
│  PipelineCoordinator                │   │  POST /compose  → FFmpeg pipeline   │
│  ├─ GptScriptWorker (c:2)           │   │  POST /subtitle → burn ASS subs     │
│  ├─ HeygenRenderWorker (c:3)        │   │  POST /thumbnail                    │
│  ├─ KlingClipWorker (c:5)           │   │                                     │
│  ├─ ImageGenWorker (c:4)            │   │  Celery workers (CPU-bound tasks)   │
│  ├─ VideoComposeWorker (c:2)        │   │  ├─ compose_task                    │
│  └─ PipelineStateWorker (c:10)      │   │  ├─ subtitle_task                   │
│                                     │   │  └─ thumbnail_task                  │
│  Each worker:                       │   │                                     │
│  - Pulls job from BullMQ            │   │  Called via HTTP from               │
│  - Updates job state in Postgres    │   │  VideoComposeWorker                 │
│  - Uploads/downloads from Storage  │   │                                     │
│  - Emits SSE events for UI polling  │   └─────────────────────────────────────┘
└──────────────────────────────────────┘
                   │  read/write
┌──────────────────▼──────────────────────────────────────────────────────────┐
│                    OBJECT STORAGE  (MinIO / S3-compatible)                  │
│                                                                              │
│  /tenants/{tenant_id}/                                                       │
│    /assets/         ← uploaded source files (product images, logos)         │
│    /scenes/         ← per-scene outputs (avatar .mp4, clip .mp4, img .png)  │
│    /subtitles/      ← generated .ass subtitle files                         │
│    /videos/         ← final composed videos                                 │
│    /temp/           ← ephemeral working files (TTL: 24h, auto-purged)       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Folder Structure

```
kmmzavod/
├── apps/
│   ├── api/                          # Fastify API Gateway
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── projects.ts
│   │   │   │   ├── jobs.ts
│   │   │   │   ├── assets.ts
│   │   │   │   └── admin/
│   │   │   │       ├── tenants.ts
│   │   │   │       ├── jobs.ts
│   │   │   │       └── system.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # JWT decode, tenant extraction
│   │   │   │   ├── rate-limit.ts     # per-tenant Redis token bucket
│   │   │   │   └── tenant-scope.ts   # injects tenantId into request
│   │   │   ├── controllers/
│   │   │   │   ├── job.controller.ts
│   │   │   │   └── admin.controller.ts
│   │   │   ├── plugins/
│   │   │   │   ├── postgres.ts       # @fastify/postgres plugin
│   │   │   │   ├── redis.ts          # ioredis plugin
│   │   │   │   └── storage.ts        # MinIO/S3 client plugin
│   │   │   └── server.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── orchestrator/                 # BullMQ workers + pipeline coordination
│   │   ├── src/
│   │   │   ├── workers/
│   │   │   │   ├── gpt-script.worker.ts
│   │   │   │   ├── heygen-render.worker.ts
│   │   │   │   ├── kling-clip.worker.ts
│   │   │   │   ├── image-gen.worker.ts
│   │   │   │   ├── video-compose.worker.ts
│   │   │   │   └── pipeline-state.worker.ts
│   │   │   ├── queues/
│   │   │   │   ├── definitions.ts    # queue names, retry policies, concurrency
│   │   │   │   └── registry.ts       # single BullMQ QueueRegistry instance
│   │   │   ├── pipeline/
│   │   │   │   ├── coordinator.ts    # fan-out logic: 1 job → N BullMQ jobs
│   │   │   │   ├── state-machine.ts  # pipeline stage transitions
│   │   │   │   └── types.ts
│   │   │   └── index.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── admin/                        # Next.js Admin Panel
│   │   ├── app/
│   │   │   ├── (dashboard)/
│   │   │   ├── tenants/
│   │   │   ├── jobs/
│   │   │   └── system/               # queue depths, worker health, storage usage
│   │   ├── components/
│   │   │   ├── JobTable.tsx
│   │   │   ├── PipelineView.tsx      # per-stage status visualization
│   │   │   └── TenantUsage.tsx
│   │   └── package.json
│   │
│   └── video-processor/              # Python FastAPI + FFmpeg service
│       ├── app/
│       │   ├── api/
│       │   │   ├── compose.py        # POST /compose endpoint
│       │   │   ├── subtitle.py       # POST /subtitle endpoint
│       │   │   └── health.py
│       │   ├── services/
│       │   │   ├── ffmpeg.py         # subprocess wrapper, progress parsing
│       │   │   ├── subtitle.py       # ASS file generator from transcript
│       │   │   └── storage.py        # MinIO client (boto3)
│       │   ├── tasks/
│       │   │   ├── compose_task.py   # Celery task: download → compose → upload
│       │   │   └── subtitle_task.py
│       │   ├── models/
│       │   │   ├── compose.py        # Pydantic request/response models
│       │   │   └── subtitle.py
│       │   └── main.py
│       ├── Dockerfile
│       └── requirements.txt
│
├── packages/
│   ├── db/                           # Prisma schema + generated client
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── package.json
│   │
│   ├── queue/                        # Shared BullMQ queue definitions
│   │   ├── src/
│   │   │   ├── queues.ts             # QueueName enum + queue configs
│   │   │   ├── jobs.ts               # JobPayload union types
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── storage/                      # Storage client abstraction
│   │   ├── src/
│   │   │   ├── client.ts             # IStorageClient interface
│   │   │   ├── minio.ts              # MinIO implementation
│   │   │   ├── s3.ts                 # S3 implementation
│   │   │   └── paths.ts              # canonical path builders
│   │   └── package.json
│   │
│   └── types/                        # Shared TypeScript types
│       ├── src/
│       │   ├── tenant.ts
│       │   ├── job.ts
│       │   ├── pipeline.ts
│       │   └── scene.ts
│       └── package.json
│
├── infra/
│   ├── docker/
│   │   ├── api.Dockerfile
│   │   ├── orchestrator.Dockerfile
│   │   └── video-processor.Dockerfile
│   ├── nginx/
│   │   └── nginx.conf                # reverse proxy + upload size limits
│   └── postgres/
│       └── init.sql                  # extensions: pgcrypto, uuid-ossp
│
├── docker-compose.yml                # full local stack
├── docker-compose.prod.yml           # production overrides
├── turbo.json                        # Turborepo build pipeline
└── pnpm-workspace.yaml
```

---

## 3. Service Breakdown

| Service                  | Runtime           | Responsibility                                                                  |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------- |
| **API Gateway**          | Node.js / Fastify | Auth, tenant scoping, rate limiting, job submission, SSE job events             |
| **Orchestrator**         | Node.js / BullMQ  | Fan-out pipeline coordination, per-stage workers, state machine                 |
| **GPT Worker**           | Node.js           | Calls OpenAI API, parses structured scene JSON, persists to DB                  |
| **HeyGen Worker**        | Node.js           | Submits avatar render job, polls HeyGen API, downloads .mp4 to storage          |
| **Kling Worker**         | Node.js           | Submits clip generation, polls Kling API, downloads .mp4 to storage             |
| **Image Gen Worker**     | Node.js           | Calls image API (Fal/Replicate/ComfyUI), downloads PNG to storage               |
| **Video Compose Worker** | Node.js           | Calls video-processor HTTP endpoint with scene manifest                         |
| **Video Processor**      | Python / FastAPI  | Downloads scenes, runs FFmpeg composition, burns subtitles, uploads final video |
| **Admin Panel**          | Next.js           | Job management, tenant control, queue depth monitoring, retry/cancel controls   |
| **PostgreSQL**           | Postgres 15       | All persistent data with tenant isolation                                       |
| **Redis**                | Redis 7           | BullMQ queue storage, job state cache, session tokens                           |
| **MinIO**                | MinIO latest      | S3-compatible object storage, tenant-namespaced buckets                         |

---

## 4. Data Flow: Request → Final Video

```
1. USER REQUEST
   POST /api/v1/projects/{projectId}/jobs
   Body: { script_prompt, avatar_id, product_images[], settings }

2. API GATEWAY
   - Authenticates JWT → extracts tenant_id, user_id
   - Validates payload (zod schema)
   - INSERTs job row: jobs(id, tenant_id, project_id, status='pending', payload)
   - Pushes to BullMQ queue: "pipeline" → job { jobId, tenantId }
   - Returns 201 { jobId }

3. PIPELINE COORDINATOR (Orchestrator)
   Receives job from "pipeline" queue:
   - Loads job row from Postgres
   - Sets status = 'running'
   - Pushes to queue: "gpt-script" → { jobId, tenantId, prompt }

4. GPT WORKER (Orchestrator)
   - Calls OpenAI Chat Completions with structured JSON output schema:
     { title, scenes: [{ scene_id, type, duration, script, b_roll_prompt }] }
   - INSERTs scene rows: scenes(job_id, tenant_id, scene_index, type, script, b_roll_prompt)
   - UPDATEs job status = 'scenes_ready'
   - Fan-out: pushes ONE job per scene into "heygen-render", "kling-clip", "image-gen"
     (only for scenes that need each type)

5. HEYGEN WORKER (parallel, per avatar scene)
   - Calls HeyGen POST /v2/video/generate with avatar_id + script text
   - Stores heygen_video_id in scene row
   - Polls HeyGen GET /v2/video/{id} every 15s (max 20 retries = 5min)
   - On completion: downloads .mp4 → uploads to storage:/scenes/{sceneId}/avatar.mp4
   - Updates scene.avatar_video_url, marks scene stage 'avatar_done'

6. KLING WORKER (parallel, per b-roll scene)
   - Calls Kling POST /v1/videos/text2video with prompt
   - Polls Kling GET /v1/videos/text2video/{taskId}
   - Downloads .mp4 → uploads to storage:/scenes/{sceneId}/clip.mp4
   - Updates scene.clip_url, marks scene stage 'clip_done'

7. IMAGE GEN WORKER (parallel, per product scene)
   - Calls Fal/Replicate with b_roll_prompt + reference images (consistency adapter)
   - Downloads PNG → uploads to storage:/scenes/{sceneId}/product.png
   - Marks scene stage 'image_done'

8. PIPELINE STATE WORKER (monitors completion)
   - Triggered on every scene stage update
   - Checks: are all scenes complete across all types?
   - When all scenes done: pushes to "video-compose" queue

9. VIDEO COMPOSE WORKER (Orchestrator)
   - Builds scene manifest (ordered list of asset URLs + durations + subtitles)
   - POSTs to video-processor /compose:
     {
       output_key: "tenants/{id}/videos/{jobId}/final.mp4",
       scenes: [
         { type: "avatar", url: "...", duration: 8.5 },
         { type: "clip", url: "...", duration: 3.0 },
         { type: "image", url: "...", duration: 2.5, text_overlay: "..." }
       ],
       subtitles: [{ start, end, text }],  ← from GPT scene scripts
       settings: { resolution: "1080x1920", fps: 30, format: "mp4" }
     }

10. VIDEO PROCESSOR (Python)
    Receives /compose request:
    a. Downloads all scene assets from MinIO to /tmp/job_{id}/
    b. For each image scene: ffmpeg -loop 1 -i product.png -t 2.5 scene_N.mp4
    c. Builds concat list: concat.txt with all scenes in order
    d. Runs: ffmpeg -f concat -i concat.txt -c:v libx264 -preset fast combined.mp4
    e. Generates ASS subtitle file from subtitles[]
    f. Burns subtitles: ffmpeg -i combined.mp4 -vf "ass=subs.ass" -c:a copy final.mp4
    g. Uploads final.mp4 to MinIO
    h. Cleans /tmp/job_{id}/
    i. Returns { output_url, duration, file_size }

11. FINALIZATION
    - VideoComposeWorker receives HTTP 200 from video-processor
    - UPDATEs job: status='completed', output_url, duration, file_size, completed_at
    - Emits SSE event to API Gateway (via Redis pub/sub) → streamed to client
    - Sends webhook to tenant callback URL (if configured)
```

---

## 5. PostgreSQL Schema

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tenants
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'starter', -- starter | pro | enterprise
  credits     INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  password_hash TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- Projects
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  settings    JSONB NOT NULL DEFAULT '{}', -- default avatar_id, resolution, etc.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_projects_tenant ON projects(tenant_id);

-- Jobs (one per video generation request)
CREATE TYPE job_status AS ENUM (
  'pending', 'running', 'scenes_ready',
  'processing', 'composing', 'completed', 'failed', 'cancelled'
);
CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES projects(id),
  created_by    UUID REFERENCES users(id),
  status        job_status NOT NULL DEFAULT 'pending',
  payload       JSONB NOT NULL,              -- original request payload
  output_url    TEXT,
  error         TEXT,
  duration_sec  NUMERIC(6,2),
  file_size     BIGINT,
  credits_used  INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_jobs_tenant_status ON jobs(tenant_id, status);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- Job event log (immutable audit trail)
CREATE TABLE job_events (
  id         BIGSERIAL PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL,
  stage      TEXT NOT NULL,
  status     TEXT NOT NULL,        -- started | completed | failed
  message    TEXT,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_job_events_job ON job_events(job_id, created_at);

-- Scenes (one per GPT-generated scene)
CREATE TYPE scene_type AS ENUM ('avatar', 'clip', 'image', 'text');
CREATE TABLE scenes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL,
  scene_index     SMALLINT NOT NULL,
  type            scene_type NOT NULL,
  script          TEXT,
  b_roll_prompt   TEXT,
  duration_sec    NUMERIC(5,2),
  -- Stage completion flags
  avatar_done     BOOLEAN NOT NULL DEFAULT FALSE,
  clip_done       BOOLEAN NOT NULL DEFAULT FALSE,
  image_done      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Asset URLs (MinIO/S3 object keys)
  avatar_url      TEXT,
  clip_url        TEXT,
  image_url       TEXT,
  -- External provider IDs for polling
  heygen_video_id TEXT,
  kling_task_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_scenes_job ON scenes(job_id);
CREATE UNIQUE INDEX idx_scenes_job_index ON scenes(job_id, scene_index);

-- Assets (user-uploaded source files: logos, product images, audio)
CREATE TABLE assets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  UUID REFERENCES projects(id),
  type        TEXT NOT NULL,   -- 'product_image' | 'logo' | 'audio' | 'avatar_ref'
  filename    TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type   TEXT,
  file_size   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_assets_tenant ON assets(tenant_id);
```

---

## 6. Queue Definitions (BullMQ)

```typescript
// packages/queue/src/queues.ts

export const QUEUES = {
  PIPELINE: {
    name: "pipeline",
    concurrency: 20,
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
  GPT_SCRIPT: {
    name: "gpt-script",
    concurrency: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
  },
  HEYGEN_RENDER: {
    name: "heygen-render",
    concurrency: 3,
    attempts: 5,
    backoff: { type: "fixed", delay: 15000 },
  },
  KLING_CLIP: {
    name: "kling-clip",
    concurrency: 5,
    attempts: 5,
    backoff: { type: "fixed", delay: 10000 },
  },
  IMAGE_GEN: {
    name: "image-gen",
    concurrency: 4,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  },
  VIDEO_COMPOSE: {
    name: "video-compose",
    concurrency: 2,
    attempts: 2,
    backoff: { type: "fixed", delay: 30000 },
  },
  PIPELINE_STATE: {
    name: "pipeline-state",
    concurrency: 20,
    attempts: 1,
    backoff: { type: "fixed", delay: 1000 },
  },
} as const;

// Dead-letter: all failed jobs (after max attempts) → "dlq:{queue-name}"
// Admin panel reads DLQ and allows manual retry or discard
```

---

## 7. Scaling Strategy

### Phase 1 — Single Server (0 → ~50 concurrent jobs)

```
1 Docker Compose stack on a single CPU server:
- All services in one docker-compose.yml
- Orchestrator: 1 process, all workers active
- Video Processor: 2 Celery worker processes (1 compose + 1 subtitle)
- Bottlenecks: video processing (CPU-bound), external API rate limits

Tuning levers:
- Increase VIDEO_COMPOSE concurrency = more Celery workers
- Add BullMQ rate limiters per tenant (prevent one tenant starving others)
- Set per-tenant job credit limits enforced at API layer
```

### Phase 2 — Vertical + Horizontal Worker Split (50 → ~500 jobs)

```
Extract video-processor to dedicated CPU-optimized server(s):
- video-processor: 3× servers, each running 4 Celery workers
- FFmpeg thread count = (CPU_CORES / 4) per worker
- Use internal load balancer (nginx) in front of video-processor fleet
- Orchestrator handles distribution via BullMQ → video-compose queue
  (multiple VideoComposeWorkers each call different video-processor instance)

Add read replica for PostgreSQL:
- Orchestrator reads job state from replica
- Writes still go to primary
```

### Phase 3 — Full Microservice Split (500+ jobs / multi-region)

```
Extract each service to independent deployable unit:
Priority order of extraction:
  1. video-processor  ← highest CPU cost, must scale independently
  2. orchestrator     ← isolate queue workers per AI provider
  3. api-gateway      ← stateless, scale with load balancer
  4. admin            ← separate deploy, admin traffic is low

Kubernetes (or Nomad):
- HPA on orchestrator pods: scale on BullMQ waiting job count (custom metric)
- Dedicated node pool for video-processor (CPU-optimized instances)
- Redis Cluster or Redis Sentinel for HA
- PostgreSQL → managed (RDS, Supabase, or self-hosted with pgBouncer)
- MinIO → distributed mode (4+ nodes) or migrate to S3-compatible cloud storage

Multi-tenant rate limiting:
  - Track per-tenant queue depth in Redis sorted set
  - Reject enqueue if tenant exceeds concurrent job limit (configurable per plan)
  - BullMQ Flow producer for parent-child job dependencies (ensures fan-out jobs
    don't orphan when parent is cancelled)
```

### Admin Panel Controls (must be production-ready day 1)

| Control                  | Implementation                                                      |
| ------------------------ | ------------------------------------------------------------------- |
| Pause/resume queue       | `queue.pause()` / `queue.resume()` via BullMQ                       |
| Cancel in-progress job   | Set `job.status = 'cancelled'` in DB + `bullJob.discard()`          |
| Retry failed job         | Move from DLQ → original queue via admin API                        |
| Impersonate tenant       | Admin JWT with `act_as_tenant_id` claim, scoped read-only           |
| Queue depth view         | `queue.getJobCounts()` polled every 5s                              |
| Worker health            | BullMQ `QueueEvents` listeners → Redis pub/sub → admin SSE          |
| Force-complete scene     | Manual scene asset upload via admin → triggers pipeline state check |
| Storage usage per tenant | SELECT SUM(file_size) GROUP BY tenant from assets + jobs            |

---

## 8. Key Failure Modes & Mitigations

| Failure                    | Mitigation                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| HeyGen API timeout (>5min) | Worker retries with exponential backoff × 5; after max retries → job_event log + alert admin; job status = 'failed' with specific error code       |
| Redis restart mid-job      | BullMQ persists job state in Redis — jobs in `active` state are re-queued on worker restart. Ensure `removeOnComplete: false` during dev.          |
| FFmpeg OOM kill            | Celery worker `--max-tasks-per-child 1` isolates each compose task in subprocess. Killed worker is restarted by supervisor.                        |
| Partial scene completion   | pipeline-state worker checks all scene flags — incomplete jobs never enter compose stage. Stale jobs (no update > 30min) → cron marks failed.      |
| Storage upload failure     | Workers retry upload 3× before failing scene. Orphaned temp files in `/temp/` bucket purged by daily MinIO lifecycle rule (TTL=24h).               |
| Tenant data leak           | Every Postgres query uses `WHERE tenant_id = $tenantId` enforced at repository layer. Integration tests assert cross-tenant queries return 0 rows. |
