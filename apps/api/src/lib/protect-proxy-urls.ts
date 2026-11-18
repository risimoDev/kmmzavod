import { config } from '../config';
import { protectProxyUrl } from './crypto';
import { db } from './db';

async function protectLegacyUrls() {
  if (!config.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required to migrate proxy URLs');
  let updated = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.socialAccount.findMany({
      where: {
        proxyUrl: { not: null },
        NOT: { proxyUrl: { startsWith: 'encrypted:' } },
        ...(cursor && { id: { gt: cursor } }),
      },
      select: { id: true, proxyUrl: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    if (!rows.length) break;
    for (const { id, proxyUrl } of rows) {
      if (!proxyUrl) continue;
      const result = await db.socialAccount.updateMany({
        where: { id, proxyUrl }, data: { proxyUrl: protectProxyUrl(proxyUrl) },
      });
      updated += result.count;
    }
    cursor = rows.at(-1)?.id;
  }
  console.log(`Protected proxy URLs: ${updated}`);
}

void protectLegacyUrls().catch(() => {
  console.error('Failed to protect legacy proxy URLs');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
