/**
 * Profile stats snapshot (Instagram Reels / TikTok) via the Android UI hierarchy.
 *
 * Opens the account's own profile on the phone, dumps the screen with
 * `uiautomator dump`, and reads:
 *   • followers (header),
 *   • the post grid: view count on each tile (newest first), pinned tiles.
 *
 * A tile has no stable post ID. The analytics page shows these counts as a
 * profile snapshot, without attributing them to individual publish jobs.
 * Parsing is a pure function (`parseProfileDump`) so it is unit-testable on
 * XML fixtures without a phone.
 */
import type { Logger } from 'pino';
import type { AdbClient } from './adb-client';
import { PackageResolver } from './package-resolver';
import { dumpScreen, sleep } from './ui-automation';

type Bounds = [number, number, number, number];

export interface ProfileTile {
  index: number;          // 0 = top-left (newest unless pinned)
  views: number | null;
  pinned: boolean;
  bounds?: Bounds;
  cover?: number[];
}

export interface ProfileStats {
  ok: boolean;
  platform: 'instagram' | 'tiktok';
  username?: string;
  followers: number | null;
  posts?: number | null;
  tiles: ProfileTile[];
  detail?: string;
}

// ── Count parsing ("1,234", "1 234", "12.3K", "12,3 тыс.", "1,2 млн") ────────

export function parseCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw
    .replace(/[  \s]+/g, ' ')
    .replace(/^[▶►▷▲👁\s\u25B6\u25B7\u25B8\u25B9\u25BA\u25BB]+/u, '')
    .replace(/\s*(views?|просмотр(ов|а)?)\s*$/i, '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (/^(now|только что|just now)$/i.test(s)) return 0;
  // Plain grouped thousands: 1,234 / 1 234 / 1.234.567
  if (/^\d{1,3}([ ,.]\d{3})+$/.test(s)) return Number(s.replace(/[ ,.]/g, ''));
  const m = /^(\d+(?:[.,]\d+)?)\s*(k|к|тыс\.?|m|м|млн\.?|b|млрд\.?)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? '';
  const mult = /^(k|к|тыс)/.test(unit) ? 1e3 : /^(m|м|млн)/.test(unit) ? 1e6 : /^(b|млрд)/.test(unit) ? 1e9 : 1;
  return Math.round(n * mult);
}

// ── Minimal uiautomator XML tree ──────────────────────────────────────────────

interface UiNode {
  text: string;
  desc: string;
  resId: string;
  cls: string;
  clickable: boolean;
  selected: boolean;
  bounds: Bounds;
  parent: UiNode | null;
  children: UiNode[];
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#10;/g, '\n') : '';
}

export function parseUiTree(xml: string): UiNode[] {
  const all: UiNode[] = [];
  const stack: UiNode[] = [];
  const re = /<node\b[^>]*?(\/?)>|<\/node>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0] === '</node>') { stack.pop(); continue; }
    const tag = m[0];
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    const node: UiNode = {
      text: attr(tag, 'text'),
      desc: attr(tag, 'content-desc'),
      resId: attr(tag, 'resource-id'),
      cls: attr(tag, 'class'),
      clickable: attr(tag, 'clickable') === 'true',
      selected: attr(tag, 'selected') === 'true',
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
      parent: stack[stack.length - 1] ?? null,
      children: [],
    };
    node.parent?.children.push(node);
    all.push(node);
    if (m[1] !== '/') stack.push(node);
  }
  return all;
}

const FOLLOWERS_RE = /(подписчик|followers?\b)/i;
const POSTS_RE = /(публикаци|posts?\b)/i;

/**
 * Number in a profile header next to `labelRe` ("123 posts", "1,2 тыс.\nподписчиков"):
 * inline in the label node, or a number node right above it in the same column.
 */
function headerCount(nodes: UiNode[], labelRe: RegExp, inlineRe: RegExp, screenW: number): { value: number | null; bottom: number } {
  let value: number | null = null;
  let bottom = 0;
  for (const n of nodes) {
    const label = `${n.text} ${n.desc}`;
    if (!labelRe.test(label)) continue;
    bottom = Math.max(bottom, n.bounds[3]);
    const inline = inlineRe.exec(label);
    if (inline && parseCount(inline[1]) != null) { value = parseCount(inline[1]); continue; }
    const cx = (n.bounds[0] + n.bounds[2]) / 2;
    const above = nodes
      .filter((x) => parseCount(x.text) != null && x.bounds[3] <= n.bounds[1] + 10 && n.bounds[1] - x.bounds[3] < 160
        && Math.abs((x.bounds[0] + x.bounds[2]) / 2 - cx) < screenW * 0.12)
      .sort((a, b) => b.bounds[3] - a.bounds[3]);
    if (above[0]) value = parseCount(above[0].text);
  }
  return { value, bottom };
}

