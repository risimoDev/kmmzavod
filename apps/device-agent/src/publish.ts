/**
 * Native ADB video publisher (Instagram Reels, TikTok) — drives the real app to the end.
 *
 *  1. Download the video on the host PC, `adb push` it into the gallery, index it in
 *     MediaStore and share it to the app by content:// URI (file:// is refused by
 *     modern apps).
 *  2. Snapshot the account's own profile (post count / grid) as a baseline.
 *  3. Walk the app's screens by reading them (uiautomator): Reels target → Next → caption
 *     → Share/Post. See publish-flow.ts for the decisions.
 *  4. Wait for the upload to finish, then open the profile again: `ok` is returned ONLY
 *     when the new post is found there (or, without a username, when the app confirms).
 *
 * `posted` tells the caller whether retrying is safe:
 *   no      — nothing reached the platform (failed before tapping Share) → safe to retry;
 *   yes     — verified on the profile;
 *   unknown — Share was tapped but the post could not be confirmed → never auto-retry
 *             (a retry could publish it twice); a human should look at the profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import type { Logger } from 'pino';
import { config } from './config';
import { AdbClient } from './adb-client';
import { PackageResolver } from './package-resolver';
import type { ProxyManager } from './proxy-manager';
import { allowsHashtagTap, decide, findPostButton, hasPublishReceipt, initialFlowState, isAppOffline, isDraftTap, isNewPostOnProfile, isPopupDismissLabel, isPostLabel, uploadPercent, type FlowPlatform } from './publish-flow';
import { snapshotProfile, openProfile, type ProfileSnapshot } from './profile-stats';
import { center, clickTarget, dumpScreen, editTexts, isVisible, saveDebugSnapshot, sleep, tapEl, typeText } from './ui-automation';
import { consultAiAutopilot } from './ai-autopilot';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * AI coordinates → device pixels. The prompt (ai-autopilot.ts) asks for ONE scale: 0–1000
 * relative to the screenshot. Guessing between "pixels" and "0–1000" is impossible for any
 * point in the upper-left 1000×1000 px of a 1080×2400 screen, so nothing is guessed here.
 * Fractions (both ≤ 1) are still accepted, because some models answer 0..1 regardless.
 * Anything outside 0–1000 breaks the contract and is rejected rather than tapped blindly.
 */
export function parseAiCoordinates(
  x: number | undefined,
  y: number | undefined,
  screenSize: { width: number; height: number }
): { x: number; y: number } | null {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x <= 0 || y <= 0 || x > 1000 || y > 1000) return null;
  const fraction = x <= 1 && y <= 1;
  const fx = fraction ? x : x / 1000;
  const fy = fraction ? y : y / 1000;
  return {
    x: Math.max(0, Math.min(screenSize.width - 1, Math.round(fx * screenSize.width))),
    y: Math.max(0, Math.min(screenSize.height - 1, Math.round(fy * screenSize.height))),
  };
}

export interface PublishRequest {
  deviceId: string;
  platform: 'instagram' | 'tiktok' | 'youtube_shorts';
  videoUrl: string;
  caption: string;
  /** The account's own username — needed to verify the post on its profile. */
  username?: string;
  claudehubApiKey?: string;
  aiModel?: string;
}

export type PublishStage = 'download' | 'push' | 'prepare' | 'compose' | 'upload' | 'verify' | 'done';

export interface PublishResult {
  ok: boolean;
  stage: PublishStage;
  posted: 'yes' | 'no' | 'unknown';
  /** false → retrying the same request will fail the same way (or could double-post). */
  retryable: boolean;
  verified?: { app: boolean; profile: boolean | null; receipt?: boolean };
  captionTyped?: boolean;
  onDevicePath?: string;
  detail?: string;
  /** Where the screen + UI dump of a failure were saved on the phone (/sdcard/kmm-debug). */
  debugSnapshot?: string;
}

export interface DevicePublishProgress {
  deviceId: string;
  platform: 'instagram' | 'tiktok' | 'youtube_shorts';
  stage: PublishStage;
  step: string;
  detail?: string;
  percent?: number;
  updatedAt: number;
}

export const activePublishProgress = new Map<string, DevicePublishProgress>();

export function getDevicePublishProgress(deviceId: string): DevicePublishProgress | null {
  return activePublishProgress.get(deviceId) ?? null;
}

export function getAllDevicePublishProgress(): Record<string, DevicePublishProgress> {
  const result: Record<string, DevicePublishProgress> = {};
  for (const [k, v] of activePublishProgress.entries()) {
    result[k] = v;
  }
  return result;
}

function updateProgress(
  deviceId: string,
  p: {
    platform: 'instagram' | 'tiktok' | 'youtube_shorts';
    stage: PublishStage;
    step: string;
    detail?: string;
    percent?: number;
  }
) {
  activePublishProgress.set(deviceId, {
    deviceId,
    platform: p.platform,
    stage: p.stage,
    step: p.step,
    detail: p.detail,
    percent: p.percent,
    updatedAt: Date.now(),
  });
}

/** Max time to get from the share intent to tapping Share/Post. */
const COMPOSE_TIMEOUT_MS = 3 * 60_000;
/** Max time to wait for the upload after Share/Post. */
const UPLOAD_TIMEOUT_MS = 8 * 60_000;
/** After Share: no progress indicator for this long → assume the upload finished. */
const UPLOAD_QUIET_MS = 60_000;
/** Consecutive unrecognised screens before giving up (≈ 2.5 s apart). */
const UNKNOWN_SCREEN_LIMIT = 16;
const PROFILE_CHECKS = 3;
/** App says "no network" and the upload percentage has not moved for this long → stop waiting. */
const UPLOAD_STALL_MS = 90_000;
/** Taps on the final Share/Post button before concluding it does not react. */
const PROFILE_CHECK_GAP_MS = 20_000;
const MEDIA_URI = 'content://media/external/video/media';

