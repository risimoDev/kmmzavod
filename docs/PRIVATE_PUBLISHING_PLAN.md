# Private (non-official-API) Publishing — Implementation Plan

Goal: publish Reels/TikToks via **private/unofficial** methods (not official OAuth),
reusing each account's **proxy + device fingerprint**, with **session persistence**
and **warmup gating**. Official path stays as a selectable fallback.

Status legend: ⬜ todo · 🟦 in progress · ✅ done

## IMPLEMENTATION STATUS (2026-06-26)

✅ Schema (`authMethod` + `sessionData`) + migration `20260626000000_add_social_account_auth_method`
✅ `apps/publisher` service (FastAPI): instagram (instagrapi), tiktok (tiktok-uploader),
   download, /instagram/publish, /tiktok/publish, /instagram/warmup, /health + Dockerfile
✅ Orchestrator: `config.PUBLISHER_URL`, `services/publisher.ts`, private routing in
   `publish.worker.ts` (decrypt session → publish → persist refreshed session)
✅ Farm API: bulk import accepts `authMethod` + private creds; `PUT /social-accounts/:id/credentials`
✅ docker-compose `publisher` service (+ shm_size for Chromium) + `.env.example`
✅ Front-end farm import: method selector + per-method credential parsing + `private` badge

UPDATE (2026-07-03) — warmup promoter + gate DONE:
✅ Warmup promoter: scheduler tick enqueues `account-warmup` jobs (~1/day/account,
   jitter ≤3h) for private IG accounts; `account-warmup.worker.ts` calls publisher
   `/instagram/warmup`, persists refreshed session, promotes cold→warming (первый
   успех) → warm (≥5 прогревов и ≥5 дней). TikTok private промоутится по возрасту
   (cold→warming 24ч, warming→warm 72ч) — у publisher нет tiktok-warmup действия.
   Поля `warmupStartedAt/lastWarmupAt/warmupCount` + миграция `20260703000000`.
✅ Warmup gate ENFORCED in distribute.worker: private + warmupStatus==='cold' → skip.
✅ Авторасписание публикаций: `DistributeSchedule` (миграция `20260703000100`),
   тик в scheduler.worker, API `/api/v1/distribute-schedules`, UI `/uniquify/schedules`.

REMAINING / NOTES:
- NOT runnable/tested here (needs real accounts + proxies). Validate via checklist below.
- After deploy: `prisma migrate deploy && prisma generate`, then rebuild publisher+orchestrator+api+web.


---

## Architecture

```
publish.worker.ts (orchestrator)
   │  authMethod === 'private' ?
   ├── yes → POST apps/publisher (Python, stateless)
   │           ├── /instagram/publish  (instagrapi, pure HTTP)
   │           └── /tiktok/publish      (tiktok-uploader, Selenium + headless Chrome)
   │         returns { externalId, sessionData }  ← worker persists encrypted session
   └── no  → existing official clients (TikTok/IG/YouTube/PostBridge)
```

Key principles:
- **Publisher is stateless.** It never touches the DB. The orchestrator owns Prisma +
  crypto: it decrypts session/credentials, sends them in, and persists the updated
  session that the publisher returns. This keeps secrets handling in one place.
- **Video transfer:** orchestrator sends a MinIO **presigned URL**; publisher downloads
  to a temp file (direct, not via the social proxy), then uploads to the platform
  **through the account proxy**. Temp files always cleaned up.
- **Per-account isolation:** proxy + device fingerprint applied per request, before login.
- **Reuse existing anti-ban gates** in distribute.worker (daily limit, health<30,
  3h gap, jittered stagger) — unchanged. Add a **warmup gate** (only post from
  warmupStatus !== 'cold').

---

## Data model changes (SocialAccount)

Add:
- `authMethod String @default("official")`  // 'official' | 'private'
- `sessionData String?` (encrypted JSON blob). Holds, per platform:
  - Instagram: `{ "username": "...", "password": "...", "settings": <instagrapi settings> }`
  - TikTok: `{ "sessionid": "...", "cookies": [...] }`
  (credentials + the live session/settings, all encrypted at rest)

Migration: `add_social_account_auth_method`.

---

## Publisher service (`apps/publisher`)

FastAPI, Python 3.12. Files:
- `requirements.txt` — fastapi, uvicorn, instagrapi, tiktok-uploader, selenium,
  requests, pydantic, pydantic-settings.
