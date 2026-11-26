import type { AdbClient } from './adb-client';
import { readPublishProfile, snapshotProfile } from './profile-stats';
import { clickTarget, dumpScreen, editTexts, isVisible, sleep, tapEl, type UiScreen } from './ui-automation';

const MAX_RECENT_VIDEOS = 6;
const POST_CONTROLS = [
  /^(?:like|liked|unlike|нравится)(?:$|[,.:\s])/i,
  /^(?:comments?|комментари[ий])(?:$|[,.:\s])/i,
  /^(?:share|поделиться|more options)(?:$|[,.:\s])/i,
];
const EXPAND_CAPTION = /^(?:see more|read more|show more|more|ещ[её]|читать дальше|показать ещё)$/i;
const COLLAPSED_CAPTION = /(?:\.{3}|…)?\s*(?:see more|read more|show more|more|ещ[её]|читать дальше|показать ещё)$/i;
const POST_AGE = /^(\d{1,3})\s*(min(?:ute)?s?|m|h(?:ours?|rs?)?|d(?:ays?)?|мин(?:ут[аыу]?)?\.?|ч(?:ас(?:а|ов)?)?\.?|д(?:ень|ня|ней|н\.?)?)\s*(?:ago|назад)$/i;

function captionKey(value: string): string {
  return value.normalize('NFC').replace(/[\u200B\uFEFF\uFE0F]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function inspectPostCaption(screen: UiScreen, caption: string, pkg: string, onProfile: boolean, expandedFromPost = false) {
  if (screen.pkg !== pkg || onProfile || editTexts(screen).length) return {};
  const visible = screen.els.filter((el) => el.pkg === pkg && isVisible(el));
  const controls = POST_CONTROLS.filter((pattern) => visible.some((el) => [el.text, el.desc].some((text) => pattern.test(text.trim()))));
  if (!expandedFromPost && controls.length < 2) return {};
  const expected = captionKey(caption);
  if (expected.length < 20) return {};
  if (visible.some((el) => [el.text, el.desc].some((text) => captionKey(text) === expected))) return { matches: true };
  // Some versions provide the caption and its clickable hashtags as sibling nodes.
  const grouped = new Map<UiScreen['els'][number], string[]>();
  for (const el of visible) {
    const fragment = (el.text || el.desc).trim();
    if (!el.parent || !fragment) continue;
    const fragments = grouped.get(el.parent) ?? [];
    fragments.push(fragment);
    grouped.set(el.parent, fragments);
  }
  if ([...grouped.values()].some((fragments) => captionKey(fragments.join(' ')) === expected)) return { matches: true };
  if (expandedFromPost) return {};
  for (const el of visible) {
    for (const text of [el.text, el.desc]) {
      const actual = captionKey(text);
      const prefix = actual.replace(COLLAPSED_CAPTION, '').trim();
      const truncated = prefix !== actual || /(?:…|\.{3})$/.test(prefix);
      const cleanPrefix = prefix.replace(/(?:…|\.{3})$/, '').trim();
      if (!truncated || cleanPrefix.length < 20 || !expected.startsWith(cleanPrefix)) continue;
      const expand = visible.find((candidate) => candidate.enabled && clickTarget(candidate).clickable &&
        EXPAND_CAPTION.test((candidate.text || candidate.desc).trim()) &&
        candidate.bounds[1] >= el.bounds[1] && candidate.bounds[1] <= el.bounds[3] + 32);
      if (expand) return { expand };
      if (el.enabled && clickTarget(el).clickable && prefix !== actual) return { expand: el };
    }
  }
  return {};
}

function olderThanAttempt(screen: UiScreen, since: number): boolean {
  const ages = new Set<number>();
  for (const el of screen.els) {
    if (!isVisible(el)) continue;
    for (const label of [el.text, el.desc]) {
      const age = POST_AGE.exec(label.trim());
      if (!age) continue;
      const unit = age[2].toLowerCase()[0];
      const minutes = unit === 'd' || unit === 'д' ? 1440 : unit === 'h' || unit === 'ч' ? 60 : 1;
      ages.add(Number(age[1]) * minutes * 60_000);
    }
  }
  // Compare only an unambiguous visible timestamp, with room for platform rounding.
  return ages.size === 1 && Date.now() - [...ages][0] + 60_000 < since;
}

export async function verifyRecentPost(
  adb: AdbClient, deviceId: string, platform: 'instagram' | 'tiktok', username: string, pkg: string, caption: string, since: number,
): Promise<'confirmed' | 'not_found' | 'unavailable' | 'processing'> {
  const { width, height } = await adb.getScreenSize(deviceId);
  const baseline = await snapshotProfile(adb, deviceId, platform, username, pkg, true, false);
  if (!baseline.onProfile) return 'unavailable';
  if (baseline.uploading != null) return 'processing';
  if (baseline.empty) return 'not_found';

  const deadline = Date.now() + 85_000;
  let inspected = false;
  for (let index = 0; index < Math.min(baseline.tiles.length, MAX_RECENT_VIDEOS) && Date.now() < deadline; index++) {
    // Confirm the account and grid after returning from each post, before using tile coordinates.
    const grid = await dumpScreen(adb, deviceId, 1);
    if (grid?.pkg !== pkg) return 'unavailable';
    const snapshot = readPublishProfile(grid.xml, width, height, platform, username);
    if (!snapshot.onProfile) return 'unavailable';
    if (snapshot.uploading != null) return 'processing';
    const box = snapshot.tiles[index]?.bounds;
    if (!box) continue;

    await adb.tap(deviceId, Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2));
    await sleep(800);
    const detail = await dumpScreen(adb, deviceId, 1);
    if (detail?.pkg !== pkg) return 'unavailable';
    if (readPublishProfile(detail.xml, width, height, platform, username).onProfile) continue;
    inspected = true;
    const evidence = inspectPostCaption(detail, caption, pkg, false);
    const isOlder = olderThanAttempt(detail, since);
    if (evidence.matches && !isOlder) return 'confirmed';
    const expand = !isOlder && Date.now() < deadline ? evidence.expand : undefined;
    if (expand) {
      await tapEl(adb, deviceId, expand);
      await sleep(450);
      const expanded = await dumpScreen(adb, deviceId, 1);
      if (expanded && inspectPostCaption(expanded, caption, pkg,
        readPublishProfile(expanded.xml, width, height, platform, username).onProfile, true).matches) return 'confirmed';
    }
    await adb.keyevent(deviceId, 4);
    await sleep(550);
    if (expand) {
      const returned = await dumpScreen(adb, deviceId, 1);
      if (returned?.pkg === pkg && !readPublishProfile(returned.xml, width, height, platform, username).onProfile) {
        await adb.keyevent(deviceId, 4);
        await sleep(550);
      }
    }
  }
  return inspected ? 'not_found' : 'unavailable';
}
