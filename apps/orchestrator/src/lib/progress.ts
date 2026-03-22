/**
 * Публикация прогресса видео в Redis pub/sub.
 * Подписчики (SSE-эндпоинт API) стримят события клиенту.
 *
 * Канал: video:progress:{tenantId}:{videoId}
 */
import { getRedisConnection } from './redis';
import { logger } from '../logger';

const log = logger.child({ module: 'progress' });

export async function publishProgress(
  tenantId: string,
  videoId: string,
  stage: string,
  status: string,
  progress: number,
  message?: string | null,
): Promise<void> {
  try {
    const redis = getRedisConnection();
    const channel = `video:progress:${tenantId}:${videoId}`;
    await redis.publish(
      channel,
      JSON.stringify({
        stage,
        status,
        progress: Math.min(100, Math.max(0, Math.round(progress))),
        message: message ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (err) {
    // Не блокируем основной flow если Redis pub/sub упал
    log.warn({ err, tenantId, videoId, stage }, 'Failed to publish progress');
  }
}

/**
 * Вычисляет процент прогресса на основе завершённых этапов сцен.
 * Шкала: 0-10% — старт/скрипт, 10-85% — обработка сцен, 85-100% — композиция.
 */
export function calcSceneProgress(
  scenes: Array<{ type: string; avatarDone: boolean; clipDone: boolean; imageDone: boolean; status: string }>,
): number {
  if (scenes.length === 0) return 10;

  const done = scenes.filter((s) => {
    if (s.type === 'avatar') return s.avatarDone;
    if (s.type === 'clip')   return s.clipDone;
    if (s.type === 'image')  return s.imageDone;
    return s.status === 'completed' || s.status === 'failed';
  }).length;

  return 10 + Math.round((done / scenes.length) * 75);
}
