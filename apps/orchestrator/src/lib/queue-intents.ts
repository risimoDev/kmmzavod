import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import { StoragePaths, type IStorageClient } from '@kmmzavod/storage';

export async function deliverQueueIntents(db: PrismaClient, queues: ReadonlyMap<string, Queue>, storage?: IStorageClient) {
  const intents = await db.queueIntent.findMany({ orderBy: { createdAt: 'asc' }, take: 100 });
  for (const [name, queue] of queues) {
    const batch = intents.filter(intent => intent.queue === name);
    if (!batch.length) continue;
    await queue.addBulk(batch.map(intent => ({
      name: intent.name, data: intent.payload, opts: { jobId: intent.id },
    })));
    await db.queueIntent.deleteMany({ where: { id: { in: batch.map(intent => intent.id) } } });
  }
  if (!storage) return;
  for (const intent of intents.filter(row => row.queue === 'editor-cleanup')) {
    const { tenantId, projectId } = intent.payload as { tenantId: string; projectId: string };
    const prefix = `${StoragePaths.editorOutputPrefix(tenantId, projectId)}/`;
    const [keys, sourceRefs, editorRefs] = await Promise.all([
      storage.listPrefix(prefix),
      db.sourceVideo.findMany({ where: { tenantId, storageKey: { startsWith: prefix } }, select: { storageKey: true } }),
      db.editSource.findMany({ where: { project: { tenantId }, storageKey: { startsWith: prefix } }, select: { storageKey: true } }),
    ]);
    const keep = new Set([...sourceRefs, ...editorRefs].map(source => source.storageKey));
    for (const key of keys) if (!keep.has(key)) await storage.delete(key);
    await db.queueIntent.deleteMany({ where: { id: intent.id } });
  }
}
