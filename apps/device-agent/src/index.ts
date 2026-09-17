import Fastify from 'fastify';
import pino from 'pino';
import { z } from 'zod';
import { config } from './config';
import { AdbClient } from './adb-client';
import { publishToDevice } from './publish';
import { ProxyManager } from './proxy-manager';
import { runViewTarget } from './view-target';
import { runWbWarmup } from './wb-warmup';
import { AutoHealManager } from './auto-heal';

const logger = pino({ transport: { target: 'pino-pretty' } });
const adb = new AdbClient(logger, config.ADB_PATH);
const proxyManager = new ProxyManager(adb, logger);
const autoHeal = new AutoHealManager(adb, logger);

const app = Fastify({ logger: false });

app.get('/health', async () => ({
  ok: true,
  timestamp: new Date().toISOString(),
  hostIp: await proxyManager.refreshHostIp(),
  driver: 'Native ADB Controller (Open-Source, 0$)',
}));

app.get('/devices', async (_req, reply) => {
  try {
    const rawDevices = await adb.listDevices();
    const proxies = proxyManager.getAllProxies();

    return {
      ok: true,
      raw: rawDevices,
      proxies,
    };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Proxy endpoints ──────────────────────────────────────────────────────────

const SetProxyBody = z.object({
  deviceId: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  type: z.enum(['http', 'https', 'socks5', 'residential', 'mobile']).optional(),
});

app.post('/proxy/set', async (req, reply) => {
  const parsed = SetProxyBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  try {
    const check = await proxyManager.setProxy(parsed.data.deviceId, parsed.data);
    return { ok: true, check };
  } catch (err) {
    logger.error({ err }, 'device-agent: setProxy failed');
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const ClearProxyBody = z.object({
  deviceId: z.string().min(1),
});

app.post('/proxy/clear', async (req, reply) => {
  const parsed = ClearProxyBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  try {
    const res = await proxyManager.clearProxy(parsed.data.deviceId);
    return res;
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const CheckProxyBody = z.object({
  deviceId: z.string().min(1),
});

app.post('/proxy/check', async (req, reply) => {
  const parsed = CheckProxyBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  try {
    const check = await proxyManager.checkDeviceIp(parsed.data.deviceId);
    return check;
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Smart View Automation (Instagram & TikTok) ──────────────────────────────

const ViewTargetBody = z.object({
  deviceId: z.string().min(1),
  platform: z.enum(['instagram', 'tiktok']),
  targetUsername: z.string().min(1),
  watchDurationSeconds: z.number().min(5).max(300).optional(),
  scrollCount: z.number().int().min(1).max(30).optional(),
  likeProbability: z.number().min(0).max(1).optional(),
  checkIpFirst: z.boolean().default(true),
});

app.post('/view-target', async (req, reply) => {
  const parsed = ViewTargetBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  try {
    const result = await runViewTarget(parsed.data, adb, proxyManager, logger);
    if (!result.ok) reply.code(502);
    return result;
  } catch (err) {
    logger.error({ err }, 'device-agent: view-target failed');
    reply.code(502);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
});

// ── Wildberries Card Warmup & SEO Booster ───────────────────────────────────

const WbWarmupBody = z.object({
  deviceId: z.string().min(1),
  sku: z.union([z.string(), z.number()]),
  dwellDurationSeconds: z.number().min(10).max(300).optional(),
  swipePhotos: z.boolean().default(true),
  readReviews: z.boolean().default(true),
  addToFavorites: z.boolean().default(true),
  checkIpFirst: z.boolean().default(true),
});

app.post('/wb/warmup', async (req, reply) => {
  const parsed = WbWarmupBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  try {
    const result = await runWbWarmup(parsed.data, adb, proxyManager, logger);
    if (!result.ok) reply.code(502);
    return result;
  } catch (err) {
    logger.error({ err }, 'device-agent: wb-warmup failed');
    reply.code(502);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
});

// ── Publish Video (Instagram & TikTok) ──────────────────────────────────────

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
    const result = await publishToDevice(parsed.data, adb, logger);
    if (!result.ok) reply.code(502);
    return result;
  } catch (err) {
    logger.error({ err }, 'device-agent: publish failed');
    reply.code(502);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
});

// ── Device Control Endpoints ────────────────────────────────────────────────

const DeviceControlBody = z.object({
  deviceId: z.string().min(1),
});

app.post('/device/reboot', async (req, reply) => {
  const parsed = DeviceControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }
  try {
    await adb.reboot(parsed.data.deviceId);
    return { ok: true, message: `Reboot signal sent to ${parsed.data.deviceId}` };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.post('/device/wake', async (req, reply) => {
  const parsed = DeviceControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }
  try {
    await adb.wakeUp(parsed.data.deviceId);
    return { ok: true, message: `Wake signal sent to ${parsed.data.deviceId}` };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.post('/device/home', async (req, reply) => {
  const parsed = DeviceControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }
  try {
    await adb.home(parsed.data.deviceId);
    return { ok: true, message: `Home signal sent to ${parsed.data.deviceId}` };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Auto-Heal & Rack Optimization Endpoints ─────────────────────────────────

const OptimizeFarmBody = z.object({
  deviceIds: z.array(z.string()).optional(),
});

app.post('/farm/optimize', async (req, reply) => {
  const parsed = OptimizeFarmBody.safeParse(req.body || {});
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  try {
    let ids = parsed.data?.deviceIds;
    if (!ids || ids.length === 0) {
      const devList = await adb.listDevices();
      ids = devList.map((d) => d.serial);
    }

    if (!ids || ids.length === 0) {
      return { ok: true, message: 'No devices found to optimize', results: [] };
    }

    const results = await autoHeal.optimizeAllBoards(ids.filter(Boolean));
    return { ok: true, total: results.length, results };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.post('/device/heal', async (req, reply) => {
  const parsed = DeviceControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }
  try {
    await autoHeal.dismissSystemDialogs(parsed.data.deviceId);
    await autoHeal.optimizeBoard(parsed.data.deviceId);
    return { ok: true, message: `Плата ${parsed.data.deviceId} стабилизирована` };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.post('/device/screenshot', async (req, reply) => {
  const parsed = DeviceControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }
  try {
    const base64 = await adb.takeScreenshot(parsed.data.deviceId);
    return { ok: true, data: { data: base64 } };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.post('/device/health', async (req, reply) => {
  const parsed = DeviceControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }
  try {
    const health = await autoHeal.getBoardHealth(parsed.data.deviceId);
    return health;
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.get('/device/:deviceId/health', async (req, reply) => {
  const { deviceId } = req.params as { deviceId: string };
  try {
    const health = await autoHeal.getBoardHealth(deviceId);
    return health;
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Interactive Remote Control Endpoints (Master-Slave enabled) ─────────────

const TapControlBody = z.object({
  deviceId: z.string().min(1),
  x: z.number().optional(),
  y: z.number().optional(),
  xPercent: z.number().min(0).max(1).optional(),
  yPercent: z.number().min(0).max(1).optional(),
  targetDeviceIds: z.array(z.string()).optional(),
});

app.post('/device/control/tap', async (req, reply) => {
  const parsed = TapControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  const { deviceId, x, y, xPercent, yPercent, targetDeviceIds } = parsed.data;
  const targets = Array.from(new Set([deviceId, ...(targetDeviceIds || [])]));

  try {
    const results = await Promise.allSettled(
      targets.map(async (devId) => {
        const coords = await adb.resolveCoordinates(devId, xPercent, yPercent, x, y);
        await adb.tap(devId, coords.x, coords.y);
        return { deviceId: devId, x: coords.x, y: coords.y };
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    return { ok: true, targetsCount: targets.length, successful };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const SwipeControlBody = z.object({
  deviceId: z.string().min(1),
  x1: z.number().optional(),
  y1: z.number().optional(),
  x2: z.number().optional(),
  y2: z.number().optional(),
  x1Percent: z.number().min(0).max(1).optional(),
  y1Percent: z.number().min(0).max(1).optional(),
  x2Percent: z.number().min(0).max(1).optional(),
  y2Percent: z.number().min(0).max(1).optional(),
  durationMs: z.number().int().min(50).max(5000).default(300),
  targetDeviceIds: z.array(z.string()).optional(),
});

app.post('/device/control/swipe', async (req, reply) => {
  const parsed = SwipeControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  const { deviceId, x1, y1, x2, y2, x1Percent, y1Percent, x2Percent, y2Percent, durationMs, targetDeviceIds } = parsed.data;
  const targets = Array.from(new Set([deviceId, ...(targetDeviceIds || [])]));

  try {
    const results = await Promise.allSettled(
      targets.map(async (devId) => {
        const start = await adb.resolveCoordinates(devId, x1Percent, y1Percent, x1, y1);
        const end = await adb.resolveCoordinates(devId, x2Percent, y2Percent, x2, y2);
        await adb.swipe(devId, start.x, start.y, end.x, end.y, durationMs);
        return { deviceId: devId };
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    return { ok: true, targetsCount: targets.length, successful };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const KeyControlBody = z.object({
  deviceId: z.string().min(1),
  key: z.union([
    z.enum(['home', 'back', 'recents', 'power', 'wake', 'volup', 'voldown']),
    z.number().int(),
  ]),
  targetDeviceIds: z.array(z.string()).optional(),
});

app.post('/device/control/key', async (req, reply) => {
  const parsed = KeyControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  const { deviceId, key, targetDeviceIds } = parsed.data;
  const targets = Array.from(new Set([deviceId, ...(targetDeviceIds || [])]));

  try {
    const results = await Promise.allSettled(
      targets.map(async (devId) => {
        if (typeof key === 'number') {
          await adb.keyevent(devId, key);
        } else {
          switch (key) {
            case 'home':
              await adb.home(devId);
              break;
            case 'back':
              await adb.back(devId);
              break;
            case 'recents':
              await adb.recents(devId);
              break;
            case 'power':
              await adb.power(devId);
              break;
            case 'wake':
              await adb.wakeUp(devId);
              break;
            case 'volup':
              await adb.volumeUp(devId);
              break;
            case 'voldown':
              await adb.volumeDown(devId);
              break;
          }
        }
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    return { ok: true, targetsCount: targets.length, successful };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const TextControlBody = z.object({
  deviceId: z.string().min(1),
  text: z.string(),
  targetDeviceIds: z.array(z.string()).optional(),
});

app.post('/device/control/text', async (req, reply) => {
  const parsed = TextControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  const { deviceId, text, targetDeviceIds } = parsed.data;
  const targets = Array.from(new Set([deviceId, ...(targetDeviceIds || [])]));

  try {
    const results = await Promise.allSettled(
      targets.map(async (devId) => {
        await adb.inputText(devId, text);
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    return { ok: true, targetsCount: targets.length, successful };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const OpenAppControlBody = z.object({
  deviceId: z.string().min(1),
  packageName: z.string().min(1),
  targetDeviceIds: z.array(z.string()).optional(),
});

app.post('/device/control/open-app', async (req, reply) => {
  const parsed = OpenAppControlBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, error: parsed.error.flatten() };
  }

  const { deviceId, packageName, targetDeviceIds } = parsed.data;
  const targets = Array.from(new Set([deviceId, ...(targetDeviceIds || [])]));

  try {
    const results = await Promise.allSettled(
      targets.map(async (devId) => {
        await adb.openApp(devId, packageName);
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    return { ok: true, targetsCount: targets.length, successful };
  } catch (err) {
    reply.code(502);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.listen({ host: config.HOST, port: config.PORT }).then(() => {
  logger.info({ host: config.HOST, port: config.PORT }, 'device-agent: listening (Native ADB Controller over AmneziaWG)');
}).catch((err) => {
  logger.error({ err }, 'device-agent: failed to start');
  process.exit(1);
});