/** Instagram profile header "N posts / N публикаций" (TikTok shows no post count → null). */
export function parsePostsCount(xml: string, screenW: number): number | null {
  return headerCount(parseUiTree(xml), POSTS_RE, /([\d\s.,]+(?:k|к|тыс\.?|m|м|млн\.?)?)\s*(публикаци|posts?\b)/i, screenW).value;
}

function matchesUsername(nodes: UiNode[], screenH: number, username: string, platform: ProfileStats['platform']): boolean {
  const normalize = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const expected = normalize(username);
  if (!/^[a-z\d._]{1,100}$/.test(expected)) return false;
  return nodes.some((node) => {
    const [, top, , bottom] = node.bounds;
    if (bottom <= top || top >= screenH * (platform === 'instagram' ? 0.18 : 0.32)) return false;
    return [node.text, node.desc].some((value) => normalize(value) === expected &&
      (platform === 'instagram' || value.trim().startsWith('@') || /user_?name/i.test(node.resId)));
  });
}

export function profileMatchesUsername(xml: string, screenH: number, username: string, platform: ProfileStats['platform']): boolean {
  return matchesUsername(parseUiTree(xml), screenH, username, platform);
}

const PINNED_RE = /закрепл[её]н|pinned|^(?:pin|top)_?(?:icon|label|tag)$/i;
const DRAFT_TILE = /^(?:drafts?|черновики?)(?:\s*[:·]?\s*\d+)?$/i;
const PROFILE_TAB = /^(?:profile|профиль|я|me)(?:\s*,\s*(?:tab|вкладка)\b.*)?$/i;
const VIDEOS_TAB = /^(?:videos|posts|видео|публикации)$/i;
const OTHER_PROFILE_TABS = /^(?:private (?:videos|posts)|liked videos|favorites|reposts|закрытые видео|приватные видео|понравившиеся|избранное|репосты)$/i;
const EMPTY_GRID = /^(?:no (?:videos|posts)(?: yet)?|no content|(?:create|share) your first (?:video|post)|(?:пока )?нет (?:видео|публикаций)|создайте первое видео)\.?$/i;

function hasLabel(node: UiNode, label: RegExp): boolean {
  return label.test(node.text.trim()) || label.test(node.desc.trim());
}

function tiktokProfileTab(nodes: UiNode[], width: number, height: number): UiNode | undefined {
  return nodes.find((n) => n.clickable && n.bounds[0] >= width * 0.7 && n.bounds[1] >= height * 0.8 &&
    n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1] &&
    (hasLabel(n, PROFILE_TAB) || /profile_tab|navigation_profile|tab_me|me_tab/i.test(n.resId)));
}

function descendants(n: UiNode): UiNode[] {
  const out: UiNode[] = [];
  const walk = (x: UiNode) => { for (const c of x.children) { out.push(c); walk(c); } };
  walk(n);
  return out;
}

