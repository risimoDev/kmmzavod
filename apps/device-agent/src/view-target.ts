/**
 * Native ADB Smart View & Organic Account Warmup.
 *
 * Органический просмотр видео целевого аккаунта в Instagram и TikTok
 * напрямую через ADB (без использования стороннего платного ПО):
 * 1. Проверяет мобильный прокси (Anti-Leak).
 * 2. Будит экран и снимает блокировку.
 * 3. Открывает профиль целевого автора через нативный Android Intent.
 * 4. Нажимает на первое видео / Reels.
 * 5. Имитирует живого пользователя:
 *    - органическое удержание (watch time) с джиттером
 *    - двойной тап для лайка с заданной вероятностью
 *    - человекоподобные свайпы вверх
 * 6. Нажимает кнопку Home и возвращается на рабочий стол.
 */
import type { Logger } from 'pino';
import { AdbClient } from './adb-client';
import { ProxyManager, type DeviceIpCheckResult } from './proxy-manager';

export interface ViewTargetRequest {
  deviceId: string;
  platform: 'instagram' | 'tiktok';
  targetUsername: string;
  watchDurationSeconds?: number;
  scrollCount?: number;
  likeProbability?: number;
  checkIpFirst?: boolean;
}

export interface ViewTargetResult {
  ok: boolean;
  detail?: string;
  ipCheck?: DeviceIpCheckResult;
  stats?: {
    platform: string;
    targetUsername: string;
    scrollCount: number;
    baseWatchSeconds: number;
    likesGiven: number;
  };
}

export async function runViewTarget(
  req: ViewTargetRequest,
  adb: AdbClient,
  proxyManager: ProxyManager,
  logger: Logger,
): Promise<ViewTargetResult> {
  const {
    deviceId,
    platform,
    targetUsername,
    watchDurationSeconds = 25,
    scrollCount = 3,
    likeProbability = 0.35,
    checkIpFirst = true,
  } = req;

  const cleanUsername = targetUsername.replace(/^@+/, '').trim();
  let ipCheck: DeviceIpCheckResult | undefined;

  // 1. Guardrail: Anti-Leak check before touching social apps
  if (checkIpFirst) {
    logger.info({ deviceId }, 'view-target: running pre-flight IP check');
    ipCheck = await proxyManager.checkDeviceIp(deviceId);

    if (!ipCheck.ok) {
      logger.warn({ deviceId, error: ipCheck.error }, 'view-target: device IP check failed, aborting');
      return {
        ok: false,
        detail: `Не удалось проверить IP на устройстве: ${ipCheck.error}. Запуск отменён для защиты аккаунта.`,
        ipCheck,
      };
    }

    if (ipCheck.leakDetected) {
      logger.error({ deviceId, ip: ipCheck.ip, hostIp: ipCheck.hostIp }, 'view-target: IP LEAK DETECTED, aborting');
      return {
        ok: false,
        detail: `Обнаружена утечка реального IP хоста (${ipCheck.ip})! Прокси не активен. Просмотр отменён во избежание блокировки.`,
        ipCheck,
      };
    }

    logger.info({ deviceId, ip: ipCheck.ip, country: ipCheck.country }, 'view-target: IP verified safe');
  }

  try {
    // 2. Wake screen and get dimensions
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard');
    const { width, height } = await adb.getScreenSize(deviceId);

    logger.info({ deviceId, platform, cleanUsername, width, height }, 'view-target: launching target profile');

    // 3. Open target profile via deep links
    if (platform === 'instagram') {
      try {
        await adb.openUrl(deviceId, `instagram://user?username=${cleanUsername}`, 'com.instagram.android');
      } catch {
        await adb.openUrl(deviceId, `https://www.instagram.com/${cleanUsername}`);
      }
    } else {
      try {
        await adb.openUrl(deviceId, `snssdk1233://user/profile/${cleanUsername}`);
      } catch {
        await adb.openUrl(deviceId, `https://www.tiktok.com/@${cleanUsername}`);
      }
    }

    // Wait 4.5 seconds for profile and thumbnail grid to render
    await new Promise((r) => setTimeout(r, 4500));

    // 4. Click the first video/reel thumbnail
    // Typically in top third of the post grid (around 25% width, 45% height)
    const thumbX = Math.round(width * (0.24 + Math.random() * 0.06));
    const thumbY = Math.round(height * (0.44 + Math.random() * 0.04));
    logger.info({ deviceId, thumbX, thumbY }, 'view-target: clicking first video thumbnail');
    await adb.tap(deviceId, thumbX, thumbY);
    await new Promise((r) => setTimeout(r, 3000));

    // 5. Watch loop
    let likesGiven = 0;
    const totalScrolls = Math.max(1, Math.min(20, scrollCount));
    const baseSec = Math.max(8, Math.min(180, watchDurationSeconds));

    for (let i = 0; i < totalScrolls; i++) {
      const watchTimeMs = Math.round((baseSec * 1000) + (Math.random() * 6000 - 3000));
      logger.info({ deviceId, video: i + 1, total: totalScrolls, watchSec: Math.round(watchTimeMs / 1000) }, 'view-target: watching video');

      // Watch first half of the video
      const halfTime = Math.round(watchTimeMs * 0.55);
      await new Promise((r) => setTimeout(r, halfTime));

      // Organic like (double tap center with jitter)
      if (Math.random() < likeProbability) {
        const likeX = Math.round(width * (0.48 + Math.random() * 0.06));
        const likeY = Math.round(height * (0.48 + Math.random() * 0.06));
        logger.info({ deviceId, likeX, likeY }, 'view-target: double-tapping like');
        await adb.tap(deviceId, likeX, likeY);
        await new Promise((r) => setTimeout(r, 120));
        await adb.tap(deviceId, likeX, likeY);
        likesGiven++;
        await new Promise((r) => setTimeout(r, 1200));
      }

      // Watch second half
      await new Promise((r) => setTimeout(r, Math.max(1000, watchTimeMs - halfTime)));

      // Swipe to next video (humanized curve)
      if (i < totalScrolls - 1) {
        const startX = Math.round(width * (0.5 + Math.random() * 0.08 - 0.04));
        const startY = Math.round(height * (0.76 + Math.random() * 0.04 - 0.02));
        const endX = Math.round(startX + (Math.random() * 40 - 20));
        const endY = Math.round(height * (0.24 + Math.random() * 0.04 - 0.02));
        const duration = Math.round(360 + Math.random() * 120);

        logger.info({ deviceId, startY, endY, duration }, 'view-target: swiping next video');
        await adb.swipe(deviceId, startX, startY, endX, endY, duration);
        await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1500));
      }
    }

    // 6. Return to home screen
    await adb.home(deviceId);

    return {
      ok: true,
      ipCheck,
      stats: {
        platform,
        targetUsername: cleanUsername,
        scrollCount: totalScrolls,
        baseWatchSeconds: baseSec,
        likesGiven,
      },
    };
  } catch (err: any) {
    logger.error({ deviceId, err: err.message }, 'view-target: execution failed');
    await adb.home(deviceId).catch(() => {});
    return {
      ok: false,
      detail: `Сбой Smart View через ADB: ${err.message}`,
      ipCheck,
    };
  }
}