/** Check the board route; the proxy manager owns any recovery policy. */
async function checkBoardInternet(
  deviceId: string,
  proxyManager: ProxyManager | undefined,
  logger: Logger,
  reason: string,
  updateProgressFn?: (step: string) => void,
): Promise<{ ok: boolean; ip?: string; detail?: string }> {
  logger.debug({ deviceId, reason }, 'publish: checking board internet connection');
  updateProgressFn?.(`Проверка сети платы (${reason})...`);
  if (!proxyManager) return { ok: true };
  try {
    if (proxyManager.mode === 'private_parallel' || config.PROXY_UPSTREAM_VIA) {
      const guard = await proxyManager.preflight(deviceId);
      return { ok: guard.ok, ip: guard.ipCheck?.ip, detail: guard.detail ?? guard.ipCheck?.error };
    }
    const res = await proxyManager.ensureDeviceInternet(deviceId);
    if (res.ok) {
      updateProgressFn?.(`Сеть платы доступна (IP: ${res.ip || 'OK'})`);
      return res;
    }
    return { ok: false, detail: res.error || 'Не удалось восстановить доступ в интернет на плате' };
  } catch (err) {
    logger.warn({ deviceId, reason, err }, 'publish: board route check failed');
    return { ok: false, detail: 'Ошибка проверки маршрута платы' };
  }
}

export interface PublishToDeviceDeps {
  proxyManager?: ProxyManager;
  logger: Logger;
}