/** Pure parser: followers + grid tiles (with views) from a profile screen dump. */
export function parseProfileDump(xml: string, screenW: number, screenH: number) {
  const nodes = parseUiTree(xml);
  const root = nodes[0]?.bounds;
  const width = root && root[2] - root[0] >= screenW * 0.8 ? root[2] : screenW;
  const height = root && root[3] - root[1] >= screenH * 0.7 ? root[3] : screenH;
  const profileTab = tiktokProfileTab(nodes, width, height);
  const gridTab = nodes.find((n) => n.selected && hasLabel(n, VIDEOS_TAB));
  const otherGridTabSelected = nodes.some((n) => n.selected && hasLabel(n, OTHER_PROFILE_TABS));

  // Followers: "1,2 тыс.\nподписчиков" in one node, or a number node right above
  // (same column) a "Подписчики/Followers" label.
  const header = headerCount(nodes.filter((n) => n.bounds[3] <= height * 0.62), FOLLOWERS_RE,
    /([\d\s.,]+(?:k|к|тыс\.?|m|м|млн\.?)?)\s*(подписчик|followers?\b)/i, width);
  const followers = header.value;
  const headerBottom = Math.max(header.bottom, gridTab?.bounds[3] ?? 0);
  const onProfile = header.bottom > 0 || Boolean(profileTab?.selected && gridTab);

  // Grid tiles: count nodes below the header and above the bottom navigation,
  // grouped by their tile container (≈ 1/3 of the screen wide).
  const tileW = width / 3;
  const gridBottom = profileTab?.bounds[1] ?? height * 0.96;
  const isTile = (n: UiNode) => Math.abs((n.bounds[2] - n.bounds[0]) - tileW) < tileW * 0.3 &&
    n.bounds[3] - n.bounds[1] > tileW * 0.6 && n.bounds[1] >= headerBottom && n.bounds[1] < gridBottom;
  // A tile still uploading shows a percentage ("96%") instead of a view count — it is a
  // post all the same (the newest one), so it must be counted as a tile.
  const pctOf = (n: UiNode): number | null => {
    const m = /^(\d{1,3})\s?%$/.exec(n.text.trim()) ?? /^(\d{1,3})\s?%$/.exec(n.desc.trim());
    return m && Number(m[1]) <= 100 ? Number(m[1]) : null;
  };
  let uploading: number | null = null;
  const counts = nodes.filter((n) => {
    const v = parseCount(n.text) ?? parseCount(n.desc) ?? pctOf(n);
    return v != null && n.bounds[1] > headerBottom + 12 && n.bounds[3] <= gridBottom;
  });
  const tiles = new Map<string, { node: UiNode; views: number | null }>();
  for (const node of nodes) {
    if (!isTile(node) || !(/(?:^|[:/])(?:cover|(?:video|aweme|post|item)_cover|cover_image)$/i.test(node.resId) ||
      /\.GridView$/.test(node.parent?.cls ?? ''))) continue;
    const key = node.bounds.join(',');
    const cell = node.parent?.bounds.join(',') === key ? node.parent : node;
    if (!tiles.has(key)) tiles.set(key, { node: cell, views: null });
  }
  for (const c of counts) {
    let tile: UiNode | null = c;
    while (tile && !isTile(tile)) tile = tile.parent;
    if (!tile) continue;
    const pct = pctOf(c);
    if (pct != null) uploading = uploading ?? pct;
    const views = pct != null ? null : parseCount(c.text) ?? parseCount(c.desc);
    const key = tile.bounds.join(',');
    const known = tiles.get(key);
    if (!known) tiles.set(key, { node: tile, views });
    else if (pct != null || known.views == null) known.views = views;
  }
  const ordered = [...tiles.values()]
    .filter(({ node }) => ![node, ...descendants(node)].some((child) => hasLabel(child, DRAFT_TILE)))
    .sort((a, b) => (Math.round(a.node.bounds[1] / 40) - Math.round(b.node.bounds[1] / 40)) || (a.node.bounds[0] - b.node.bounds[0]));
  return {
    followers,
    onProfile,
    uploading,
    ownTabSelected: Boolean(profileTab?.selected),
    otherGridTabSelected,
    empty: nodes.some((n) => n.bounds[1] >= headerBottom && hasLabel(n, EMPTY_GRID)),
    tiles: ordered.map((t, index) => ({
      index,
      views: t.views,
      pinned: [t.node, ...descendants(t.node)].some((x) => hasLabel(x, PINNED_RE) || PINNED_RE.test(x.resId.split('/').pop() ?? '')),
      bounds: t.node.bounds[3] <= gridBottom ? t.node.bounds : undefined,
    })),
  };
}

// ── Device flow ───────────────────────────────────────────────────────────────

async function dump(adb: AdbClient, deviceId: string): Promise<string> {
  await adb.shell(deviceId, 'uiautomator dump --compressed /sdcard/kmm_ui.xml >/dev/null 2>&1 || uiautomator dump /sdcard/kmm_ui.xml', 25_000);
  return adb.shell(deviceId, 'cat /sdcard/kmm_ui.xml', 15_000);
}

