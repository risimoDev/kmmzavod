/**
 * Wildberries Card Warmup & SEO Booster via ADB.
 *
 * Органический прогрев карточки товара на Wildberries через реальное мобильное
 * приложение на физической плате:
 * 1. Проверяет чистый мобильный прокси (Anti-Leak защита).
 * 2. Открывает карточку товара по артикулу (nmId/SKU) через диплинк Wildberries.
 * 3. Имитирует живого покупателя:
 *    - листает галерею фотографий товара (свайпы влево)
 *    - прокручивает страницу вниз к описанию и характеристикам
 *    - переходит к отзывам покупателей
 *    - добавляет в избранное (сердечко)
 *    - удерживает карточку открытой 60–180 секунд для накрутки ПФ (поведенческих факторов)
 */
import type { Logger } from 'pino';
import { AdbClient } from './adb-client';
import { ProxyManager, type DeviceIpCheckResult } from './proxy-manager';

export interface WbWarmupRequest {
  deviceId: string;
  sku: string | number; // Артикул WB (например: 1145510159) или полная ссылка
  dwellDurationSeconds?: number; // Время нахождения в карточке (по умолчанию 60с)
  swipePhotos?: boolean; // Листать галерею фото (по умолчанию true)
  readReviews?: boolean; // Скроллить к отзывам (по умолчанию true)
  addToFavorites?: boolean; // Добавить в избранное (сердечко, по умолчанию true)
  checkIpFirst?: boolean; // Проверка прокси перед входом (по умолчанию true)
}

export interface WbWarmupResult {
  ok: boolean;
  sku: string;
  detail?: string;
  ipCheck?: DeviceIpCheckResult;
  stats?: {
    dwellSeconds: number;
    photosSwiped: number;
    addedToFavorites: boolean;
  };
}

