/**
 * Shared Redis pub/sub subscriber for SSE connections.
 *
 * Uses a SINGLE Redis connection to multiplex all SSE clients, instead of
 * creating a new connection per client (which can exhaust Redis connection limits).
 *
 * Usage:
 *   const unsub = sseSubscriber.subscribe(channel, (message) => { ... });
 *   // later:
 *   unsub();
 */
import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';

type MessageHandler = (message: string) => void;

class SseSubscriber {
  private redis: Redis | null = null;
  /** Map<channel, Set<handler>> — all active listeners per channel */
  private listeners = new Map<string, Set<MessageHandler>>();

  private getConnection(): Redis {
    if (this.redis) return this.redis;
    this.redis = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });
    this.redis.on('error', (err) => logger.error({ err }, 'SSE subscriber Redis error'));
    this.redis.on('message', (channel, message) => {
      const handlers = this.listeners.get(channel);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(message);
        } catch { /* handler error — ignore to protect other listeners */ }
      }
    });
    return this.redis;
  }

  /**
   * Subscribe a handler to a Redis channel.
   * Returns an unsubscribe function — call it when the SSE client disconnects.
   */
  subscribe(channel: string, handler: MessageHandler): () => void {
    const conn = this.getConnection();

    let handlers = this.listeners.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(channel, handlers);
      // First listener for this channel — subscribe at Redis level
      conn.subscribe(channel).catch((err) => {
        logger.error({ err, channel }, 'SSE subscriber: failed to subscribe');
      });
    }
    handlers.add(handler);

    // Return unsubscribe function
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const set = this.listeners.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        // Last listener for this channel — unsubscribe at Redis level
        this.listeners.delete(channel);
        conn.unsubscribe(channel).catch(() => {});
      }
    };
  }

  /** Number of active channels (for monitoring/health checks). */
  get activeChannels(): number {
    return this.listeners.size;
  }

  /** Total number of active listeners across all channels. */
  get activeListeners(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

/** Singleton shared SSE subscriber — uses exactly 1 Redis connection. */
export const sseSubscriber = new SseSubscriber();
