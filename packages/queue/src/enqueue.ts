// Enqueue helper for deterministic jobIds.
//
// BullMQ silently ignores `queue.add` when a job with the same `jobId` already exists —
// and finished jobs are retained (removeOnComplete/removeOnFail), so a retry that reuses a
// deterministic jobId (`gpt-<jobId>`, `runway-<sceneId>`, `compose-<jobId>` …) becomes a no-op.

import type { Queue, Job, JobsOptions } from 'bullmq';

/**
 * Like `queue.add`, but a finished (completed/failed) job with the same `opts.jobId` is
 * removed first so the new job really gets enqueued. A job that is still
 * active/waiting/delayed is left alone and returned — never double-enqueued.
 */
export async function addOrReplace<T = unknown>(
  queue: Queue,
  name: string,
  data: T,
  opts: JobsOptions = {},
): Promise<Job> {
  if (opts.jobId) {
    const existing = await queue.getJob(String(opts.jobId));
    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      if (state === 'completed' || state === 'failed') {
        try {
          await existing.remove();
        } catch { /* raced with another remover / locked — add() below will dedupe if it still exists */ }
      } else if (state !== 'unknown') {
        return existing;
      }
    }
  }
  return queue.add(name, data, opts);
}
