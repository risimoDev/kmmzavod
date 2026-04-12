/**
 * HTTP proxy support for external AI / social API calls.
 *
 * Proxy URL is resolved in order:
 *   1. AdminSetting `AI_PROXY_URL` from the database (cached, refreshed every 60 s)
 *   2. `AI_PROXY_URL` environment variable (fallback)
 *
 * Supports: http://, https://, socks5:// (axios only; fetch — http/https).
 *
 * Internal Docker network calls (redis, postgres, minio, video-processor)
 * are NOT proxied — the agent is only applied to external API clients.
 */
import type { Agent } from 'http';
import { logger } from '../logger';
import { db } from './db';

// ── Cached proxy URL ──────────────────────────────────────────────────────────

let _cachedUrl: string | undefined;
const REFRESH_INTERVAL_MS = 60_000;
let _refreshTimer: ReturnType<typeof setInterval> | undefined;

function currentProxyUrl(): string {
  return _cachedUrl ?? process.env.AI_PROXY_URL ?? '';
}

/**
 * Load proxy URL from AdminSetting DB into the in-memory cache.
 * Call once at startup; afterwards the cache auto-refreshes every 60 s.
 */
export async function loadProxyConfig(): Promise<void> {
  try {
    const setting = await db.adminSetting.findUnique({
      where: { key: 'AI_PROXY_URL' },
    });
    const val = setting?.value;
    _cachedUrl = (typeof val === 'string' ? val : val != null ? String(val) : undefined);
  } catch (err) {
    logger.warn({ err }, 'Failed to read AI_PROXY_URL from AdminSetting, using env');
  }

  // Start background refresh if not already running
  if (!_refreshTimer) {
    _refreshTimer = setInterval(() => {
      loadProxyConfig().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    // Don't prevent process exit
    if (_refreshTimer.unref) _refreshTimer.unref();
  }
}

/** Force-invalidate cache (e.g. after admin updates the setting). */
export function invalidateProxyCache(): void {
  _cachedUrl = undefined;
}

// ── Agent pool ────────────────────────────────────────────────────────────────

const _agents = new Map<string, Agent>();

function getAgentForUrl(url: string): Agent | undefined {
  if (!url) return undefined;
  if (_agents.has(url)) return _agents.get(url);

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ProxyAgent } = require('proxy-agent');
    const agent = new ProxyAgent(url) as Agent;
    _agents.set(url, agent);
    const safeUrl = url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
    logger.info({ proxy: safeUrl }, 'AI proxy agent initialized');
    return agent;
  } catch (err) {
    logger.error({ err }, 'Failed to initialize proxy-agent — AI requests will go direct');
    return undefined;
  }
}

/**
 * Spread into `axios.create({ ...axiosProxyConfig(), ... })` to enable proxy.
 * Sync — reads from in-memory cache. Returns `{}` if no proxy configured.
 *
 * @param overrideUrl  Per-account proxy URL — takes priority over global proxy.
 */
export function axiosProxyConfig(overrideUrl?: string | null): { httpAgent?: Agent; httpsAgent?: Agent } {
  const url = overrideUrl || currentProxyUrl();
  const agent = getAgentForUrl(url);
  if (!agent) return {};
  return { httpAgent: agent, httpsAgent: agent };
}

/**
 * Drop-in replacement for `globalThis.fetch` that routes through the proxy.
 * Uses `undici.ProxyAgent` as the dispatcher (supports http:// and https:// proxies).
 *
 * If proxy is not configured, delegates to native `fetch` with zero overhead.
 *
 * @param overrideProxy  Per-account proxy URL — takes priority over global proxy.
 */
export async function proxyFetch(
  url: string | URL | Request,
  init?: RequestInit,
  overrideProxy?: string | null,
): Promise<Response> {
  const proxyUrl = overrideProxy || currentProxyUrl();
  if (!proxyUrl) return globalThis.fetch(url, init);

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ProxyAgent } = require('node:undici');
    const dispatcher = new ProxyAgent(proxyUrl);
    return globalThis.fetch(url as any, { ...init, dispatcher } as any);
  } catch {
    logger.warn('proxyFetch: undici ProxyAgent failed, using direct fetch');
    return globalThis.fetch(url, init);
  }
}
