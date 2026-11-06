/**
 * Poll tolerance + error classification for the HeyGen / Runway clients. No network:
 * the clients' axios instances are replaced with fakes.
 */
import { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { HeyGenClient } from '../src/clients/heygen.client';
import { RunwayClient } from '../src/clients/runway.client';
import {
  ProviderTaskFailedError,
  isProviderTaskGone,
  isTransientHttpError,
  retryAfterMs,
  toUnrecoverableIfPermanent,
} from '../src/lib/provider-errors';

let failed = 0;
const check = (ok: boolean, m: string, extra = '') => {
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', m, ok ? '' : extra);
};

function httpError(status?: number, headers: Record<string, string> = {}, data?: unknown): AxiosError {
  const err = new AxiosError(status ? `Request failed with status code ${status}` : 'socket hang up');
  if (status) {
    err.response = { status, statusText: '', headers, config: {} as any, data } as any;
  }
  return err;
}

/** Fake axios `get`: plays back a script of errors / response bodies. */
function scripted(script: Array<AxiosError | unknown>) {
  let calls = 0;
  return {
    get calls() { return calls; },
    get: async () => {
      const step = script[Math.min(calls++, script.length - 1)];
      if (step instanceof Error) throw step;
      return { data: step };
    },
  };
}

const fast = { maxAttempts: 40, baseDelayMs: 1, errorBackoffMs: 1 };

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  return undefined;
}

async function main() {
  // ── classification ──────────────────────────────────────────────────────
  check(isTransientHttpError(httpError()), 'network error (no response) is transient');
  check(isTransientHttpError(httpError(503)), '503 is transient');
  check(isTransientHttpError(httpError(429)), '429 is transient');
  check(!isTransientHttpError(httpError(401)), '401 is not transient');
  check(!isTransientHttpError(new Error('boom')), 'plain Error is not transient');
  check(retryAfterMs(httpError(429, { 'retry-after': '7' })) === 7000, 'Retry-After seconds parsed');
  check(retryAfterMs(httpError(429, { 'retry-after': '99999' })) === 120_000, 'Retry-After capped');
  check(retryAfterMs(httpError(503)) === undefined, 'no Retry-After → undefined');

  for (const st of [400, 401, 402, 403, 404, 422]) {
    let thrown: unknown;
    try { toUnrecoverableIfPermanent(httpError(st, {}, { error: { message: 'no balance' } })); } catch (e) { thrown = e; }
    check(thrown instanceof UnrecoverableError && /no balance/.test((thrown as Error).message), `${st} → UnrecoverableError with provider message`);
  }
  for (const e of [httpError(500), httpError(429), httpError(), new Error('x')]) {
    let thrown: unknown;
    try { toUnrecoverableIfPermanent(e); } catch (x) { thrown = x; }
    check(thrown === e, 'transient/other error rethrown as is');
  }
  check(isProviderTaskGone(new ProviderTaskFailedError('x')) && isProviderTaskGone(httpError(404)) && !isProviderTaskGone(httpError(500)),
    'task-gone = provider-failed or 404 only');

  // ── HeyGen ──────────────────────────────────────────────────────────────
  const ok = { data: { video_id: 'v', status: 'completed', video_url: 'http://x/v.mp4', duration: 3 }, error: null };
  const processing = { data: { video_id: 'v', status: 'processing' }, error: null };
  const hg = () => new HeyGenClient('test-key');

  {
    const c = hg(); const http = scripted([processing, httpError(), httpError(503), httpError(429, { 'retry-after': '0' }), processing, ok]);
    (c as any).httpV1 = http;
    const r = await c.pollUntilDone('v', fast);
    check(r.videoUrl === 'http://x/v.mp4' && http.calls === 6, 'HeyGen: survives network/5xx/429 blips, finishes', `calls=${http.calls}`);
  }
  {
    const c = hg(); const http = scripted([httpError(500)]);
    (c as any).httpV1 = http;
    const e = await rejects(c.pollUntilDone('v', { ...fast, maxConsecutiveErrors: 4 }));
    check(axiosIs(e, 500) && http.calls === 4, 'HeyGen: gives up after N consecutive failures', `calls=${http.calls}`);
  }
  {
    // Non-consecutive failures never reach the limit.
    const c = hg(); const http = scripted([httpError(500), processing, httpError(500), processing, httpError(500), processing, ok]);
    (c as any).httpV1 = http;
    const r = await c.pollUntilDone('v', { ...fast, maxConsecutiveErrors: 2 });
    check(r.duration === 3, 'HeyGen: failure counter resets after a good poll');
  }
  {
    const c = hg(); const http = scripted([httpError(401)]);
    (c as any).httpV1 = http;
    const e = await rejects(c.pollUntilDone('v', fast));
    check(axiosIs(e, 401) && http.calls === 1, 'HeyGen: 401 rethrown immediately', `calls=${http.calls}`);
  }
  {
    const c = hg(); const http = scripted([{ data: { video_id: 'v', status: 'failed', error: 'bad' }, error: null }]);
    (c as any).httpV1 = http;
    const e = await rejects(c.pollUntilDone('v', fast));
    check(e instanceof ProviderTaskFailedError, 'HeyGen: provider-side failure → ProviderTaskFailedError');
  }

  // ── Runway ──────────────────────────────────────────────────────────────
  const rwOk = { id: 't', status: 'SUCCEEDED', output: ['http://x/c.mp4'], duration: 5 };
  const rwRun = { id: 't', status: 'RUNNING' };
  const rw = () => new RunwayClient('test-key');
  {
    const c = rw(); const http = scripted([rwRun, httpError(502), httpError(), rwRun, rwOk]);
    (c as any).http = http;
    const r = await c.pollUntilDone('t', fast);
    check(r.outputUrl === 'http://x/c.mp4' && http.calls === 5, 'Runway: survives network/5xx blips, finishes', `calls=${http.calls}`);
  }
  {
    const c = rw(); const http = scripted([httpError()]);
    (c as any).http = http;
    const e = await rejects(c.pollUntilDone('t', { ...fast, maxConsecutiveErrors: 3 }));
    check(e instanceof AxiosError && http.calls === 3, 'Runway: gives up after N consecutive failures', `calls=${http.calls}`);
  }
  {
    const c = rw(); const http = scripted([httpError(404)]);
    (c as any).http = http;
    const e = await rejects(c.pollUntilDone('t', fast));
    check(axiosIs(e, 404) && http.calls === 1, 'Runway: 404 rethrown immediately', `calls=${http.calls}`);
  }
  {
    const c = rw(); const http = scripted([{ id: 't', status: 'FAILED', failure: 'moderation' }]);
    (c as any).http = http;
    const e = await rejects(c.pollUntilDone('t', fast));
    check(e instanceof ProviderTaskFailedError, 'Runway: FAILED → ProviderTaskFailedError');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
}

function axiosIs(e: unknown, status: number): boolean {
  return e instanceof AxiosError && e.response?.status === status;
}

main();
