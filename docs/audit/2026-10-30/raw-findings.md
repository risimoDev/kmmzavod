# Raw findings (pre-triage)

## security: media+publisher
- SEC-media-1 (med) Python services editor/video-processor/publisher: no auth; any container on backend net can call them. Fix: X-Internal-Token shared secret (hmac.compare_digest), /health exempt; orchestrator + api pipeline-test send header.
- SEC-media-2 (med) services accept arbitrary storage keys with master MinIO creds; tenant_id unused. Fix: validate keys prefix tenants/{tenant_id}/ (check shared assets first).
- SEC-media-3 (low) editor storage.resolve_source: local paths + any URL w/ redirects; publisher download.py same. Fix: allow MinIO host only, no redirects, local only with ALLOW_LOCAL_SOURCES.
- SEC-media-4 (low) work dir from unvalidated job_id/variant_id (compose.py:79,135; uniquify.py:136,179). Fix: pattern validation.
- SEC-media-5 (low/DoS) ffmpeg subprocess.run without timeout (video-processor ffmpeg.py:77 _run, editor render.py:36 _run); unbounded lists in RenderRequest.
- SEC-media-6 (low) fastapi 0.115.0 old starlette; unpinned deps; download_model mirror no hash.
- Hardening: no-new-privileges/cap_drop on python services; dedicated MinIO user; don't return raw exception text (publisher publish.py:61,76,90); .dockerignore; axios maxContentLength in image-gen.client.ts:115,238.

## security: infra+web+storage
- SEC-infra-1 (med, VERIFIED) nginx XFF `$proxy_add_x_forwarded_for` (nginx.conf:69,116) + fastify trustProxy:true → req.ip spoofable → IP rate limits bypassed (login brute force). Fix: XFF=$remote_addr in nginx; trustProxy to hop count 1.
- SEC-infra-2 (med, VERIFIED) docker-compose.yml:332 NEXTAUTH_SECRET=${JWT_SECRET} into web container, unused. Remove.
- SEC-infra-3 (med) device-agent has no auth; API calls it without secret (apps/api/src/lib/device-agent.ts). Fix: optional DEVICE_AGENT_TOKEN header (enforced only when set → backward compatible with farm PC).
- SEC-infra-4 (med) infra/proxy-relay/relay.mjs CONNECT to any host:port incl. docker subnet/loopback. Fix: deny private/loopback/link-local targets (check mobile proxies are public).
- SEC-infra-5 (med) tokens in localStorage, no CSP. Fix: CSP headers (careful), Secure cookie flag.
- SEC-infra-6 (med) presignedPutUrl ignores contentType/size (packages/storage/src/minio.ts:176); /storage same-origin → stored XSS chain. Fix: CSP sandbox + nosniff on /storage/ in nginx; content-type check.
- SEC-infra-7 (med) next 14.2.18 → upgrade to latest 14.2.x (needs network/install; may defer).
- SEC-infra-8 (low) override publishes pg/redis/minio on 0.0.0.0 → bind 127.0.0.1.
- SEC-infra-9 (low) CORS regex /\.kmmzavod\.ru$/ stale+unanchored.
- SEC-infra-10 (low) nginx client_max_body_size 1000M globally, no limit_req.
- SEC-infra-11 (low) minio:latest; root creds for services.
- SEC-infra-12 (low) apps/web/.env.local tracked (no secret); no .dockerignore.
- Hardening: server_tokens off; HSTS repeated in /storage/; presigned TTL 86400 in products.routes.ts:213.

## security: api-core
- SEC-api-core-1 (high) = SEC-infra-1 (trustProxy:true + XFF). Fix trustProxy: 1 + nginx.
- SEC-api-core-2 (high) bodyLimit 1GB global (app.ts:40) for JSON incl. unauth login → OOM DoS; password no max. Fix: bodyLimit ~1-10MB global; per-route bodyLimit on upload routes (check multipart vs bodyLimit); password max 128.
- SEC-api-core-3 (high) presets /:id/preview + factory (scheduler.worker.ts:195-247) create Video/Job without credit pre-check; chargeCredits may go negative. Fix: reuse videos.routes credit check; scheduler skip if insufficient; min cron interval.
- SEC-api-core-4 (med) products images: arbitrary storage keys (products.routes.ts:16,29,228) → cross-tenant presign. Fix: require prefix tenants/{tid}/.
- SEC-api-core-5 (low) user enumeration via timing/403 before password check (auth.routes.ts:97-112); emails not lowercased.
- SEC-api-core-6 (low) role/platformRole trusted from JWT; refresh from DB in authenticate (same query).
- SEC-api-core-7 (low) JWT_SECRET placeholder passes min(32) in prod.
- SEC-api-core-8 (low) = SEC-infra-9 CORS kmmzavod.ru.
- SEC-api-core-9 (low) admin settings return provider API keys plaintext; audit log stores values (admin.routes.ts:948,968,1088,1130).
- SEC-api-core-10 (low) project upload err.message leak; schedules no cron validation.
- SEC-api-core-11 (low) SSE ?token= logged (videos.routes.ts:78-82).
- Hardening: :id uuid validation → 500 on malformed ids; notifications page/limit .int(); change-password/revoke sessions.

