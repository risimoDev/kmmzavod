import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import { deliverQueueIntents } from '../src/lib/queue-intents';

test('failed Redis delivery retains intent and retries with the same job ID', async () => {
  const intent = { id: 'job-id', queue: 'test', name: 'work', payload: { value: 1 } };
  let deleted = false;
  let rejectDelivery = true;
  const attempts: string[] = [];
  const db = { queueIntent: {
    findMany: async () => deleted ? [] : [intent],
    deleteMany: async () => { deleted = true; },
  } } as unknown as PrismaClient;
  const queue = { addBulk: async (jobs: { opts: { jobId: string } }[]) => {
    attempts.push(jobs[0]!.opts.jobId);
    if (rejectDelivery) throw new Error('Redis unavailable');
  } } as unknown as Queue;
  const queues = new Map([['test', queue]]);

  await assert.rejects(deliverQueueIntents(db, queues), /Redis unavailable/);
  assert.equal(deleted, false);
  rejectDelivery = false;
  await deliverQueueIntents(db, queues);
  assert.equal(deleted, true);
  assert.deepEqual(attempts, [intent.id, intent.id]);
});
