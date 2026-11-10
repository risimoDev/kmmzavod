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
import { decide, initialFlowState, isAppOffline, isComposeScreen, isNewPostOnProfile, uploadPercent, type FlowPlatform } from './publish-flow';
import { snapshotProfile, type ProfileSnapshot } from './profile-stats';
import { dumpScreen, editTexts, saveDebugSnapshot, sleep, tapEl, typeText, type UiEl } from './ui-automation';
import { consultAiAutopilot } from './ai-autopilot';

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
  verified?: { app: boolean; profile: boolean | null };
  captionTyped?: boolean;
  onDevicePath?: string;
  detail?: string;
  /** Where the screen + UI dump of a failure were saved on the phone (/sdcard/kmm-debug). */
  debugSnapshot?: string;
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
const SHARE_TAP_ATTEMPTS = 3;
const PROFILE_CHECK_GAP_MS = 20_000;
const MEDIA_URI = 'content://media/external/video/media';

export async function publishToDevice(req: PublishRequest, adb: AdbClient, logger: Logger): Promise<PublishResult> {
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

  const result = (r: Omit<PublishResult, 'stage' | 'posted' | 'onDevicePath'> & Partial<PublishResult>): PublishResult =>
    ({ stage, posted, onDevicePath, ...r });

  try {
    await cleanupOldUploads(adb, deviceId);

    // 1. Download on the host PC (wired link, no mobile-proxy traffic)
    logger.info({ deviceId, platform }, 'publish: downloading video on host PC');
    await downloadWithRetry(videoUrl, localFilePath, logger);

    // 2. Push into the gallery and index it
    stage = 'push';
    await adb.shell(deviceId, `mkdir -p "${config.DOWNLOAD_DIR}"`).catch(() => {});
    await adb.pushFile(deviceId, localFilePath, onDevicePath);
    await adb.fastShell(deviceId, `chmod 666 "${onDevicePath}"`).catch(() => {});
    await adb.scanMediaFile(deviceId, onDevicePath).catch(() => {});
    mediaId = await resolveMediaId(adb, deviceId, onDevicePath, fileName);
    const streamUri = mediaId ? `${MEDIA_URI}/${mediaId}` : `file://${onDevicePath}`;

    // 3. App + baseline
    stage = 'prepare';
    await adb.fastShell(deviceId, 'am force-stop com.samsung.android.app.galaxyfinder').catch(() => {});
    await adb.wakeUp(deviceId);
    await adb.fastShell(deviceId, 'svc power stayon true').catch(() => {});
    await adb.fastShell(deviceId, 'wm dismiss-keyguard; input keyevent 82').catch(() => {});

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
      if (!baseline?.onProfile) {
        logger.warn({ deviceId, username }, 'publish: own profile not readable before posting — verification falls back to the app');
        baseline = null;
      }
    }

    // 3b. The app must have network: with "Network error" the upload would hang mid-way
    // (seen on the farm: TikTok stuck at 58%). Nothing is posted yet → safe to retry later.
    let before = await dumpScreen(adb, deviceId, 1);
    if (before && before.pkg === pkg && isAppOffline(before)) {
      logger.warn({ deviceId, platform }, 'publish: обнаружена «Network error» до публикации — попытка авто-восстановления сети');
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
    let amCmd = `am start -a android.intent.action.SEND -t video/mp4 -f 0x10000000 --eu android.intent.extra.STREAM "${streamUri}" --grant-read-uri-permission ${component ? `-n ${component}` : `-p ${pkg}`}`;
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
    const st = initialFlowState();
    let captionTyped = !caption;
    let unknown = 0;
    let aiAdviceAttempts = 0;
    const MAX_AI_ADVICE = 4;
    const composeDeadline = Date.now() + COMPOSE_TIMEOUT_MS;
    let lastScreen: any = null;
    const isLauncherOrSys = (p?: string) =>
      !p || /launcher|galaxyfinder|finder|nexuslauncher|trebuchet|miui\.home|touchwiz|systemui/i.test(p);

    while (!st.shareTapped) {
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
        if (unknown >= 2 && aiAdviceAttempts < MAX_AI_ADVICE && screen) {
          aiAdviceAttempts++;
          logger.info({ deviceId, platform, unknown, aiAdviceAttempts }, 'publish: ИИ-автопилот анализирует экран рабочего стола/системы');
          const base64Screenshot = await adb.takeScreenshot(deviceId).catch(() => undefined);
          const aiDecision = await consultAiAutopilot({
            platform: flowPlatform,
            deviceId,
            stage,
            st,
            hasCaption: !!caption,
            captionText: caption,
            screen,
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
            if (aiDecision.action === 'tap_coord' && aiDecision.x && aiDecision.y) {
              logger.info({ deviceId, x: aiDecision.x, y: aiDecision.y, reason: aiDecision.reason }, 'publish: ИИ нажал по координатам на экране');
              await adb.tap(deviceId, aiDecision.x, aiDecision.y);
              await sleep(2000);
              continue;
            }
            if (aiDecision.action === 'tap' && aiDecision.targetText) {
              const target = aiDecision.targetText;
              const el = screen.els.find((e) => new RegExp(target, 'i').test(`${e.text} ${e.desc}`));
              if (el) {
                logger.info({ deviceId, targetText: target, reason: aiDecision.reason }, 'publish: ИИ нажал элемент на рабочем столе');
                await tapEl(adb, deviceId, el);
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
        const action = decide(flowPlatform, screen, st, !!caption);
        if (action.kind === 'error') {
          const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_error`, screen.xml).catch(() => undefined);
          return result({ ok: false, retryable: action.retryable, debugSnapshot: snap, detail: action.why });
        }
        if (action.kind === 'caption') {
          await tapEl(adb, deviceId, action.el);
          await sleep(700);
          try {
            await typeText(adb, deviceId, caption);
          } catch (err) {
            return result({ ok: false, retryable: false, detail: (err as Error).message });
          }
          st.captionDone = true;
          captionTyped = await captionLanded(adb, deviceId, caption);
          await hideKeyboard(adb, deviceId);
          unknown = 0;
          continue;
        }
        if (action.kind === 'tap') {
          logger.info({ deviceId, platform, step: action.why }, 'publish: tap');
          await tapEl(adb, deviceId, action.el);
          if (action.marks === 'target') st.targetChosen = true;
          if (action.marks === 'next') st.nextTaps++;
          if (action.marks === 'share') { st.shareTapped = true; posted = 'unknown'; }
          unknown = 0;
          await sleep(2500);
          continue;
        }
        unknown++;
        if (st.captionDone && !st.shareTapped && unknown >= 1) {
          const { width, height } = await adb.getScreenSize(deviceId).catch(() => ({ width: 1080, height: 2400 }));
          await adb.swipe(deviceId, Math.round(width / 2), Math.round(height * 0.75), Math.round(width / 2), Math.round(height * 0.35), 300).catch(() => {});
          await sleep(1000);
        }

        // ── AI Autopilot Advisor Fallback (ClaudeHub Vision) ─────────────────
        if (unknown >= 2 && aiAdviceAttempts < MAX_AI_ADVICE && screen) {
          aiAdviceAttempts++;
          logger.info({ deviceId, platform, unknown, aiAdviceAttempts }, 'publish: asking AI Autopilot advisor to analyze stuck screen');
          const screenSize = await adb.getScreenSize(deviceId).catch(() => ({ width: 1080, height: 2400 }));
          const base64Screenshot = await adb.takeScreenshot(deviceId).catch(() => undefined);

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
            if (aiDecision.action === 'abort') {
              const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_ai_abort`, screen?.xml).catch(() => undefined);
              return result({
                ok: false,
                retryable: false,
                debugSnapshot: snap,
                detail: `ИИ автопилот: ${aiDecision.reason}`,
              });
            }

            if (aiDecision.action === 'key_back') {
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

            if (aiDecision.action === 'type_caption' && caption) {
              const editField = screen.els.find((e) => /EditText|AutoCompleteTextView/i.test(e.cls));
              if (editField) {
                logger.info({ deviceId, platform, reason: aiDecision.reason }, 'publish: AI Autopilot typing caption');
                await tapEl(adb, deviceId, editField);
                await sleep(700);
                await typeText(adb, deviceId, caption);
                st.captionDone = true;
                captionTyped = await captionLanded(adb, deviceId, caption);
                await hideKeyboard(adb, deviceId);
                unknown = 0;
                await sleep(1500);
                continue;
              }
            }

            if (aiDecision.action === 'tap' || aiDecision.action === 'tap_coord') {
              let targetEl: UiEl | undefined;
              if (aiDecision.targetText) {
                const escaped = aiDecision.targetText.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                targetEl = screen.els.find((e) =>
                  (e.clickable || /Button|TextView|ImageView|View/i.test(e.cls)) &&
                  (new RegExp(`^${escaped}$`, 'i').test(e.text.trim()) || new RegExp(`^${escaped}$`, 'i').test(e.desc.trim()))
                );
                if (!targetEl) {
                  targetEl = screen.els.find((e) =>
                    new RegExp(escaped, 'i').test(e.text) || new RegExp(escaped, 'i').test(e.desc)
                  );
                }
              }

              if (targetEl) {
                logger.info({ deviceId, platform, target: targetEl.text || targetEl.desc, reason: aiDecision.reason }, 'publish: AI Autopilot tapped element');
                await tapEl(adb, deviceId, targetEl);
              } else if (aiDecision.x && aiDecision.y && aiDecision.x > 0 && aiDecision.y > 0) {
                logger.info({ deviceId, platform, x: aiDecision.x, y: aiDecision.y, reason: aiDecision.reason }, 'publish: AI Autopilot tapped coordinates');
                await adb.tap(deviceId, aiDecision.x, aiDecision.y);
              }

              if (targetEl || (aiDecision.x && aiDecision.y)) {
                if (aiDecision.marks === 'target') st.targetChosen = true;
                if (aiDecision.marks === 'next') st.nextTaps++;
                if (aiDecision.marks === 'share') { st.shareTapped = true; posted = 'unknown'; }
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

    // 5b. The tap must have left the compose screen. A tap that landed on a label, or was
    // swallowed by an animation, leaves the video unposted with the button still there.
    for (let attempt = 1; ; attempt++) {
      await sleep(5000);
      let screen = await dumpScreen(adb, deviceId, 2);
      if (!screen || !isComposeScreen(flowPlatform, screen)) break;
      // Slow phones can need a few more seconds to react to the first tap — look again
      // before tapping a second time, so a slow transition never turns into a double post.
      await sleep(3000);
      screen = await dumpScreen(adb, deviceId, 2);
      if (!screen || !isComposeScreen(flowPlatform, screen)) break;
      if (attempt >= SHARE_TAP_ATTEMPTS) {
        const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_post_button`, screen.xml).catch(() => undefined);
        return result({
          ok: false, retryable: false, debugSnapshot: snap, captionTyped,
          detail: `Кнопка публикации нажата ${attempt} раза, но экран публикации не закрылся — проверьте телефон`,
        });
      }
      const action = decide(flowPlatform, screen, { ...st, shareTapped: false }, false);
      if (action.kind !== 'tap' || action.marks !== 'share') break;
      logger.warn({ deviceId, platform, attempt }, 'publish: still on the compose screen after Share/Post — tapping again');
      await tapEl(adb, deviceId, action.el);
    }

    // 6. Upload: wait for the app's confirmation / the progress to finish
    stage = 'upload';
    let appConfirmed = false;
    let offline = false;
    let lastPct: number | null = null;
    let lastPctChange = Date.now();
    let lastActivity = Date.now();
    const uploadDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
    while (Date.now() < uploadDeadline && Date.now() - lastActivity < UPLOAD_QUIET_MS) {
      await sleep(3000);
      const screen = await dumpScreen(adb, deviceId, 1);
      const pct = screen ? uploadPercent(screen) : null;
      if (screen && isAppOffline(screen)) offline = true;
      if (pct != null && pct !== lastPct) {
        lastPct = pct;
        lastPctChange = Date.now();
        lastActivity = Date.now();
      }
      // "Network error" and a frozen percentage: the upload is not moving — stop waiting.
      if (offline && Date.now() - lastPctChange > UPLOAD_STALL_MS) {
        logger.warn({ deviceId, platform, lastPct }, 'publish: app offline, upload stalled');
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
    let profileVerified: boolean | null = null;
    let stuckAt: number | null = null;
    if (baseline) {
      for (let i = 0; i < PROFILE_CHECKS; i++) {
        let after = await snapshotProfile(adb, deviceId, flowPlatform, username ?? '', pkg).catch(() => null);
        // TikTok shows the new post in the grid with a "96%" badge while it still uploads.
        // Confirm only once the upload has finished — a post stuck at 96% is not published.
        const uploadWaitUntil = Date.now() + UPLOAD_TIMEOUT_MS;
        let lastUploadPct: number | null = null;
        let lastUploadChange = Date.now();
        while (after?.uploading != null && Date.now() < uploadWaitUntil) {
          if (after.uploading !== lastUploadPct) { lastUploadPct = after.uploading; lastUploadChange = Date.now(); }
          if (Date.now() - lastUploadChange > UPLOAD_STALL_MS) break;
          logger.info({ deviceId, platform, uploading: after.uploading }, 'publish: post still uploading in the profile grid');
          await sleep(15_000);
          after = await snapshotProfile(adb, deviceId, flowPlatform, username ?? '', pkg).catch(() => null);
        }
        if (after?.uploading != null) { stuckAt = after.uploading; profileVerified = false; break; }
        if (after?.onProfile && isNewPostOnProfile(baseline, after)) { profileVerified = true; break; }
        profileVerified = false;
        if (i < PROFILE_CHECKS - 1) await sleep(PROFILE_CHECK_GAP_MS);
      }
    }
    const verified = { app: appConfirmed, profile: profileVerified };
    // The app's own signal is enough only when the profile could not tell us otherwise:
    // an upload stuck in the grid or a lost network means the post is NOT out.
    const confirmed = profileVerified === true || (appConfirmed && stuckAt == null && !offline);
    if (!confirmed) {
      // Capture the screen the app is on now — before leaving it.
      const unconfirmedScreen = await dumpScreen(adb, deviceId, 1);
      const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_unconfirmed`, unconfirmedScreen?.xml).catch(() => undefined);
      await adb.home(deviceId).catch(() => {});
      return result({
        ok: false, retryable: false, verified, captionTyped, debugSnapshot: snap,
        detail: stuckAt != null
          ? `Загрузка ролика остановилась на ${stuckAt}% (видно в профиле) — проверьте сеть/прокси платы. ` +
            'Пост не выложен до конца; повтор отключён, чтобы не опубликовать дважды'
          : offline
          ? `Приложение на телефоне потеряло сеть («Network error»)${lastPct != null ? `, загрузка остановилась на ${lastPct}%` : ''} — ` +
            'проверьте прокси/интернет платы. Пост мог не выйти; повтор отключён, чтобы не опубликовать дважды'
          : profileVerified === false
          ? 'Пост не появился на профиле после публикации — проверьте вручную (повтор отключён, чтобы не опубликовать дважды)'
          : canReadProfile
            ? 'Приложение не подтвердило публикацию, а профиль не удалось прочитать до публикации — проверьте вручную'
            : 'Приложение не подтвердило публикацию, а профиль Instagram проверить нельзя (у аккаунта не указан username) — проверьте вручную',
      });
    }

    await adb.home(deviceId).catch(() => {});
    stage = 'done';
    posted = 'yes';
    logger.info({ deviceId, platform, verified, captionTyped }, 'publish: post confirmed');
    return result({
      ok: true, retryable: false, verified, captionTyped,
      ...(profileVerified === false && appConfirmed
        ? { detail: 'Пост опубликован (выгрузка подтверждена приложением, появление в профиле ожидается)' }
        : (!captionTyped ? { detail: 'Пост опубликован, но подпись не удалось проверить в поле ввода' } : {})),
    });
  } catch (err) {
    logger.error({ deviceId, platform, stage, err: (err as Error).message }, 'publish: failed');
    const errScreen = await dumpScreen(adb, deviceId, 1).catch(() => null);
    const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_exception`, errScreen?.xml).catch(() => undefined);
    return result({ ok: false, retryable: posted === 'no', debugSnapshot: snap, detail: `Ошибка публикации через ADB (${stage}): ${(err as Error).message}` });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Keep the gallery file while the outcome is unknown (the app may still be reading it).
    if (posted !== 'unknown') await removeFromGallery(adb, deviceId, onDevicePath, mediaId);
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

  // 3. Fallback: newest video row in MediaStore
  const latestOut = await adb.fastShell(deviceId, `content query --uri ${MEDIA_URI} --projection _id:_data --sort "date_added DESC" --limit 1`).catch(() => '');
  const mLatest = /_id=(\d+)/.exec(latestOut);
  if (mLatest) return mLatest[1];

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
  const head = norm(caption).slice(0, 12);
  return editTexts(screen).some((e) => norm(e.text).includes(head));
}

async function hideKeyboard(adb: AdbClient, deviceId: string): Promise<void> {
  const ime = await adb.fastShell(deviceId, 'dumpsys input_method | grep -E "mInputShown=|mIsInputViewShown="').catch(() => '');
  if (/=true/.test(ime)) {
    // 111 = KEYCODE_ESCAPE: dismisses IME window safely without triggering Activity.onBackPressed
    await adb.fastShell(deviceId, 'input keyevent 4').catch(() => {});
    await sleep(500);
    const still = await adb.fastShell(deviceId, 'dumpsys input_method | grep -E "mInputShown=|mIsInputViewShown="').catch(() => '');
    if (/=true/.test(still)) {
      await adb.back(deviceId).catch(() => {});
    }
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
