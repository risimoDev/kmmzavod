import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  _redis = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  });
  _redis.on('error', (err) => logger.error({ err }, 'Redis error'));
  _redis.on('connect', () => logger.info('Redis connected'));
  return _redis;
}

// Separate connection for subscribe — a subscribed client cannot issue commands
let _sub: Redis | null = null;

export function getRedisSubscriber(): Redis {
  if (_sub) return _sub;
  _sub = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  _sub.on('error', (err) => logger.error({ err }, 'Redis subscriber error'));
  return _sub;
}