/** Open the account's own profile in the app via deep link (web URL as fallback). */
export async function openProfile(
  adb: AdbClient, deviceId: string, platform: 'instagram' | 'tiktok', username: string, targetPkg?: string,
): Promise<void> {
  const user = username.replace(/^@+/, '').trim();
  if (platform === 'instagram') {
    await adb.openUrl(deviceId, `instagram://user?username=${user}`, targetPkg || 'com.instagram.android')
      .catch(() => adb.openUrl(deviceId, `https://www.instagram.com/${user}`, targetPkg));
  } else {
    const pkg = targetPkg || 'com.zhiliaoapp.musically';
    for (let attempt = 0; attempt < 3; attempt++) {
      const screen = await dumpScreen(adb, deviceId, 1);
      if (screen?.pkg === pkg) {
        const nodes = parseUiTree(screen.xml);
        const bounds = nodes[0]?.bounds;
        const tab = bounds && tiktokProfileTab(nodes, bounds[2], bounds[3]);
        if (tab) {
          if (!tab.selected) await tapNode(adb, deviceId, tab);
          return;
        }
      }
      if (attempt === 0) await adb.openApp(deviceId, pkg).catch(() => {});
      if (attempt < 2) await sleep(1500);
    }
  }
}

async function tapNode(adb: AdbClient, deviceId: string, node: UiNode): Promise<void> {
  const [x1, y1, x2, y2] = node.bounds;
  await adb.tap(deviceId, (x1 + x2) / 2, (y1 + y2) / 2);
}

export interface ProfileSnapshot {
  onProfile: boolean;
  /** An identifiable, different TikTok account was open. */
  wrongAccount?: boolean;
  empty?: boolean;
  /** Instagram header post count; null on TikTok / when not readable. */
  posts: number | null;
  /** Grid tiles excluding pinned ones, newest first. */
  tiles: ProfileTile[];
  /** Percentage of a post still uploading in the grid (TikTok), null when none. */
  uploading: number | null;
}

type ScreenPixels = Awaited<ReturnType<AdbClient['captureScreenPixels']>>;

export function sampleProfileCover({ pixels, width, height }: ScreenPixels, bounds: Bounds): number[] | undefined {
  const [left, top, right, bottom] = bounds;
  if (pixels.length !== width * height * 4 || left < 0 || top < 0 || right > width || bottom > height ||
      right - left < 48 || bottom - top < 48) return;

  const samples: number[] = [];
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 7; x++) {
      // The post counter and pin badge sit outside the sampled area.
      const px = Math.round(left + (right - left) * (0.14 + x * 0.12));
      const py = Math.round(top + (bottom - top) * (0.23 + y * 0.09));
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (const dy of [-2, 0, 2]) for (const dx of [-2, 0, 2]) {
          sum += pixels[((py + dy) * width + px + dx) * 4 + channel];
        }
        samples.push(Math.round(sum / 9));
      }
    }
  }
  const luminance = samples.filter((_, index) => index % 3 === 0)
    .map((red, index) => (red + samples[index * 3 + 1] + samples[index * 3 + 2]) / 3);
  return Math.max(...luminance) - Math.min(...luminance) >= 20 ? samples : undefined;
}

export function readPublishProfile(xml: string, width: number, height: number, platform: ProfileStats['platform'], username: string): ProfileSnapshot {
  const parsed = parseProfileDump(xml, width, height);
  const nodes = parseUiTree(xml);
  const viewportHeight = nodes[0]?.bounds[3] || height;
  const expected = username.trim();
  const sameAccount = expected ? matchesUsername(nodes, viewportHeight, expected, platform) : parsed.ownTabSelected;
  const hasHandle = nodes.some((n) => n.bounds[3] > n.bounds[1] && n.bounds[1] < viewportHeight * 0.32 &&
    hasLabel(n, /^@[a-z\d._]+$/i));
  const wrongAccount = platform === 'tiktok' && Boolean(expected && !sameAccount && parsed.ownTabSelected && hasHandle);
  const onProfile = (parsed.onProfile || parsed.tiles.length > 0 || parsed.empty) &&
    sameAccount && !(platform === 'tiktok' && parsed.otherGridTabSelected);
  const tiles = onProfile ? parsed.tiles.filter((tile) => !tile.pinned) : [];
  return {
    onProfile,
    wrongAccount,
    posts: onProfile && platform === 'instagram' ? parsePostsCount(xml, width) : null,
    empty: onProfile && parsed.empty && tiles.length === 0,
    tiles,
    uploading: onProfile ? parsed.uploading : null,
  };
}