/** Extract numeric SKU from string, link or number. */
export function extractWbSku(raw: string | number): string {
  const str = String(raw).trim();
  const match = str.match(/\/catalog\/(\d+)\//) || str.match(/nmId=(\d+)/) || str.match(/\b\d{6,12}\b/);
  return match ? match[1] || match[0] : str.replace(/\D/g, '');
}

export async function runWbWarmup(
  req: WbWarmupRequest,
  adb: AdbClient,
  proxyManager: ProxyManager,
  logger: Logger,
): Promise<WbWarmupResult> {
  const {
    deviceId,
    sku: rawSku,
    dwellDurationSeconds = 60,
    swipePhotos = true,
    readReviews = true,
    addToFavorites = true,
    checkIpFirst = true,
  } = req;

  const sku = extractWbSku(rawSku);
  if (!sku) {
    return { ok: false, sku: String(rawSku), detail: 'Не удалось определить артикул товара Wildberries' };
  }

  let ipCheck: DeviceIpCheckResult | undefined;

  // 1. Guardrail: Anti-Leak check on clean mobile proxy
  if (checkIpFirst) {
    logger.info({ deviceId, sku }, 'wb-warmup: running pre-flight IP check');
    ipCheck = await proxyManager.checkDeviceIp(deviceId);

    if (!ipCheck.ok) {
      return {
        ok: false,
        sku,
        detail: `Не удалось подтвердить прокси на плате: ${ipCheck.error}. Запуск отменён для защиты аккаунта WB.`,
        ipCheck,
      };
    }

    if (ipCheck.leakDetected) {
      logger.error({ deviceId, ip: ipCheck.ip }, 'wb-warmup: IP LEAK DETECTED! Aborting WB session');
      return {
        ok: false,
        sku,
        detail: `Обнаружена утечка прямого IP хоста (${ipCheck.ip})! Прокси не активен. Прогрев отменён во избежание блокировки устройства в WB.`,
        ipCheck,
      };
    }

    logger.info({ deviceId, sku, ip: ipCheck.ip }, 'wb-warmup: IP verified safe for Wildberries');
  }

  try {
    // 2. Wake screen and get dimensions
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard');
    const { width, height } = await adb.getScreenSize(deviceId);

    logger.info({ deviceId, sku, width, height }, 'wb-warmup: opening Wildberries product card');

    // 3. Open product card via deep link or URL intent
    const deepLink = `wildberries://card?nmId=${sku}`;
    const webIntent = `https://www.wildberries.ru/catalog/${sku}/detail.aspx`;

    try {
      await adb.openUrl(deviceId, deepLink, 'com.wildberries.ru');
    } catch {
      await adb.openUrl(deviceId, webIntent, 'com.wildberries.ru');
    }

    // Wait for card to load
    await new Promise((r) => setTimeout(r, 4500));

    let photosSwiped = 0;
    const dwellStart = Date.now();
    const dwellMs = Math.max(15, Math.min(300, dwellDurationSeconds)) * 1000;

    // 4. Swipe product photo gallery
    if (swipePhotos) {
      const swipeCount = 2 + Math.floor(Math.random() * 3); // 2-4 swipes
      logger.info({ deviceId, sku, swipeCount }, 'wb-warmup: browsing product gallery');

      for (let i = 0; i < swipeCount; i++) {
        const y = Math.round(height * (0.32 + Math.random() * 0.08));
        const startX = Math.round(width * (0.82 + Math.random() * 0.08));
        const endX = Math.round(width * (0.16 + Math.random() * 0.08));
        const duration = Math.round(320 + Math.random() * 120);

        await adb.swipe(deviceId, startX, y, endX, y, duration);
        photosSwiped++;
        // Human dwell on each photo
        await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1500));
      }
    }

    // 5. Scroll down to description & specifications
    logger.info({ deviceId, sku }, 'wb-warmup: reading product details');
    const scrollDownY1 = Math.round(height * 0.74);
    const scrollDownY2 = Math.round(height * 0.32);
    await adb.swipe(deviceId, Math.round(width * 0.5), scrollDownY1, Math.round(width * 0.5), scrollDownY2, 400);
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 1500));

    // 6. Read reviews
    if (readReviews) {
      logger.info({ deviceId, sku }, 'wb-warmup: scrolling to reviews');
      await adb.swipe(deviceId, Math.round(width * 0.5), scrollDownY1, Math.round(width * 0.5), scrollDownY2, 450);
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    }

    // 7. Add to Favorites (heart icon near top-right of the card)
    let favAdded = false;
    if (addToFavorites) {
      logger.info({ deviceId, sku }, 'wb-warmup: adding to favorites (heart)');
      // In WB app header, the heart icon is located near the top right: ~91% width, ~6% height
      const heartX = Math.round(width * (0.89 + Math.random() * 0.04));
      const heartY = Math.round(height * (0.055 + Math.random() * 0.02));
      await adb.tap(deviceId, heartX, heartY);
      favAdded = true;
      await new Promise((r) => setTimeout(r, 1500));
    }

    // 8. Fulfill remaining dwell time for maximum algorithmic SEO impact
    const elapsed = Date.now() - dwellStart;
    const remaining = dwellMs - elapsed;
    if (remaining > 0) {
      logger.info({ deviceId, sku, remainingSec: Math.round(remaining / 1000) }, 'wb-warmup: holding dwell time for SEO ranking');
      // Perform gentle micro-scrolls while dwelling
      const intervals = Math.floor(remaining / 6000);
      for (let i = 0; i < intervals; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        // Micro-scroll down or up
        const dy = (Math.random() > 0.5 ? -1 : 1) * Math.round(height * 0.08);
        await adb.swipe(
          deviceId,
          Math.round(width * 0.5),
          Math.round(height * 0.5),
          Math.round(width * 0.5),
          Math.round(height * 0.5 + dy),
          300,
        );
      }
    }

    // 9. Return to home screen
    await adb.home(deviceId);

    logger.info({ deviceId, sku, photosSwiped, favAdded }, 'wb-warmup: session completed successfully');

    return {
      ok: true,
      sku,
      ipCheck,
      stats: {
        dwellSeconds: Math.round((Date.now() - dwellStart) / 1000),
        photosSwiped,
        addedToFavorites: favAdded,
      },
    };
  } catch (err: any) {
    logger.error({ deviceId, sku, err: err.message }, 'wb-warmup: error during execution');
    await adb.home(deviceId).catch(() => {});
    return {
      ok: false,
      sku,
      detail: `Сбой прогрева карточки WB: ${err.message}`,
      ipCheck,
    };
  }
}
