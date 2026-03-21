import { buildApp } from './app';
import { config } from './config';
import { logger } from './logger';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info({ port: config.PORT, env: config.NODE_ENV }, '🚀 API сервер запущен');
  } catch (err) {
    logger.fatal({ err }, 'Не удалось запустить сервер');
    process.exit(1);
  }
}

main();
