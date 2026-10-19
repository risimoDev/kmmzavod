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
import { decide, initialFlowState, isNewPostOnProfile, type FlowPlatform } from './publish-flow';
import { snapshotProfile, type ProfileSnapshot } from './profile-stats';
import { dumpScreen, editTexts, saveDebugSnapshot, sleep, tapEl, typeText } from './ui-automation';

export interface PublishRequest {
  deviceId: string;
  platform: 'instagram' | 'tiktok' | 'youtube_shorts';
  videoUrl: string;
  caption: string;
  /** The account's own username — needed to verify the post on its profile. */
  username?: string;
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
/** Consecutive unrecognised screens before giving up (≈ 2 s apart). */
const UNKNOWN_SCREEN_LIMIT = 8;
const PROFILE_CHECKS = 3;
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
    const response = await axios({ method: 'GET', url: videoUrl, responseType: 'stream', timeout: 120_000 });
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(localFilePath);
      response.data.on('error', reject);
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.pipe(writer);
    });

    // 2. Push into the gallery and index it
    stage = 'push';
    await adb.shell(deviceId, `mkdir -p "${config.DOWNLOAD_DIR}"`).catch(() => {});
    await adb.pushFile(deviceId, localFilePath, onDevicePath);
    await adb.scanMediaFile(deviceId, onDevicePath).catch(() => {});
    mediaId = await resolveMediaId(adb, deviceId, fileName);
    const streamUri = mediaId ? `${MEDIA_URI}/${mediaId}` : `file://${onDevicePath}`;

    // 3. App + baseline
    stage = 'prepare';
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard').catch(() => {});
    const resolved = await new PackageResolver(adb, logger).resolve(deviceId, platform);
    if (!resolved.installed || !resolved.packageName) {
      return result({ ok: false, retryable: false, detail: resolved.error || `Приложение ${platform} не установлено на телефоне ${deviceId}` });
    }
    const pkg = resolved.packageName;

    let baseline: ProfileSnapshot | null = null;
    if (username) {
      baseline = await snapshotProfile(adb, deviceId, flowPlatform, username, pkg).catch(() => null);
      if (!baseline?.onProfile) {
        logger.warn({ deviceId, username }, 'publish: own profile not readable before posting — verification falls back to the app');
        baseline = null;
      }
    }

    // 4. Share the video into the app
    const component = await pickShareComponent(adb, deviceId, pkg, flowPlatform);
    await adb.fastShell(
      deviceId,
      `am start -a android.intent.action.SEND -t video/mp4 --eu android.intent.extra.STREAM ${streamUri} --grant-read-uri-permission ${component ? `-n ${component}` : pkg}`,
    );
    await sleep(3500);

    // 5. Walk the screens up to Share/Post
    stage = 'compose';
    const st = initialFlowState();
    let captionTyped = !caption;
    let unknown = 0;
    const composeDeadline = Date.now() + COMPOSE_TIMEOUT_MS;
    while (!st.shareTapped) {
      if (Date.now() > composeDeadline) {
        const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_timeout`).catch(() => undefined);
        return result({ ok: false, retryable: true, debugSnapshot: snap, detail: 'Не удалось дойти до кнопки публикации за 3 мин' });
      }
      const screen = await dumpScreen(adb, deviceId);
      if (!screen) { unknown++; } else {
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
    let appConfirmed = false;
    let lastActivity = Date.now();
    const uploadDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
    while (Date.now() < uploadDeadline && Date.now() - lastActivity < UPLOAD_QUIET_MS) {
      await sleep(4000);
      const screen = await dumpScreen(adb, deviceId, 1);
      if (!screen) continue;
      const action = decide(flowPlatform, screen, st, !!caption);
      if (action.kind === 'success') { appConfirmed = true; break; }
      if (action.kind === 'error') {
        const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_upload`, screen.xml).catch(() => undefined);
        return result({ ok: false, retryable: false, debugSnapshot: snap, captionTyped, detail: `${action.why} — проверьте профиль вручную` });
      }
      if (action.kind === 'tap') { await tapEl(adb, deviceId, action.el); lastActivity = Date.now(); }
      if (action.kind === 'progress') lastActivity = Date.now();
    }

    // 7. Verify on the profile
    stage = 'verify';
    let profileVerified: boolean | null = null;
    if (username && baseline) {
      for (let i = 0; i < PROFILE_CHECKS; i++) {
        const after = await snapshotProfile(adb, deviceId, flowPlatform, username, pkg).catch(() => null);
        if (after?.onProfile && isNewPostOnProfile(baseline, after)) { profileVerified = true; break; }
        profileVerified = false;
        if (i < PROFILE_CHECKS - 1) await sleep(PROFILE_CHECK_GAP_MS);
      }
    }
    await adb.home(deviceId).catch(() => {});

    const verified = { app: appConfirmed, profile: profileVerified };
    const confirmed = profileVerified === true || (profileVerified === null && appConfirmed);
    if (!confirmed) {
      return result({
        ok: false, retryable: false, verified, captionTyped,
        detail: profileVerified === false
          ? 'Пост не появился на профиле после публикации — проверьте вручную (повтор отключён, чтобы не опубликовать дважды)'
          : 'Приложение не подтвердило публикацию, а профиль проверить нельзя (нет username) — проверьте вручную',
      });
    }

    stage = 'done';
    posted = 'yes';
    logger.info({ deviceId, platform, verified, captionTyped }, 'publish: post confirmed');
    return result({
      ok: true, retryable: false, verified, captionTyped,
      ...(captionTyped ? {} : { detail: 'Пост опубликован, но подпись не удалось проверить в поле ввода' }),
    });
  } catch (err) {
    logger.error({ deviceId, platform, stage, err: (err as Error).message }, 'publish: failed');
    const snap = await saveDebugSnapshot(adb, deviceId, `pub_${platform}_exception`).catch(() => undefined);
    return result({ ok: false, retryable: posted === 'no', debugSnapshot: snap, detail: `Ошибка публикации через ADB (${stage}): ${(err as Error).message}` });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Keep the gallery file while the outcome is unknown (the app may still be reading it).
    if (posted !== 'unknown') await removeFromGallery(adb, deviceId, onDevicePath, mediaId);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** MediaStore _id of the pushed file (needed for a content:// URI). */
async function resolveMediaId(adb: AdbClient, deviceId: string, fileName: string): Promise<string | null> {
  const query = `content query --uri ${MEDIA_URI} --projection _id --where "_display_name='${fileName}'"`;
  for (let i = 0; i < 6; i++) {
    const out = await adb.fastShell(deviceId, query).catch(() => '');
    const m = /_id=(\d+)/.exec(out);
    if (m) return m[1];
    // Android 11+ may ignore the legacy scan broadcast — ask MediaProvider to scan once.
    if (i === 2) await adb.fastShell(deviceId, 'content call --uri content://media --method scan_volume --arg external_primary', 60_000).catch(() => {});
    await sleep(1000);
  }
  return null;
}

/** The app's own share-target activity (Instagram: the Reels one) — avoids the generic chooser. */
async function pickShareComponent(adb: AdbClient, deviceId: string, pkg: string, platform: FlowPlatform): Promise<string | null> {
  const out = await adb.fastShell(deviceId, 'cmd package query-activities --brief -a android.intent.action.SEND -t video/mp4').catch(() => '');
  const escaped = pkg.replace(/\./g, '\\.');
  const comps = [...out.matchAll(new RegExp(`(${escaped}/[\\w.$]+)`, 'g'))].map((m) => m[1]);
  const usable = comps.filter((c) => !/story|direct|thread|chat|im\b|friend|message/i.test(c.split('/')[1]));
  if (platform === 'instagram') return usable.find((c) => /reel|clips/i.test(c)) ?? null;
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
    await adb.back(deviceId).catch(() => {});
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