- `Dockerfile` — python:3.12-slim + Chromium + chromedriver (for TikTok Selenium).
- `app/config.py` — settings (work dir, log level).
- `app/models.py` — request/response pydantic models.
- `app/services/download.py` — fetch presigned URL → temp file (size-guarded).
- `app/services/instagram.py`:
  - login: `Client()`, `set_proxy(proxy)`, apply device/UA from fingerprint,
    if settings present → `set_settings` then `login(user,pass)` (reuses session),
    else `login(user,pass)`. Return client + dump settings.
  - `publish_reel(path, caption)` → `clip_upload` → media code/pk. Return external id.
  - `warmup(actions)` → get_timeline_feed, like a few, optional follow. Light + safe.
- `app/services/tiktok.py`:
  - cookies from sessionid; `upload_video(path, description, cookies, proxy, headless)`.
  - return whether posted (TikTok gives no reliable post id via this path → return ok).
- `app/api/publish.py` — routes:
  - `POST /instagram/publish` { videoUrl, caption, proxyUrl?, deviceFingerprint?,
    sessionData } → { externalId, sessionData }
  - `POST /tiktok/publish` { videoUrl, caption, proxyUrl?, sessionData } → { externalId?, ok }
  - `POST /instagram/warmup` { proxyUrl?, sessionData } → { sessionData }
  - `GET /health`
- `app/main.py` — wires routers; semaphore to cap concurrent browser sessions.

---

## Orchestrator integration

- `config.ts` — add `PUBLISHER_URL` (default http://localhost:8200).
- `services/publisher.ts` — thin axios client: `instagramPublish`, `tiktokPublish`,
  `instagramWarmup`. 800s timeouts.
- `publish.worker.ts` — at the top of the switch, if `account.authMethod === 'private'`
  and platform ∈ {instagram, tiktok}: route to publisher; decrypt `sessionData`,
  pass proxy + fingerprint + presigned URL + caption; on success persist the returned
  `sessionData` (encrypted) + the usual published/health/distribute updates.
  Keep official path otherwise. YouTube/PostBridge always official.
- index.ts — pass `publisherUrl: config.PUBLISHER_URL` into the publish worker deps.

---

## API / farm changes

- Extend `BulkSocialAccountBody` (account-farm.routes): add
  `authMethod?: 'official'|'private'`, and per-account `credentials?` object
  (`username`/`password` for IG, `sessionId` for TikTok). When private: build
  `sessionData` JSON, encrypt, store; set `accessToken` to a placeholder (it's NOT NULL).
- New endpoint `POST /social-accounts/:id/credentials` to set/update private creds later.
- Warmup gate: distribute.worker — skip accounts with `warmupStatus === 'cold'`
  when `authMethod === 'private'` (configurable).

---

## Front-end (farm page)

- Account import / edit: choose method (official | private) and enter creds
  (IG user/pass, TikTok sessionid). Never display stored secrets back.
- (Minimal — backend is the priority.)

---

## docker-compose

- Add `publisher` service (build apps/publisher, port 8200, env, shm_size for Chrome).
- Orchestrator depends_on publisher; set `PUBLISHER_URL=http://publisher:8200`.

---

## Warmup (basic, real building block)

- `POST /instagram/warmup`: logs in, scrolls timeline, likes 2–4 posts, returns
  updated session. A scheduler tick (later) promotes cold→warming→warm over days.
- Posting gated on `warmupStatus !== 'cold'` for private accounts.

---

## Testing checklist (must run live)

1. Import 1 IG account (private, user/pass) → `/instagram/publish` posts a Reel,
   session persisted, second post reuses session (no re-login challenge).
2. Import 1 TikTok account (sessionid) → `/tiktok/publish` posts, returns ok.
3. Proxy actually used (verify egress IP via account proxy).
4. Health/daily-count/3h-gap gates still fire.
5. Warmup endpoint runs without error and updates session.

## Risks / notes
- Private APIs violate platform ToS; ban risk mitigated by residential/mobile proxies,
  consistent device fingerprint, warmup, human-like pacing (already in distribute).
- instagrapi/tiktok-uploader break when platforms change → pin versions, expect upkeep.
- TikTok Selenium needs Chromium in the image (heavier) and a valid sessionid cookie.
- Cannot be unit-tested here without real accounts/proxies — validate with checklist.
