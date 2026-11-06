/**
 * Error handling shared by the paid-provider clients/workers (HeyGen, Runway).
 *
 * Goals:
 *  - a transient blip while POLLING a task must not abort the poll (BullMQ would retry the
 *    job and the worker would create — and pay for — a new provider task);
 *  - a permanent provider answer on CREATE (bad key, no balance, invalid input) must not burn
 *    every BullMQ attempt;
 *  - nothing is spent for a job that is already failed/cancelled.
 */
import axios from 'axios';
import { UnrecoverableError } from 'bullmq';
import type { PrismaClient } from '@kmmzavod/db';

/** The provider reports that the task itself failed / was cancelled (not a transport problem). */
export class ProviderTaskFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTaskFailedError';
  }
}

/** HTTP statuses on which retrying the very same request later can succeed. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** Network error (no response), timeout, 5xx, 429 or 408. */
export function isTransientHttpError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (!err.response) return true;
  return isTransientStatus(err.response.status);
}

/** Retry-After header → ms (seconds or HTTP date), capped; undefined if absent/unparseable. */
export function retryAfterMs(err: unknown, capMs = 120_000): number | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const raw = err.response?.headers?.['retry-after'];
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value === '') return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, capMs);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), capMs);
  return undefined;
}

/**
 * Counts consecutive transient poll failures. `onError` returns how long to wait before the
 * next poll, or throws the original error when it is not transient / the limit is exceeded.
 */
export class PollFailureTracker {
  private consecutive = 0;

  constructor(
    private readonly maxConsecutive = 8,
    private readonly baseBackoffMs = 5_000,
    private readonly maxBackoffMs = 60_000,
  ) {}

  onSuccess(): void {
    this.consecutive = 0;
  }

  onError(err: unknown): number {
    if (!isTransientHttpError(err)) throw err;
    this.consecutive++;
    if (this.consecutive >= this.maxConsecutive) throw err;
    const backoff = Math.min(this.baseBackoffMs * 2 ** (this.consecutive - 1), this.maxBackoffMs);
    return Math.max(backoff, retryAfterMs(err) ?? 0);
  }

  get failures(): number {
    return this.consecutive;
  }
}

const PERMANENT_STATUSES = new Set([400, 401, 402, 403, 404, 422]);

function providerMessage(err: { message: string; response?: { status: number; data?: unknown } }): string {
  const data = err.response?.data as any;
  const raw =
    data?.error?.message ?? (typeof data?.error === 'string' ? data.error : undefined) ??
    data?.message ?? data?.detail ?? err.message;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return `HTTP ${err.response?.status}: ${text}`.slice(0, 400);
}

/**
 * Converts a permanent provider rejection (400/401/402/403/404/422) into BullMQ's
 * UnrecoverableError, so the job fails right away instead of burning all attempts.
 * Always throws: UnrecoverableError for permanent statuses, the original error otherwise.
 */
export function toUnrecoverableIfPermanent(err: unknown): never {
  if (axios.isAxiosError(err) && err.response && PERMANENT_STATUSES.has(err.response.status)) {
    throw new UnrecoverableError(providerMessage(err));
  }
  throw err;
}

/** Runs a provider "create task" call, mapping permanent rejections to UnrecoverableError. */
export async function createTaskOrUnrecoverable<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (err) {
    return toUnrecoverableIfPermanent(err);
  }
}

/**
 * True when polling an already-existing (resumed) task shows it is gone on the provider side:
 * the task failed/was cancelled, or the id is unknown/expired (404).
 */
export function isProviderTaskGone(err: unknown): boolean {
  if (err instanceof ProviderTaskFailedError) return true;
  return axios.isAxiosError(err) && err.response?.status === 404;
}

/**
 * True when the parent Job is failed/cancelled (or deleted) — paid provider calls are wasted then.
 */
export async function isParentJobDead(db: PrismaClient, jobId: string): Promise<boolean> {
  const row = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
  return !row || row.status === 'failed' || row.status === 'cancelled';
}
