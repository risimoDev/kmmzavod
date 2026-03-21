import Redis from 'ioredis';
import { config } from '../config';

let _conn: Redis | null = null;

export function getRedisConnection(): Redis {
  if (_conn) return _conn;
  _conn = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null, // обязательно для BullMQ
    enableReadyCheck: false,
  });
  return _conn;
}
