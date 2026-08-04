import Fastify from 'fastify';
import pino from 'pino';
import { z } from 'zod';
import { config } from './config';
import { LaixiClient } from './laixi-client';
import { publishToDevice } from './publish';

const logger = pino({ transport: { target: 'pino-pretty' } });
const laixi = new LaixiClient(config.LAIXI_WS_URL, logger);

const app = Fastify({ logger: false });

app.get('/health', async () => ({ ok: true }));

app.get('/devices', async (_req, reply) => {
  try {
    const devices = await laixi.listDevices();
    return devices;
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const PublishBody = z.object({
  deviceId: z.string().min(1),
  platform: z.enum(['instagram', 'tiktok']),
  videoUrl: z.string().url(),
  caption: z.string().default(''),
});

app.post('/publish', async (req, reply) => {
  const parsed = PublishBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  try {
    const result = await publishToDevice(parsed.data, laixi, logger);
    if (!result.ok) reply.code(502);
    return result;
  } catch (err) {
    logger.error({ err }, 'device-agent: publish failed');
    reply.code(502);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
});

app.listen({ host: config.HOST, port: config.PORT }).then(() => {
  logger.info({ host: config.HOST, port: config.PORT }, 'device-agent: listening (bind this to the AmneziaWG interface only)');
}).catch((err) => {
  logger.error({ err }, 'device-agent: failed to start');
  process.exit(1);
});
