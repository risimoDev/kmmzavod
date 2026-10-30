# Baseline — 2026-10-30 (branch audit/2026-10-30, rollback tag pre-audit-2026-10-30)

| Check | Result |
|---|---|
| TS typecheck: api, orchestrator, device-agent, web, packages/ai, db, queue, storage | PASS (0 errors) |
| Tests orchestrator (5 files) | PASS 44/44 |
| Tests device-agent (4 files, unit only) | PASS 87/87 |
| Tests packages/ai | PASS 17/17 (fake fetch) |
| prisma validate | PASS |
| prisma migrate diff (drift) | SKIP — no local Postgres; `migrations/migration_lock.toml` missing |
| Python py_compile editor / video-processor / publisher | PASS |
| `import app.main` editor | PASS; video-processor, publisher SKIP (deps not installed locally) |
| pyflakes | 0 undefined names; editor 2 / video-processor 19 unused-code warnings |
| pip-audit | SKIP (not installed) |
