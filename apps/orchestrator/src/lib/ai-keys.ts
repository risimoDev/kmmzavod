/**
 * Server-side AI provider keys for unattended work (autopilot).
 *
 * The editor's AI Studio historically kept OpenRouter / Fish Audio keys in the
 * browser's localStorage, which a background loop can never see. Resolution:
 *   1. AdminSetting row (`OPENROUTER_API_KEY` / `FISH_AUDIO_API_KEY`), cached 60s
 *   2. undefined → the service falls back to its env var
 */
import type { PrismaClient } from '@kmmzavod/db';

export type AiKeyName = 'OPENROUTER_API_KEY' | 'FISH_AUDIO_API_KEY';

const TTL_MS = 60_000;
const cache = new Map<AiKeyName, { value: string | undefined; at: number }>();

export async function getAiKey(db: PrismaClient, name: AiKeyName): Promise<string | undefined> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: string | undefined;
  try {
    const row = await db.adminSetting.findUnique({ where: { key: name } });
    const v = row?.value;
    value = typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch {
    value = undefined;
  }
  cache.set(name, { value, at: Date.now() });
  return value;
}
