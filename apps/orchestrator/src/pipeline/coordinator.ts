// Pipeline coordinator — converts a single job into fan-out BullMQ tasks
// Called by: pipeline worker in index.ts

import { Queue } from 'bullmq';
import { QUEUE_DEFS, type GptScriptJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';

interface Deps {
  db: PrismaClient;
  gptQueue: Queue;
}

export async function startPipeline(jobId: string, tenantId: string, deps: Deps): Promise<void> {
  const job = await deps.db.job.findUniqueOrThrow({
    where:  { id: jobId },
    select: { payload: true, videoId: true },
  });

  // Mark job + video as running/processing atomically
  await deps.db.$transaction([
    deps.db.job.update({
      where: { id: jobId },
      data:  { status: 'running' },
    }),
    ...(job.videoId ? [
      deps.db.video.update({
        where: { id: job.videoId },
        data:  { status: 'processing' },
      }),
    ] : []),
  ]);

  await deps.db.jobEvent.create({
    data: { jobId, tenantId, stage: 'pipeline', status: 'started', message: 'Pipeline started' },
  });

  const payload = job.payload as Record<string, unknown>;

  const gptPayload: GptScriptJobPayload = {
    jobId,
    tenantId,
    prompt:          (payload['script_prompt'] as string) ?? '',
    projectSettings: (payload['settings']      as Record<string, unknown>) ?? {},
  };

  await deps.gptQueue.add(`gpt:${jobId}`, gptPayload, QUEUE_DEFS.GPT_SCRIPT.defaultJobOptions);
}
