/**
 * Lightweight proxy-fetch for the API service.
 * Reads AI_PROXY_URL from AdminSetting (DB) on each call — no caching needed
 * since health checks are infrequent.
 */
import { db } from './db';

/** Resolve current AI proxy URL from DB, falling back to env. */
export async function getProxyUrl(): Promise<string> {
  try {
    const setting = await db.adminSetting.findUnique({
      where: { key: 'AI_PROXY_URL' },
    });
    const val = setting?.value;
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (val != null && String(val).trim()) return String(val).trim();
  } catch {
    // DB unavailable — fall through to env
  }
  return process.env.AI_PROXY_URL ?? '';
}

/**
 * fetch() routed through a proxy. Uses undici ProxyAgent (bundled with Node 22).
 * Falls back to direct fetch if proxy URL is empty or ProxyAgent fails.
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  const proxy = proxyUrl ?? (await getProxyUrl());
  if (!proxy) return globalThis.fetch(url, init);

  try {
    const { ProxyAgent } = require('undici');
    const dispatcher = new ProxyAgent(proxy);
    return globalThis.fetch(url as any, { ...init, dispatcher } as any);
  } catch {
    return globalThis.fetch(url, init);
  }
}
