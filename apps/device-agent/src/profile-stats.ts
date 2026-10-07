/**
 * Profile stats snapshot (Instagram Reels / TikTok) via the Android UI hierarchy.
 *
 * Opens the account's own profile on the phone, dumps the screen with
 * `uiautomator dump`, and reads:
 *   • followers (header),
 *   • the post grid: view count on each tile (newest first), pinned tiles.
 *
 * The orchestrator matches tiles to its PublishJobs (newest ↔ newest) to record
 * per-post views and to VERIFY that a post really appeared on the profile.
 * Parsing is a pure function (`parseProfileDump`) so it is unit-testable on
 * XML fixtures without a phone.
 */
import type { Logger } from 'pino';
import type { AdbClient } from './adb-client';

export interface ProfileTile {
  index: number;          // 0 = top-left (newest unless pinned)
  views: number | null;
  pinned: boolean;
}

export interface ProfileStats {
  ok: boolean;
  platform: 'instagram' | 'tiktok';
  followers: number | null;
  tiles: ProfileTile[];
  detail?: string;
}

// ── Count parsing ("1,234", "1 234", "12.3K", "12,3 тыс.", "1,2 млн") ────────

export function parseCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.replace(/[  ]/g, ' ').trim().toLowerCase();
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
  clickable: boolean;
  bounds: [number, number, number, number];
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
      clickable: attr(tag, 'clickable') === 'true',
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
const PINNED_RE = /(закреплен|pinned)/i;

function descendants(n: UiNode): UiNode[] {
  const out: UiNode[] = [];
  const walk = (x: UiNode) => { for (const c of x.children) { out.push(c); walk(c); } };
  walk(n);
  return out;
}

/** Pure parser: followers + grid tiles (with views) from a profile screen dump. */
export function parseProfileDump(xml: string, screenW: number, screenH: number): { followers: number | null; tiles: ProfileTile[]; onProfile: boolean } {
  const nodes = parseUiTree(xml);

  // Followers: "1,2 тыс.\nподписчиков" in one node, or a number node right above
  // (same column) a "Подписчики/Followers" label.
  let followers: number | null = null;
  let headerBottom = 0;
  for (const n of nodes) {
    const label = `${n.text} ${n.desc}`;
    if (!FOLLOWERS_RE.test(label)) continue;
    headerBottom = Math.max(headerBottom, n.bounds[3]);
    const inline = /([\d\s.,]+(?:k|к|тыс\.?|m|м|млн\.?)?)\s*(подписчик|followers)/i.exec(label);
    if (inline && parseCount(inline[1]) != null) { followers = parseCount(inline[1]); continue; }
    const cx = (n.bounds[0] + n.bounds[2]) / 2;
    const above = nodes
      .filter((x) => parseCount(x.text) != null && x.bounds[3] <= n.bounds[1] + 10 && n.bounds[1] - x.bounds[3] < 160
        && Math.abs((x.bounds[0] + x.bounds[2]) / 2 - cx) < screenW * 0.12)
      .sort((a, b) => b.bounds[3] - a.bounds[3]);
    if (above[0]) followers = parseCount(above[0].text);
  }
  const onProfile = headerBottom > 0;

  // Grid tiles: count nodes below the header and above the bottom navigation,
  // grouped by their tile container (≈ 1/3 of the screen wide).
  const tileW = screenW / 3;
  const counts = nodes.filter((n) => {
    const v = parseCount(n.text) ?? parseCount(n.desc);
    return v != null && n.bounds[1] > headerBottom + 20 && n.bounds[3] < screenH * 0.93;
  });
  const tiles = new Map<UiNode, { node: UiNode; views: number | null }>();
  for (const c of counts) {
    let t: UiNode | null = c.parent;
    while (t && !(Math.abs((t.bounds[2] - t.bounds[0]) - tileW) < tileW * 0.3 && t.bounds[3] - t.bounds[1] > tileW * 0.6)) t = t.parent;
    const tile = t ?? c;
    if (!tiles.has(tile)) tiles.set(tile, { node: tile, views: parseCount(c.text) ?? parseCount(c.desc) });
  }
  const ordered = [...tiles.values()]
    .sort((a, b) => (Math.round(a.node.bounds[1] / 40) - Math.round(b.node.bounds[1] / 40)) || (a.node.bounds[0] - b.node.bounds[0]));
  return {
    followers,
    onProfile,
    tiles: ordered.map((t, index) => ({
      index,
      views: t.views,
      pinned: [t.node, ...descendants(t.node)].some((x) => PINNED_RE.test(`${x.text} ${x.desc}`)),
    })),
  };
}

// ── Device flow ───────────────────────────────────────────────────────────────

async function dump(adb: AdbClient, deviceId: string): Promise<string> {
  await adb.shell(deviceId, 'uiautomator dump /sdcard/kmm_ui.xml', 25_000);
  return adb.shell(deviceId, 'cat /sdcard/kmm_ui.xml', 15_000);
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

    if (platform === 'instagram') {
      await adb.openUrl(deviceId, `instagram://user?username=${user}`, 'com.instagram.android')
        .catch(() => adb.openUrl(deviceId, `https://www.instagram.com/${user}`));
    } else {
      await adb.openUrl(deviceId, `https://www.tiktok.com/@${user}`)
        .catch(() => adb.openUrl(deviceId, `snssdk1233://user/profile/${user}`));
    }
    await new Promise((r) => setTimeout(r, 5000));

    let xml = await dump(adb, deviceId);
    // Instagram shows view counts only on the Reels tab of the profile.
    if (platform === 'instagram') {
      const reelsTab = parseUiTree(xml).find((n) => /^reels$/i.test(n.desc.trim()) || /^reels$/i.test(n.text.trim()));
      if (reelsTab) {
        const [x1, y1, x2, y2] = reelsTab.bounds;
        await adb.tap(deviceId, Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
        await new Promise((r) => setTimeout(r, 3000));
        xml = await dump(adb, deviceId);
      }
    }

    const parsed = parseProfileDump(xml, width, height);
    await adb.home(deviceId).catch(() => {});
    if (!parsed.onProfile) {
      return { ok: false, platform, followers: null, tiles: [], detail: `Профиль @${user} не открылся (нет счётчика подписчиков на экране)` };
    }
    logger.info({ deviceId, platform, user, followers: parsed.followers, tiles: parsed.tiles.length }, 'profile-stats: snapshot');
    return { ok: true, platform, followers: parsed.followers, tiles: parsed.tiles };
  } catch (err) {
    logger.error({ deviceId, err: (err as Error).message }, 'profile-stats: failed');
    return { ok: false, platform, followers: null, tiles: [], detail: (err as Error).message };
  }
}