## security: api-features
- SEC-feat-1 (high) farm gate missing on POST /farm/social-accounts/bulk (:685-766) and PUT /social-accounts/:id/credentials (:789-815) → any tenant binds account to arbitrary deviceId (authMethod device). Fix: require hasFarmAccess for device auth/deviceId.
- SEC-feat-2 (med) user-controlled storage keys: editor config voiceoverKey/bgmKey (z.record unknown), autopilot bgmKeys, uniquify bgmTrackKeys, audioTrack.storage_key → cross-tenant presign. Fix: assertOwnKey helper (tenants/{tid}/ or global bgm prefix), reject '..'.
- SEC-feat-3 (med) proxy password plaintext in SocialAccount.proxyUrl, returned by GET /farm/social-accounts & GET /api/v1/social-accounts. Fix: strip proxyUrl from responses (mask).
- SEC-feat-4 (med) proxy health-check TCP to arbitrary host (blind port scan) :614-641. Fix: block private/loopback/service names.
- SEC-feat-5 (med) = bodyLimit 1GB.
- SEC-feat-6 (med) no credit/quota on editor AI (voice/script), uniquify, autopilot, campaigns. (Business decision — careful: user's own tenant may run with 0 credits.)
- SEC-feat-7 (low) phones not owned by tenants; FARM_TENANT_IDS single tenant assumption; agent no auth (=infra-3).
- SEC-feat-8 (low) apkUrl/rotateUrl/packageName validation (packageName interpolated into adb shell).
- SEC-feat-9 (low) FK ids from body unchecked: accountGroupId bulk, uniquify projectId, editor workspaceProjectId; confirm-upload no exists check.
- SEC-feat-10 (low) unpaginated lists; diagnostics loads sessionData; autopilot N+1 readyVariants (autopilot.routes.ts:329-347).
- SEC-feat-11 (low) SSE ?token= + no isActive check.
- SEC-feat-12 (low) DELETE /bgm key '..' check.
- Hardening: decrypt() silent fallback; P2034 retry in credit tx (videos.routes.ts:341).

## code: orchestrator workers
- CA-orch-1 (high, VERIFIED) orchestrator index.ts:103-120 Queues lack defaultJobOptions → publish via distribute attempts=1, distribute 1 attempt, no removeOn* → Redis growth; upsertJobScheduler without opts (index.ts:249).
- CA-orch-2 (high) HeyGen/Runway retry re-creates paid task (heygen-render.worker.ts:102-113, runway-clip.worker.ts:111-132); poll loop no tolerance for transient errors.
- CA-orch-3 (med) editor-analyze/render, uniquify-render/analyze write 'failed' on non-final attempts → autopilot failBatch & premature finalize.
- CA-orch-4 (med) autopilot/loop.ts:286-309 sequential checkApps per phone every tick (15s timeout each) → starves scheduler.
- CA-orch-5 (med) publish.worker.ts:163-186 status 'uploading' at entry (crash mid-upload) → re-run may double post.
- CA-orch-6 (med) account-warmup penalty -5 health on infra errors → accounts excluded after outage.
- CA-orch-7 (med) gpt-script not idempotent across attempts (re-charge, duplicate scenes).
- CA-orch-8 (med) scenes skipped by fan-out (missing prompt) → pipeline waits forever; no reaper.
- CA-orch-9 (med) sibling scenes keep spending after job failed.
- CA-orch-10 (med) presets/campaigns/autopilot windows without atomic claim; nextRunAt advanced after enqueue.
- CA-orch-11 (med) campaign daily-slot counts only published → overbooking.
- CA-orch-12 (low) distribute non-atomic create/update/add.
- CA-orch-13 (low) shutdown unbounded & re-entrant.
- CA-orch-14 (low) dead kling-clip worker/client.
- CA-orch-15 (low) N+1 in scheduler tick; per-variant create loop.
- Improvements: generic stuck-state reaper; device status cache.

## code: web
- CA-web-1 (high) admin-api.ts:11-60 own refresh w/o single-flight; rotated refresh → admins logged out. Fix: reuse api.ts refreshTokens.
- CA-web-2 (high) uniquify list pagination: web expects {pagination}, API returns {total,page,limit,totalPages} (uniquify.routes.ts:291,547,773) → pagination never shows.
- CA-web-3 (med) product <img> to auth'd image-preview endpoint → 401, images never visible. Fix: presigned imageUrls in product responses.
- CA-web-4 (med) uploads + dashboard raw fetch bypass refresh (api.ts:1297,1398,1698,1754,2140; dashboard/page.tsx:53).
- CA-web-5 (med) editor/[id] no error path; infinite spinner; silent failures.
- CA-web-6 (med) videos/[id] silent catch; SSE no fallback, ?token=.
- CA-web-7 (med) farm/page.tsx remote view re-renders whole DevicesTab 4-8x/s.
- CA-web-8 (med) farm devices empty list → 20 fake online boards (farm/page.tsx:2113-2133).
- CA-web-9 (med) /projects/:id/hub loads all tenant editClips; name-substring linking (projects.routes.ts:90-135).
- CA-web-10 (low) create/page.tsx duplicate product on retry.
- CA-web-11 (low) refresh network error → logout (api.ts:121-135).
- CA-web-12 (low) polling not paused on hidden tab; static data repolled.
- CA-web-13/14 (low) campaigns/[id] spinner; autopilot list opens create on poll error.
- CA-web-15 (low) farm accounts only first 100.
- CA-web-16 (low) editor playSegment listener leak.
- CA-web-17 (low) subtitle style catalog copy-pasted 3x.

## code: orchestrator core
- CA-oc-1 (high) = CA-orch-2 (poll w/o tolerance + recreate paid tasks).
- CA-oc-2 (med) uniquify job 'completed' before scoring → unscored/weak copies distributed; JSON NOT filter NULL semantics.
- CA-oc-3 (high) = CA-orch-4.
- CA-oc-4 (med) private publish path: axios timeout ECONNABORTED retried → double post; publisher maps all errors to 502.
- CA-oc-5 = CA-orch-3.
- CA-oc-6 (med) chargeCredits no idempotency key.
- CA-oc-7 (med) missing indexes DistributeItem(uniqueVariantId),(socialAccountId,status,createdAt); EditSource(storageKey); findCachedAnalyses over-fetch.
- CA-oc-8 (med) in-flight items no age limit → account skipped forever.
- CA-oc-9 (med) no storage retention (MinIO grows).
- CA-oc-10 (low) proxyFetch new ProxyAgent per call (lib/proxy.ts:108).
- CA-oc-11 (low) stage transitions non-atomic with queue add; failBatch stale increment.
- CA-oc-12 (low) TikTok/IG official token refresh never called.
- CA-oc-13 (low) scoreUniquifyJob O(n²) both directions, sync.
- CA-oc-14 (low) API readyVariants lacks NOT_WEAK.
- CA-oc-15 (low) image-gen fallback bills wrong provider.
- CA-oc-16 (low) provider 4xx retried; no UnrecoverableError.

## code: api
- CA-api-1 (high) cancel doesn't stop BullMQ (pipeline add without jobId → getJob(job.id) misses); workers don't check cancelled.
- CA-api-2 (high) = CA-dbaistor-1 retry re-add with deterministic jobId is a no-op while failed job retained (removeOnFail:false).
- CA-api-3 (med) active statuses miss running/scenes_ready (videos.routes.ts:694,728; admin.routes.ts:135).
- CA-api-4 = CA-web-2 pagination.
- CA-api-5 (med) preset preview: scriptPrompt camelCase vs coordinator script_prompt; no credit reserve; no tx.
- CA-api-6 = CA-web-9 projects hub.
- CA-api-7 (med) no status guard: editor analyze/render double; distribute double click; P2034 → 500; admin retry race.
- CA-api-8 (med) cron/timezone unvalidated; nextCronDate null for >7d horizon → schedule dies silently.
- CA-api-9 (med) = indexes.
- CA-api-10 (med) uniquify retry-failed loses allowMirror/frameLayout/sceneBreaks; retry after cancel.
- CA-api-11 (low) enqueue failure leaves entities pending forever.
- CA-api-12 (low) cancelled videos still listed; readiness warmup gate mismatch for device.
- CA-api-13 (low) editor config read-modify-write races.
- CA-api-14 (low) farm schedules redis RMW; no lock.
- CA-api-15 (low) /api/v1/schedules dead.
- CA-api-16 (low) ALL_QUEUES missing queues in admin.

## code: db/ai/storage
- CA-dbaistor-1 (high) = CA-api-2.
- CA-dbaistor-2 (med) removeOnFail:false on 12 queues → Redis growth. Fix age 7d / count 1000.
- CA-dbaistor-3 = CA-orch-2.
- CA-dbaistor-4/5 (med) indexes: DistributeItem(uniqueVariantId),(socialAccountId,status); PublishJob(socialAccountId,status,publishedAt); schema lacks @@index for existing publish_jobs_unique_variant_id_idx, unique_variants_phash_idx (drift risk).
- CA-dbaistor-6 (low) migration_lock.toml missing.
- CA-dbaistor-7 (low) OpenRouter models list >3.
- CA-dbaistor-8 (low) fish.ts falls to paid model on 429/5xx.
- CA-dbaistor-9 (low) script.ts trimMiddle misleading note.
- CA-dbaistor-10 (low) storage exists() false on any error → paid TTS re-synthesis on outage.
- CA-dbaistor-11 (low) recordPace RMW.
- Improvements: retention job for append-only tables; encrypt accessToken/refreshToken/Proxy.password.

## code: farm (device-agent, static)
- CA-farm-1 (high) no per-device mutex in agent; warmup/control/stats overlap publish on same phone.
- CA-farm-2 (high) ECONNRESET/socket hang up/5xx after /publish sent → plain Error → retry → double post. Fix: classify post-send errors unrecoverable.
- CA-farm-3 (med) agent worst-case > 20 min orchestrator timeout; no abort on disconnect.
- CA-farm-4 (med) proxy test() uses 25s retry window → UI timeout instead of 403 message.
- CA-farm-5 (med) INFRA_ERROR_RE misses proxy/network phrases; warmup penalizes lease wait.
- CA-farm-6 (med) adb inputText escaping weaker than typeText (passwords with # { } [ ] break).
- CA-farm-7 (low) packageName/url/targetUsername interpolation in shell.
- CA-farm-8 (med) pm list failure → "not installed" retryable:false → post lost.
- CA-farm-9 (med) /devices sequential checks → API 8s timeout.
- CA-farm-10 (med, low conf) appConfirmed overrides negative profile check.
- CA-farm-11 (low) debug snapshots never pruned.
- CA-farm-12/13/14/15 (low) fastShell retry non-idempotent; stale ui dump; forwarder leak on client abort; script-engine regex.
- Improvements: async /publish job; force-stop app before publish; listen retry on boot; errorKind contract.

## code: media
- CA-media-1 (high) VP /transcribe blocks event loop + loads Whisper per request (transcribe.py) → health fails.
- CA-media-2 (med) blocking CPU in async handlers (quality, beat-detect, editor analyze thumbs).
- CA-media-3 (med) _adjust_sub_time off by one boundary → subtitles early after xfade (pipeline.py:206-222, 791-809).
- CA-media-4 (med) colour grading no-op (stage logs but copies file).
- CA-media-5 (med) J/L-cuts via acrossfade duration → permanent A/V drift.
- CA-media-6 (med) beat-align rewrites durations only → A/V offset, clips vanish; drops cut_type.
- CA-media-7 (med) Ken Burns zoom doesn't zoom (crop w/h evaluated once).
- CA-media-8 (med) duck fade ignored (fade_s/volume_filters dead) → hard BGM toggles; duck level semantics.
- CA-media-9 (med) editor audio envelope: no resample (48k → 9% drift), -inf skipped → time shift → wrong clip scoring.
- CA-media-10 (med) editor max_source_duration checked after full analysis.
- CA-media-11..20 (low): no vad_filter in analyze; temp file leak on download error; _hamming compares hex chars; no apad; beat snap ignores xfade; concat+xfade timebase; uniquify scene detect fps=1; EDL not validated; check_quality unused full decode; subtitle zero-length words.
- Improvements: concat demuxer copy for hard cuts (-30% render), downscale before Haar, parallel source download, cache source signature per uniquify job, subtitle line breaking.
