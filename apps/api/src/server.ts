import { buildApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { getRedis } from './lib/redis';
import Redis from 'ioredis';

const SERVICE_NAME = 'api';
const HEARTBEAT_KEY = `kmmzavod:heartbeat:${SERVICE_NAME}`;
const HEARTBEAT_INTERVAL = 15_000; // 15s
const RESTART_CHANNEL = 'kmmzavod:service:restart';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info({ port: config.PORT, env: config.NODE_ENV }, '🚀 API сервер запущен');
  } catch (err) {
    logger.fatal({ err }, 'Не удалось запустить сервер');
    process.exit(1);
  }

  // ── Heartbeat: write TTL key every 15s ──────────────────────────────────
  const redis = getRedis();
  const sendHeartbeat = () => {
    redis.set(HEARTBEAT_KEY, JSON.stringify({
      pid: process.pid,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }), 'EX', 30).catch(() => {});
  };
  sendHeartbeat();
  const hbTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  // ── Restart listener via Redis pub/sub ──────────────────────────────────
  const sub = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  });
  await sub.subscribe(RESTART_CHANNEL);
  sub.on('message', (_ch, msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (cmd.service === SERVICE_NAME || cmd.service === 'all') {
        logger.info({ cmd }, 'Получена команда перезапуска, закрываемся...');
        gracefulShutdown();
      }
    } catch {}
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────
  let shuttingDown = false;
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(hbTimer);
    try {
      await redis.del(HEARTBEAT_KEY);
      await sub.unsubscribe(RESTART_CHANNEL);
      sub.disconnect();
      await app.close();
    } catch {}
    logger.info('API сервер остановлен');
    process.exit(0);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

main();