/** Open the own profile and read post count + grid (used to verify a fresh post). */
export async function snapshotProfile(
  adb: AdbClient, deviceId: string, platform: 'instagram' | 'tiktok', username: string, targetPkg: string, refresh = true,
): Promise<ProfileSnapshot> {
  const { width, height } = await adb.getScreenSize(deviceId);
  await openProfile(adb, deviceId, platform, username, targetPkg);
  let last: ProfileSnapshot = { onProfile: false, posts: null, tiles: [], uploading: null };
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? 650 : 1_500);
    const screen = await dumpScreen(adb, deviceId, 1);
    if (screen?.pkg !== targetPkg) continue;
    const snapshot = readPublishProfile(screen.xml, width, height, platform, username);
    last = snapshot;
    if (snapshot.wrongAccount) return snapshot;
    if (!snapshot.onProfile || (platform === 'tiktok' && !snapshot.empty && !snapshot.tiles.length)) continue;
    if (snapshot.uploading == null) {
      if (platform === 'tiktok' && refresh && !refreshed && attempt < 3) {
        refreshed = true;
        const viewport = parseUiTree(screen.xml)[0]?.bounds;
        const midX = (viewport?.[2] ?? width) / 2;
        const appHeight = viewport?.[3] ?? height;
        await adb.swipe(deviceId, midX, appHeight * 0.35, midX, appHeight * 0.72, 400).catch(() => {});
        continue;
      }
      if (snapshot.posts == null && snapshot.tiles.some((tile) => tile.bounds)) {
        const frame = await adb.captureScreenPixels(deviceId).catch(() => null);
        if (frame) for (const tile of snapshot.tiles.slice(0, 3)) {
          if (tile.bounds) tile.cover = sampleProfileCover(frame, tile.bounds);
        }
      }
    }
    return snapshot;
  }
  return last;
}

export async function collectProfileStats(
  req: { deviceId: string; platform: 'instagram' | 'tiktok'; username: string },
  adb: AdbClient,
  logger: Logger,
): Promise<ProfileStats> {
  const { deviceId, platform } = req;
  const user = req.username.replace(/^@+/, '').trim();
  try {
    await adb.wakeUp(deviceId);
    await adb.shell(deviceId, 'wm dismiss-keyguard');
    const { width, height } = await adb.getScreenSize(deviceId);

    const pkgResolver = new PackageResolver(adb, logger);
    const resolved = await pkgResolver.resolve(deviceId, platform);
    const targetPkg = resolved.packageName;

    await openProfile(adb, deviceId, platform, user, targetPkg);
    await new Promise((r) => setTimeout(r, 5000));

    const xml = await dump(adb, deviceId);
    if (!profileMatchesUsername(xml, height, user, platform)) {
      await adb.home(deviceId).catch(() => {});
      return { ok: false, platform, followers: null, tiles: [], detail: `На телефоне не удалось подтвердить профиль @${user}` };
    }
    const header = parseProfileDump(xml, width, height);
    if (!header.onProfile) {
      await adb.home(deviceId).catch(() => {});
      return { ok: false, platform, followers: null, tiles: [], detail: `Профиль @${user} не открылся (нет счётчика подписчиков на экране)` };
    }
    const posts = platform === 'instagram' ? parsePostsCount(xml, width) : null;
    let tiles = header.tiles;
    // Instagram shows view counts only on the Reels tab of the profile.
    if (platform === 'instagram') {
      const reelsLabel = /^(reels|рилс|видео reels)$/i;
      const reelsTab = parseUiTree(xml).find((n) => reelsLabel.test(n.desc.trim()) || reelsLabel.test(n.text.trim()));
      tiles = [];
      if (reelsTab) {
        const [x1, y1, x2, y2] = reelsTab.bounds;
        await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
        await new Promise((r) => setTimeout(r, 3000));
        const reels = parseProfileDump(await dump(adb, deviceId), width, height);
        if (reels.onProfile) tiles = reels.tiles;
      }
    }

    await adb.home(deviceId).catch(() => {});
    logger.info({ deviceId, platform, user, followers: header.followers, tiles: tiles.length }, 'profile-stats: snapshot');
    return { ok: true, platform, username: user, followers: header.followers, posts, tiles };
  } catch (err) {
    logger.error({ deviceId, err: (err as Error).message }, 'profile-stats: failed');
    return { ok: false, platform, followers: null, tiles: [], detail: (err as Error).message };
  }
}