export async function publishToDevice(
  req: PublishRequest,
  adb: AdbClient,
  depsOrProxyManager: PublishToDeviceDeps | any,
  maybeLogger?: Logger,
): Promise<PublishResult> {
  const proxyManager: ProxyManager | undefined = maybeLogger ? depsOrProxyManager : depsOrProxyManager?.proxyManager;
  const logger: Logger = maybeLogger || depsOrProxyManager?.logger || depsOrProxyManager;
  const { deviceId, platform, videoUrl } = req;
  const caption = req.caption.trim();
  const username = req.username?.replace(/^@+/, '').trim() || undefined;

  if (platform === 'youtube_shorts') {
    return {
      ok: false, stage: 'prepare', posted: 'no', retryable: false,
      detail: 'Публикация YouTube Shorts с телефона не автоматизирована — используйте официальный API (OAuth)',
    };
  }
  const flowPlatform: FlowPlatform = platform;

  const fileName = `pub_${platform}_${Date.now()}.mp4`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-pub-'));
  const localFilePath = path.join(tempDir, fileName);
  const onDevicePath = `${config.DOWNLOAD_DIR}/${fileName}`;
  let mediaId: string | null = null;
  let stage: PublishStage = 'download';
  let posted: PublishResult['posted'] = 'no';
  let verifiedProfile = false;
  const overallDeadline = Date.now() + 14 * 60_000;

  const result = (r: Omit<PublishResult, 'stage' | 'posted' | 'onDevicePath'> & Partial<PublishResult>): PublishResult =>
    ({ stage, posted, onDevicePath, ...r });

  try {
    updateProgress(deviceId, { platform, stage: 'download', step: 'Скачивание видеоролика на управляющий ПК...', percent: 10 });
    await cleanupOldUploads(adb, deviceId);

    // 1. Download on the host PC (wired link, no mobile-proxy traffic)
    logger.info({ deviceId, platform }, 'publish: downloading video on host PC');
    await downloadWithRetry(videoUrl, localFilePath, logger);

    // 2. Push into the gallery and index it
    stage = 'push';
    updateProgress(deviceId, { platform, stage: 'push', step: 'Копирование ролика по USB (ADB) в память телефона...', percent: 25 });
    await adb.shell(deviceId, `mkdir -p "${config.DOWNLOAD_DIR}"`).catch(() => {});
    await adb.pushFile(deviceId, localFilePath, onDevicePath);
    await adb.fastShell(deviceId, `chmod 666 "${onDevicePath}"`).catch(() => {});
    await adb.scanMediaFile(deviceId, onDevicePath).catch(() => {});
    updateProgress(deviceId, { platform, stage: 'push', step: 'Регистрация видеоролика в MediaStore Android...', percent: 35 });
    mediaId = await resolveMediaId(adb, deviceId, onDevicePath, fileName);
    const streamUri = mediaId ? `${MEDIA_URI}/${mediaId}` : `file://${onDevicePath}`;

    // 3. App + baseline
    stage = 'prepare';
    updateProgress(deviceId, { platform, stage: 'prepare', step: `Подготовка приложения ${platform === 'tiktok' ? 'TikTok' : 'Instagram'} и проверка профиля...`, percent: 45 });
    await adb.fastShell(deviceId, 'am force-stop com.samsung.android.app.galaxyfinder').catch(() => {});
    await adb.wakeUp(deviceId);
    await adb.fastShell(deviceId, 'svc power stayon true').catch(() => {});
    await adb.fastShell(deviceId, 'wm dismiss-keyguard; input keyevent 82').catch(() => {});

    const internetCheck = await checkBoardInternet(deviceId, proxyManager, logger, 'подготовка к публикации', (msg) => {
      updateProgress(deviceId, { platform, stage: 'prepare', step: msg, percent: 46 });
    });
    if (!internetCheck.ok) {
      return result({ ok: false, retryable: true, detail: internetCheck.detail || 'Маршрут платы перед публикацией не подтверждён' });
    }

    const resolved = await new PackageResolver(adb, logger).resolve(deviceId, platform);
    if (!resolved.installed || !resolved.packageName) {
      return result({ ok: false, retryable: false, detail: resolved.error || `Приложение ${platform} не установлено на телефоне ${deviceId}` });
    }
    const pkg = resolved.packageName;

    // Instagram opens the profile by username (deep link); TikTok via its own "Profile" tab.
    const canReadProfile = flowPlatform === 'tiktok' || Boolean(username);
    let baseline: ProfileSnapshot | null = null;
    if (canReadProfile) {
      baseline = await snapshotProfile(adb, deviceId, flowPlatform, username ?? '', pkg).catch(() => null);
      if (baseline?.wrongAccount) {
        return result({ ok: false, retryable: false, detail: `На плате открыт другой аккаунт TikTok. Ожидается @${username}` });
      }
      if (!baseline?.onProfile) {
        logger.warn({ deviceId, username }, 'publish: could not read a profile baseline');
        baseline = null;
      }
    }

    // 3b. The app must have network: with "Network error" the upload would hang mid-way
    // (seen on the farm: TikTok stuck at 58%). Nothing is posted yet → safe to retry later.
    let before = await dumpScreen(adb, deviceId, 1);
    if (before && before.pkg === pkg && isAppOffline(before)) {
      logger.warn({ deviceId, platform }, 'publish: приложение сообщило об ошибке сети перед публикацией');
      const recovered = await checkBoardInternet(deviceId, proxyManager, logger, 'Network error в приложении перед публикацией', (msg) => {
        updateProgress(deviceId, { platform, stage: 'prepare', step: msg, percent: 48 });
      });
      if (!recovered.ok) return result({ ok: false, retryable: true, detail: recovered.detail || 'Маршрут платы не подтверждён' });
      await adb.fastShell(deviceId, `am force-stop ${pkg}`).catch(() => {});
      await sleep(2000);
      await adb.openApp(deviceId, pkg).catch(() => {});
      await sleep(4000);
      before = await dumpScreen(adb, deviceId, 1);
    }
    if (before && before.pkg === pkg && isAppOffline(before)) {
      const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_offline`, before.xml).catch(() => undefined);
      return result({
        ok: false, retryable: true, debugSnapshot: snap,
        detail: 'Приложение на телефоне без сети («Network error») ещё до публикации — проверьте прокси/интернет платы',
      });
    }

    // 4. Share the video into the app
    const component = await pickShareComponent(adb, deviceId, pkg, flowPlatform);
    let amCmd = `am start -a android.intent.action.SEND -t video/mp4 -f 0x10000001 --eu android.intent.extra.STREAM "${streamUri}" --grant-read-uri-permission ${component ? `-n ${component}` : `-p ${pkg}`}`;
    let amOut = await adb.fastShell(deviceId, amCmd).catch((err: Error) => err.message);
    logger.info({ deviceId, platform, component, amOut: (amOut || '').trim() }, 'publish: am start executed');

    const amFailed = !amOut || /Error|Exception|SecurityException|Permission Denial|not exported|does not exist|unable to resolve/i.test(amOut) || (!/Starting: Intent/i.test(amOut) && !/intent has been delivered/i.test(amOut));
    if (component && amFailed) {
      logger.warn({ deviceId, component, amOut: (amOut || '').trim() }, 'publish: specific component failed, falling back to package-level intent');
      amCmd = `am start -a android.intent.action.SEND -t video/mp4 -f 0x10000000 --eu android.intent.extra.STREAM "${streamUri}" --grant-read-uri-permission -p ${pkg}`;
      amOut = await adb.fastShell(deviceId, amCmd).catch((err: Error) => err.message);
      logger.info({ deviceId, platform, amOut: (amOut || '').trim() }, 'publish: fallback am start executed');
    }
    await sleep(3500);

    // 5. Walk the screens up to Share/Post
    stage = 'compose';
    updateProgress(deviceId, { platform, stage: 'compose', step: 'Открытие видео в редакторе публикации...', percent: 55 });
    const st = initialFlowState();
    let captionTyped = !caption;
    let unknown = 0;
    let aiAdviceAttempts = 0;
    let hashtagAttempts = 0;
    const MAX_AI_ADVICE = 4; // cap AI calls per publish flow (budget & time protection)
    const composeDeadline = Date.now() + COMPOSE_TIMEOUT_MS;
    let lastScreen: any = null;
    const isLauncherOrSys = (p?: string) =>
      !p || /launcher|galaxyfinder|finder|nexuslauncher|trebuchet|miui\.home|touchwiz|systemui/i.test(p);

    while (!st.shareTapped) {
      if (Date.now() > overallDeadline) {
        const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_overall_timeout`, lastScreen?.xml).catch(() => undefined);
        return result({ ok: false, retryable: true, debugSnapshot: snap, detail: 'Превышен общий лимит времени публикации на устройстве (14 мин)' });
      }
      if (Date.now() > composeDeadline) {
        const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_timeout`, lastScreen?.xml).catch(() => undefined);
        return result({ ok: false, retryable: true, debugSnapshot: snap, detail: 'Не удалось дойти до кнопки публикации за 3 мин' });
      }
      const screen = await dumpScreen(adb, deviceId);
      lastScreen = screen;
      if (!screen) {
        unknown++;
      } else if (isLauncherOrSys(screen.pkg)) {
        unknown++;
        logger.warn({ deviceId, platform, pkg: screen.pkg, unknown }, 'publish: phone is on launcher/lockscreen/finder — triggering active recovery');
        // If Samsung Galaxy Finder or App Drawer is open, press BACK to dismiss it immediately
        if (/galaxyfinder|finder/i.test(screen.pkg || '')) {
          logger.info({ deviceId }, 'publish: dismissing Samsung Galaxy Finder / App Drawer');
          await adb.fastShell(deviceId, 'input keyevent 4').catch(() => {});
          await sleep(800);
        }

        if (unknown >= UNKNOWN_SCREEN_LIMIT) {
          const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_launcher`, screen?.xml).catch(() => undefined);
          return result({
            ok: false, retryable: true, debugSnapshot: snap,
            detail: `Приложение ${platform} не удалось открыть за ${UNKNOWN_SCREEN_LIMIT} попыток — экран остаётся на рабочем столе (${screen?.pkg || 'launcher'}). Проверьте плату.`,
          });
        }

        // 1. Wake, unlock and dismiss swipe-lockscreen
        await adb.wakeUp(deviceId).catch(() => {});
        await adb.fastShell(deviceId, 'wm dismiss-keyguard; input keyevent 82').catch(() => {});
        const { width: sw, height: sh } = await adb.getScreenSize(deviceId).catch(() => ({ width: 1080, height: 2400 }));
        await adb.swipe(deviceId, Math.round(sw / 2), Math.round(sh * 0.8), Math.round(sw / 2), Math.round(sh * 0.25), 250).catch(() => {});

        // ── AI Autopilot Advisor on launcher/stuck screen ──
        const launcherScreen = unknown >= 3 && aiAdviceAttempts < MAX_AI_ADVICE
          ? await dumpScreen(adb, deviceId, 1) : null;
        if (launcherScreen && !isLauncherOrSys(launcherScreen.pkg)) continue;
        if (launcherScreen) {
          aiAdviceAttempts++;
          logger.info({ deviceId, platform, unknown, aiAdviceAttempts }, 'publish: ИИ-автопилот анализирует экран рабочего стола/системы');
          updateProgress(deviceId, { platform, stage: 'compose', step: 'ИИ-автопилот: восстановление приложения с рабочего стола...', percent: 58 });
          const fastShot = await adb.takeScreenshotFast(deviceId).catch(() => null);
          const base64Screenshot = fastShot?.data || await adb.takeScreenshot(deviceId).catch(() => undefined);
          const aiDecision = await consultAiAutopilot({
            platform: flowPlatform,
            deviceId,
            stage,
            st,
            hasCaption: !!caption,
            captionText: caption,
            screen: launcherScreen,
            base64Screenshot,
            screenSize: { width: sw, height: sh },
            apiKey: req.claudehubApiKey,
            model: req.aiModel,
            logger,
          }).catch((err) => {
            logger.warn({ err: (err as Error).message }, 'publish: AI Autopilot error on launcher');
            return null;
          });

          if (aiDecision) {
            const currentScreen = await dumpScreen(adb, deviceId, 1);
            if (!currentScreen || currentScreen.xml !== launcherScreen.xml) continue;
            updateProgress(deviceId, { platform, stage: 'compose', step: `ИИ: ${aiDecision.reason || 'восстановление'}`, percent: 60 });
            if (aiDecision.action === 'tap' || aiDecision.action === 'tap_coord') {
              const targetEl = aiDecision.targetText
                ? launcherScreen.els.find((e) => new RegExp(escapeRegExp(aiDecision.targetText!.trim()), 'i').test(`${e.text} ${e.desc}`))
                : undefined;
              const coords = parseAiCoordinates(aiDecision.x, aiDecision.y, { width: sw, height: sh });
              const point = targetEl ? center(isVisible(targetEl) ? targetEl : clickTarget(targetEl)) : coords;
              if (point && isDraftTap(launcherScreen, point)) {
                return result({ ok: false, retryable: false, detail: 'Автопилот остановился у кнопки черновиков' });
              }
              if (targetEl) {
                logger.info({ deviceId, targetText: aiDecision.targetText, reason: aiDecision.reason }, 'publish: ИИ нажал элемент на рабочем столе');
                await tapEl(adb, deviceId, targetEl);
                await sleep(2000);
                continue;
              } else if (coords) {
                logger.info({ deviceId, x: coords.x, y: coords.y, reason: aiDecision.reason }, 'publish: ИИ нажал по координатам на экране');
                await adb.tap(deviceId, coords.x, coords.y);
                await sleep(2000);
                continue;
              }
            }
            if (aiDecision.action === 'key_back') {
              logger.info({ deviceId, reason: aiDecision.reason }, 'publish: ИИ нажал Назад на экране');
              await adb.fastShell(deviceId, 'input keyevent 4').catch(() => {});
              await sleep(2000);
              continue;
            }
            if (aiDecision.action === 'swipe_up') {
              logger.info({ deviceId, reason: aiDecision.reason }, 'publish: ИИ свайпнул вверх');
              await adb.swipe(deviceId, Math.round(sw / 2), Math.round(sh * 0.75), Math.round(sw / 2), Math.round(sh * 0.25), 350).catch(() => {});
              await sleep(2000);
              continue;
            }
          }
        }

        // 2. Re-dispatch share intent or launch app
        if (unknown <= 4) {
          logger.info({ deviceId, attempt: unknown }, 'publish: re-dispatching share intent');
          await adb.fastShell(deviceId, amCmd).catch(() => {});
        } else if (unknown <= 8) {
          logger.info({ deviceId, attempt: unknown }, 'publish: launching target app directly');
          await adb.openApp(deviceId, pkg).catch(() => {});
        } else {
          logger.info({ deviceId, attempt: unknown }, 'publish: launching via monkey runner');
          await adb.fastShell(deviceId, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`).catch(() => {});
        }
        await sleep(3000);
        continue;
      } else {
        const action = decide(flowPlatform, screen, st, !!caption, caption);
        if (action.kind === 'error') {
          const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_error`, screen.xml).catch(() => undefined);
          return result({ ok: false, retryable: action.retryable, debugSnapshot: snap, detail: action.why });
        }
        if (action.kind === 'caption') {
          updateProgress(deviceId, { platform, stage: 'compose', step: 'Ввод описания и хэштегов...', percent: 72 });
          await tapEl(adb, deviceId, action.el);
          await sleep(700);
          try {
            await typeText(adb, deviceId, caption);
          } catch (err) {
            return result({ ok: false, retryable: false, detail: (err as Error).message });
          }
          st.captionDone = true;
          captionTyped = await captionLanded(adb, deviceId, caption);
          updateProgress(deviceId, { platform, stage: 'compose', step: captionTyped ? 'Описание проверено' : 'Описание введено', percent: 78 });
          await hideKeyboard(adb, deviceId);
          unknown = 0;
          continue;
        }
        if (action.kind === 'hashtag') {
          const suggestion = hashtagAttempts === 0 ? action.suggestion : undefined;
          if (hashtagAttempts >= 2 || (!suggestion && !action.field.focused)) {
            const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_hashtag`, screen.xml).catch(() => undefined);
            return result({ ok: false, retryable: false, captionTyped, debugSnapshot: snap, detail: `TikTok не закрыл подсказки для ${action.tag}` });
          }
          updateProgress(deviceId, { platform, stage: 'compose', step: `Подтверждение хештега ${action.tag}`, percent: 80 });
          hashtagAttempts++;
          if (suggestion) {
            await tapEl(adb, deviceId, suggestion);
          } else {
            // Finish the existing token without choosing a related tag or leaving the editor.
            await adb.fastShell(deviceId, 'input keyevent 123'); // KEYCODE_MOVE_END
            await typeText(adb, deviceId, ' ');
          }
          await hideKeyboard(adb, deviceId);
          unknown = 0;
          await sleep(900);
          continue;
        }
        if (action.kind === 'tap') {
          logger.info({ deviceId, platform, step: action.why }, 'publish: tap');
          if (action.marks === 'share') {
            updateProgress(deviceId, { platform, stage: 'compose', step: 'Нажатие кнопки публикации («Опубликовать»)...', percent: 84 });
          } else if (action.marks === 'next') {
            updateProgress(deviceId, { platform, stage: 'compose', step: 'Переход к следующему экрану («Далее»)...', percent: 65 });
          } else if (action.marks === 'target') {
            updateProgress(deviceId, { platform, stage: 'compose', step: `Выбор формата (${action.why})...`, percent: 60 });
          }
          if (action.marks === 'share') { st.shareTapped = true; posted = 'unknown'; }
          await tapEl(adb, deviceId, action.el);
          if (action.marks === 'target') st.targetChosen = true;
          if (action.marks === 'next') st.nextTaps++;
          unknown = 0;
          if (!st.shareTapped) await sleep(2500);
          continue;
        }
        unknown++;

        // ── AI Autopilot Advisor Fallback (ClaudeHub Vision) ─────────────────
        if (unknown >= 3 && aiAdviceAttempts < MAX_AI_ADVICE && screen) {
          aiAdviceAttempts++;
          logger.info({ deviceId, platform, unknown, aiAdviceAttempts }, 'publish: asking AI Autopilot advisor to analyze stuck screen');
          updateProgress(deviceId, { platform, stage: 'compose', step: 'ИИ-автопилот: анализ экрана через Gemini Flash 3.8...', detail: 'Анализ снимка и разметки экрана', percent: 65 });
          const screenSize = await adb.getScreenSize(deviceId).catch(() => ({ width: 1080, height: 2400 }));
          const fastShot = await adb.takeScreenshotFast(deviceId).catch(() => null);
          const base64Screenshot = fastShot?.data || await adb.takeScreenshot(deviceId).catch(() => undefined);

          const aiDecision = await consultAiAutopilot({
            platform: flowPlatform,
            deviceId,
            stage,
            st,
            hasCaption: !!caption,
            captionText: caption,
            screen,
            base64Screenshot,
            screenSize,
            apiKey: req.claudehubApiKey,
            model: req.aiModel,
            logger,
          }).catch((err) => {
            logger.warn({ err: (err as Error).message }, 'publish: AI Autopilot error, continuing standard flow');
            return null;
          });

          if (aiDecision) {
            const currentScreen = await dumpScreen(adb, deviceId, 1);
            if (!currentScreen || currentScreen.xml !== screen.xml) continue;
            updateProgress(deviceId, {
              platform,
              stage: 'compose',
              step: `ИИ: ${aiDecision.reason || 'действие на экране'}`,
              detail: aiDecision.targetText ? `Кнопка: ${aiDecision.targetText}` : (aiDecision.action || undefined),
              percent: 70,
            });

            if (aiDecision.action === 'abort') {
              const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_ai_abort`, screen?.xml).catch(() => undefined);
              return result({
                ok: false,
                retryable: false,
                debugSnapshot: snap,
                detail: `ИИ автопилот: ${aiDecision.reason}`,
              });
            }

            if (aiDecision.action === 'require_human') {
              const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_require_human`, screen?.xml).catch(() => undefined);
              return result({
                ok: false,
                retryable: false,
                debugSnapshot: snap,
                detail: `ИИ автопилот: ${aiDecision.reason || 'требуется подтверждение человека'}`,
              });
            }

            if (aiDecision.action === 'retry_network') {
              logger.info({ deviceId, platform, reason: aiDecision.reason }, 'publish: AI Autopilot retry network requested');
              updateProgress(deviceId, { platform, stage: 'upload', step: 'ИИ: повтор отправки и самовосстановление сети...', percent: 75 });
              const recovered = await checkBoardInternet(deviceId, proxyManager, logger, 'ИИ запрос на повтор сети', (msg) => {
                updateProgress(deviceId, { platform, stage: 'upload', step: msg, percent: 76 });
              });
              if (!recovered.ok) return result({ ok: false, retryable: true, detail: recovered.detail || 'Маршрут платы не подтверждён' });
              const retryBtn = screen.els.find((e) => /try again|повторить|retry/i.test(`${e.text} ${e.desc}`));
              if (retryBtn) await tapEl(adb, deviceId, retryBtn);
              unknown = 0;
              await sleep(2000);
              continue;
            }

            if (aiDecision.action === 'key_back' && !st.captionDone) {
              logger.info({ deviceId, platform, reason: aiDecision.reason }, 'publish: AI Autopilot pressed BACK');
              await adb.fastShell(deviceId, 'input keyevent 4').catch(() => {});
              unknown = 0;
              await sleep(1500);
              continue;
            }

            if (aiDecision.action === 'swipe_up') {
              logger.info({ deviceId, platform, reason: aiDecision.reason }, 'publish: AI Autopilot swiped UP');
              await adb.swipe(deviceId, Math.round(screenSize.width / 2), Math.round(screenSize.height * 0.75), Math.round(screenSize.width / 2), Math.round(screenSize.height * 0.35), 300).catch(() => {});
              unknown = 0;
              await sleep(1500);
              continue;
            }

            if (aiDecision.action === 'type_caption' && aiDecision.screenType === 'compose' && caption && !st.captionDone) {
              const fields = editTexts(screen).filter((el) => el.enabled);
              const target = aiDecision.targetText?.trim().toLowerCase();
              const editField = target
                ? fields.find((el) => [el.text, el.desc].some((label) => label.trim().toLowerCase() === target))
                : fields.length === 1 ? fields[0] : undefined;
              if (!editField) continue;
              updateProgress(deviceId, { platform, stage: 'compose', step: 'ИИ: ввод описания в поле редактора...', percent: 74 });
              await tapEl(adb, deviceId, editField);
              await sleep(800);
              await typeText(adb, deviceId, caption);
              st.captionDone = true;
              captionTyped = await captionLanded(adb, deviceId, caption);
              updateProgress(deviceId, { platform, stage: 'compose', step: captionTyped ? 'ИИ: описание проверено' : 'ИИ: описание введено', percent: 79 });
              await hideKeyboard(adb, deviceId);
              unknown = 0;
              await sleep(1500);
              continue;
            }

            if (aiDecision.action === 'tap' || aiDecision.action === 'tap_coord') {
              const target = aiDecision.targetText?.trim().toLowerCase();
              if (!target || (flowPlatform === 'tiktok' && !allowsHashtagTap(target, caption))) continue;
              if ((aiDecision.screenType === 'modal_dialog' || /permissioncontroller|packageinstaller/.test(screen.pkg)) && !isPopupDismissLabel(target)) continue;
              const targetEl = screen.els.find((el) =>
                el.enabled && isVisible(el) && clickTarget(el).clickable &&
                [el.text, el.desc].some((label) => label.trim().toLowerCase() === target)
              );
              const point = targetEl ? center(targetEl) : null;
              if (point && isDraftTap(screen, point)) {
                return result({ ok: false, retryable: false, detail: 'Автопилот остановился у кнопки черновиков' });
              }

              if (point) {
                const postButton = findPostButton(screen, flowPlatform);
                const postBounds = postButton?.bounds;
                const isPostTarget = postBounds && point.x >= postBounds[0] && point.x < postBounds[2] &&
                  point.y >= postBounds[1] && point.y < postBounds[3];
                // An unknown screen never grants permission to submit. Only decide() can mark a final tap.
                if (aiDecision.marks === 'share' || isPostLabel(flowPlatform, target) || isPostTarget) {
                  logger.warn({ deviceId, platform, target }, 'publish: AI post tap deferred to deterministic compose flow');
                  continue;
                }
                logger.info({ deviceId, platform, ...point, reason: aiDecision.reason }, 'publish: AI Autopilot tapping target');
                await adb.tap(deviceId, point.x, point.y);
                if (aiDecision.marks === 'target') st.targetChosen = true;
                if (aiDecision.marks === 'next') st.nextTaps++;
                unknown = 0;
                await sleep(2500);
                continue;
              }
            }
          }
        }
      }
      if (unknown >= UNKNOWN_SCREEN_LIMIT) {
        const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_unknown`, screen?.xml).catch(() => undefined);
        return result({
          ok: false, retryable: true, debugSnapshot: snap,
          detail: `Экран приложения не распознан (${screen?.pkg || 'дамп недоступен'}) — снимок сохранён в ${snap ?? '/sdcard/kmm-debug'}`,
        });
      }
      await sleep(2000);
    }

    // 6. Upload: wait for the app's confirmation / the progress to finish
    stage = 'upload';
    updateProgress(deviceId, { platform, stage: 'upload', step: `Загрузка видеоролика на сервер ${platform === 'tiktok' ? 'TikTok' : 'Instagram'}...`, percent: 86 });
    let appConfirmed = false;
    let publishReceipt = false;
    let offline = false;
    let lastPct: number | null = null;
    let lastPctChange = Date.now();
    let lastActivity = Date.now();
    const uploadDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
    let firstUploadPoll = true;
    while (Date.now() < uploadDeadline && Date.now() < overallDeadline && Date.now() - lastActivity < UPLOAD_QUIET_MS) {
      await sleep(firstUploadPoll ? 750 : 3_000);
      firstUploadPoll = false;
      const screen = await dumpScreen(adb, deviceId, 1);
      const pct = screen ? uploadPercent(screen) : null;
      if (screen && isAppOffline(screen)) offline = true;
      if (pct != null && pct !== lastPct) {
        lastPct = pct;
        lastPctChange = Date.now();
        lastActivity = Date.now();
        updateProgress(deviceId, { platform, stage: 'upload', step: `Загрузка видеоролика на сервер (${lastPct}%)...`, percent: Math.min(94, 85 + Math.round(lastPct * 0.1)) });
      }
      // A stalled upload can still have an uncertain result. Confirm it in the profile.
      if (offline && Date.now() - lastPctChange > UPLOAD_STALL_MS) {
        logger.warn({ deviceId, platform, lastPct }, 'publish: app offline, upload stalled');
        if (proxyManager?.mode !== 'private_parallel' && !config.PROXY_UPSTREAM_VIA) {
          await checkBoardInternet(deviceId, proxyManager, logger, 'зависание загрузки ролика', (msg) => {
            updateProgress(deviceId, { platform, stage: 'upload', step: msg, percent: 88 });
          });
        }
        break;
      }

      if (screen?.pkg === pkg && hasPublishReceipt(screen)) {
        appConfirmed = true;
        publishReceipt = true;
        break;
      }
      if (screen) {
        const action = decide(flowPlatform, screen, st, !!caption);
        if (action.kind === 'success' && !offline && pct == null) { appConfirmed = true; break; }
        if (action.kind === 'error') {
          const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_upload`, screen.xml).catch(() => undefined);
          return result({ ok: false, retryable: false, debugSnapshot: snap, captionTyped, detail: `${action.why} — проверьте профиль вручную` });
        }
        if (action.kind === 'tap') { await tapEl(adb, deviceId, action.el); lastActivity = Date.now(); }
        if (action.kind === 'progress' && !offline) lastActivity = Date.now();
      }

      // Back on the app's main screen with no upload badge and no network error: the app
      // accepted the post (verified on the profile below when possible).
      if (!offline && pct == null) {
        const top = await adb.fastShell(deviceId, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"').catch(() => '');
        if (/MainActivity|MainTabActivity|TabActivity/i.test(top) && !/publish|edit|compose|record/i.test(top)) {
          logger.info({ deviceId, platform, top }, 'publish: back on the main screen after share');
          appConfirmed = true;
          break;
        }
      }
    }

    // 7. Verify on the profile
    stage = 'verify';
    updateProgress(deviceId, { platform, stage: 'verify', step: 'Верификация: проверка появления видео в профиле...', percent: 95 });
    let profileVerified: boolean | null = null;
    let stuckAt: number | null = null;
    let wrongAccount = false;
    if (canReadProfile) {
      for (let i = 0; i < PROFILE_CHECKS && Date.now() < overallDeadline; i++) {
        let after = await snapshotProfile(adb, deviceId, flowPlatform, username ?? '', pkg).catch(() => null);
        // TikTok shows the new post in the grid with a "96%" badge while it still uploads.
        // Confirm only once the upload has finished — a post stuck at 96% is not published.
        // The wait is capped by both UPLOAD_TIMEOUT_MS and the overall publish deadline:
        // without the cap 3 checks × 8 min keep the device mutex held far past the
        // orchestrator's 20-min HTTP timeout.
        const uploadWaitUntil = Math.min(Date.now() + UPLOAD_TIMEOUT_MS, overallDeadline);
        let lastUploadPct: number | null = null;
        let lastUploadChange = Date.now();
        while (after?.uploading != null && Date.now() < uploadWaitUntil) {
          if (after.uploading !== lastUploadPct) { lastUploadPct = after.uploading; lastUploadChange = Date.now(); }
          if (Date.now() - lastUploadChange > UPLOAD_STALL_MS) break;
          logger.info({ deviceId, platform, uploading: after.uploading }, 'publish: post still uploading in the profile grid');
          await sleep(15_000);
          after = await snapshotProfile(adb, deviceId, flowPlatform, username ?? '', pkg, false).catch(() => null);
        }
        if (after?.uploading != null) { stuckAt = after.uploading; profileVerified = false; break; }
        if (after?.wrongAccount) { wrongAccount = true; break; }
        if (after?.onProfile) {
          if (baseline && isNewPostOnProfile(baseline, after)) { profileVerified = true; break; }
          profileVerified = false;
        }
        if (i < PROFILE_CHECKS - 1 && Date.now() + PROFILE_CHECK_GAP_MS < overallDeadline) await sleep(PROFILE_CHECK_GAP_MS);
      }
    }
    if (profileVerified === true) verifiedProfile = true;
    // A completion notice is stronger than a return to the feed or disappearance of an upload badge.
    const verifiedReceipt = publishReceipt && !wrongAccount && stuckAt == null && !offline &&
      Boolean(baseline?.onProfile || profileVerified !== null);
    const verified = { app: appConfirmed, profile: profileVerified, ...(verifiedReceipt && { receipt: true }) };
    if (!verifiedProfile && !verifiedReceipt) {
      // Capture the screen the app is on now — before leaving it.
      const unconfirmedScreen = await dumpScreen(adb, deviceId, 1);
      const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_unconfirmed`, unconfirmedScreen?.xml).catch(() => undefined);
      await adb.home(deviceId).catch(() => {});
      return result({
        ok: false, posted: 'unknown', retryable: false, verified, captionTyped, debugSnapshot: snap,
        detail: wrongAccount
          ? 'При проверке на плате открыт другой аккаунт TikTok — завершение публикации не подтверждено'
          : stuckAt != null
          ? `Последний статус загрузки в профиле — ${stuckAt}%. Завершение не подтверждено.`
          : offline
          ? `Приложение на телефоне потеряло сеть («Network error»)${lastPct != null ? `, последний статус загрузки — ${lastPct}%` : ''}. Завершение не подтверждено.`
          : profileVerified === false
          ? 'Профиль открыт, но данных недостаточно, чтобы подтвердить новый ролик'
          : canReadProfile
            ? 'Профиль не удалось проверить — проверьте публикацию вручную'
            : 'Приложение не подтвердило публикацию, а профиль Instagram проверить нельзя (у аккаунта не указан username) — проверьте вручную',
      });
    }

    await adb.home(deviceId).catch(() => {});
    stage = 'done';
    posted = 'yes';
    const confirmation = verifiedProfile ? 'Публикация подтверждена в профиле' : 'Приложение подтвердило публикацию';
    updateProgress(deviceId, { platform, stage: 'done', step: confirmation, percent: 100 });
    logger.info({ deviceId, platform, verified, captionTyped }, 'publish: post confirmed');
    return result({
      ok: true, retryable: false, verified, captionTyped,
      ...(!captionTyped ? { detail: 'Пост опубликован, но подпись не удалось проверить в поле ввода' }
        : !verifiedProfile ? { detail: confirmation } : {}),
    });
  } catch (err) {
    logger.error({ deviceId, platform, stage, err: (err as Error).message }, 'publish: failed');
    updateProgress(deviceId, { platform, stage, step: `Ошибка публикации (${stage}): ${(err as Error).message}`, percent: 0 });
    const errScreen = await dumpScreen(adb, deviceId, 1).catch(() => null);
    const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_exception`, errScreen?.xml).catch(() => undefined);
    return result({ ok: false, retryable: posted === 'no', debugSnapshot: snap, detail: `Ошибка публикации через ADB (${stage}): ${(err as Error).message}` });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Keep the gallery file while the outcome is unknown (the app may still be reading it).
    if (posted === 'yes' && verifiedProfile) await removeFromGallery(adb, deviceId, onDevicePath, mediaId);
    setTimeout(() => {
      activePublishProgress.delete(deviceId);
    }, 15_000).unref();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Download to `dest`, retrying transient network errors (ECONNRESET etc.). */
async function downloadWithRetry(url: string, dest: string, logger: Logger, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      const response = await axios({ method: 'GET', url, responseType: 'stream', timeout: 120_000 });
      await new Promise<void>((resolve, reject) => {
        const writer = fs.createWriteStream(dest);
        response.data.on('error', reject);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.pipe(writer);
      });
      if (fs.statSync(dest).size === 0) throw new Error('downloaded video is empty');
      return;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // 4xx = expired/invalid link: retrying the same URL will not help.
      if (i >= attempts || (status && status >= 400 && status < 500)) throw err;
      logger.warn({ attempt: i, err: (err as Error).message }, 'publish: download failed, retrying');
      await sleep(3000 * i);
    }
  }
}

/** MediaStore _id of the pushed file (needed for a content:// URI). */
async function resolveMediaId(
  adb: AdbClient,
  deviceId: string,
  onDevicePath: string,
  fileName: string,
): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cleanTitle = fileName.replace(/\.[^.]+$/, '');

  // 1. Direct synchronous insert into MediaStore via Android content CLI:
  // Immediately allocates a row in MediaProvider and returns "Row: content://media/external/video/media/<id>"
  const insertCmd = `content insert --uri ${MEDIA_URI} --bind _data:s:"${onDevicePath}" --bind mime_type:s:"video/mp4" --bind _display_name:s:"${fileName}" --bind title:s:"${cleanTitle}" --bind date_added:i:${nowSec}`;
  const insertOut = await adb.fastShell(deviceId, insertCmd).catch(() => '');
  const insertMatch = /(?:Row:.*\/|content:\/\/.*\/|_id=?)(\d+)/i.exec(insertOut);
  if (insertMatch) return insertMatch[1];

  // 2. Poll MediaStore with queries
  for (let i = 0; i < 8; i++) {
    // Exact path query
    const pathQuery = `content query --uri ${MEDIA_URI} --projection _id --where "_data='${onDevicePath}'"`;
    const outPath = await adb.fastShell(deviceId, pathQuery).catch(() => '');
    const mPath = /_id=(\d+)/.exec(outPath);
    if (mPath) return mPath[1];

    // Display name query
    const nameQuery = `content query --uri ${MEDIA_URI} --projection _id --where "_display_name='${fileName}'"`;
    const outName = await adb.fastShell(deviceId, nameQuery).catch(() => '');
    const mName = /_id=(\d+)/.exec(outName);
    if (mName) return mName[1];

    if (i === 1) {
      await adb.scanMediaFile(deviceId, onDevicePath).catch(() => {});
    } else if (i === 3) {
      await adb.fastShell(deviceId, 'content call --uri content://media --method scan_volume --arg external_primary', 30_000).catch(() => {});
    }
    await sleep(800);
  }

  // 3. Fallback: check newest video row in MediaStore, verify _data matches onDevicePath or fileName
  const latestOut = await adb.fastShell(deviceId, `content query --uri ${MEDIA_URI} --projection _id:_data --sort "date_added DESC" --limit 1`).catch(() => '');
  const mLatest = /_id=(\d+).*?_data=([^,\s\r\n]+)/.exec(latestOut);
  if (mLatest && mLatest[1] && mLatest[2]) {
    const rowPath = mLatest[2].trim();
    if (rowPath === onDevicePath || path.basename(rowPath) === fileName) {
      return mLatest[1];
    }
  }

  return null;
}

/** The app's own share-target activity (Instagram: the Reels one; TikTok: SystemShareActivity) — avoids the generic chooser. */
async function pickShareComponent(adb: AdbClient, deviceId: string, pkg: string, platform: FlowPlatform): Promise<string | null> {
  let out = await adb.fastShell(deviceId, 'cmd package query-activities --brief -a android.intent.action.SEND -t video/mp4').catch(() => '');
  if (!out || !out.includes(pkg)) {
    out += '\n' + await adb.fastShell(deviceId, 'pm query-activities -a android.intent.action.SEND -t video/mp4').catch(() => '');
  }
  const escaped = pkg.replace(/\./g, '\\.');
  const comps = [...out.matchAll(new RegExp(`(${escaped}/[\\w.$]+)`, 'g'))].map((m) => m[1]);
  const usable = comps.filter((c) => !/story|direct|thread|chat|im\b|friend|message/i.test(c.split('/')[1]));

  if (platform === 'instagram') return usable.find((c) => /reel|clips/i.test(c)) ?? usable[0] ?? null;

  if (platform === 'tiktok') {
    const preferred = usable.find((c) => /systemshare|shareentry|shareactivity|upload|compose|record/i.test(c));
    if (preferred) return preferred;
    if (usable.length > 0) return usable[0];
    // Known default for TikTok / Musical.ly / TikTok Lite
    return `${pkg}/com.ss.android.ugc.aweme.share.SystemShareActivity`;
  }

  return usable[0] ?? null;
}

/** The caption field now shows (the start of) the caption. */
async function captionLanded(adb: AdbClient, deviceId: string, caption: string): Promise<boolean> {
  const screen = await dumpScreen(adb, deviceId, 2);
  if (!screen) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const head = norm(caption).slice(0, 10);
  if (!head) return true;
  const inEdit = editTexts(screen).some((e) => norm(e.text).includes(head) || norm(e.desc).includes(head));
  if (inEdit) return true;
  return screen.els.some((e) => norm(e.text).includes(head) || norm(e.desc).includes(head));
}

async function hideKeyboard(adb: AdbClient, deviceId: string): Promise<void> {
  const ime = await adb.fastShell(deviceId, 'dumpsys input_method | grep -E "mInputShown=|mIsInputViewShown="').catch(() => '');
  if (/=true/.test(ime)) {
    // 111 = KEYCODE_ESCAPE: dismisses IME window safely without triggering Activity.onBackPressed
    await adb.fastShell(deviceId, 'input keyevent 111').catch(() => {});
    await sleep(600);
  }
}

async function removeFromGallery(adb: AdbClient, deviceId: string, onDevicePath: string, mediaId: string | null): Promise<void> {
  if (mediaId) await adb.fastShell(deviceId, `content delete --uri ${MEDIA_URI}/${mediaId}`).catch(() => {});
  await adb.fastShell(deviceId, `rm -f "${onDevicePath}"`).catch(() => {});
}

/** Uploads left behind by interrupted runs (older than a day) — gallery + MediaStore. */
async function cleanupOldUploads(adb: AdbClient, deviceId: string): Promise<void> {
  const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
  await adb.fastShell(
    deviceId,
    `content delete --uri ${MEDIA_URI} --where "_display_name LIKE 'pub_%' AND date_added < ${dayAgo}"; ` +
      `find "${config.DOWNLOAD_DIR}" -maxdepth 1 -name 'pub_*.mp4' -mtime +1 -exec rm -f {} \\;`,
    60_000,
  ).catch(() => {});
}
