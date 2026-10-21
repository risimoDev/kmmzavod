/**
 * Screen-reading UI automation over ADB (uiautomator dump + taps + text entry).
 *
 * Everything here acts on what is actually on screen — elements are found by text,
 * content-desc, resource-id and class, never by fixed coordinates. The XML parser is
 * pure so flows can be unit-tested on recorded dumps.
 */
import type { AdbClient } from './adb-client';

export interface UiEl {
  text: string;
  desc: string;
  resId: string;
  cls: string;
  pkg: string;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  bounds: [number, number, number, number];
  parent: UiEl | null;
}

export interface UiScreen {
  xml: string;
  els: UiEl[];
  /** Package of the window that was dumped (root node). */
  pkg: string;
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  if (!m) return '';
  return m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Parse a `uiautomator dump` into a flat list (document order) with parent links. */
export function parseUi(xml: string): UiScreen {
  const els: UiEl[] = [];
  const stack: UiEl[] = [];
  const re = /<node\b[^>]*?(\/?)>|<\/node>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0] === '</node>') { stack.pop(); continue; }
    const tag = m[0];
    const b = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(tag);
    const el: UiEl = {
      text: attr(tag, 'text'),
      desc: attr(tag, 'content-desc'),
      resId: attr(tag, 'resource-id'),
      cls: attr(tag, 'class'),
      pkg: attr(tag, 'package'),
      clickable: attr(tag, 'clickable') === 'true',
      enabled: attr(tag, 'enabled') !== 'false',
      focused: attr(tag, 'focused') === 'true',
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
      parent: stack[stack.length - 1] ?? null,
    };
    els.push(el);
    if (m[1] !== '/') stack.push(el);
  }
  return { xml, els, pkg: els[0]?.pkg ?? '' };
}

/** Visible label of an element: its text, or content-desc when the text is empty. */
export function label(el: UiEl): string {
  return (el.text || el.desc).replace(/\s+/g, ' ').trim();
}

export function isVisible(el: UiEl): boolean {
  const [x1, y1, x2, y2] = el.bounds;
  return x2 - x1 > 2 && y2 - y1 > 2;
}

/** Element whose label (text or desc) fully matches `re`; prefers enabled + visible ones. */
export function byLabel(s: UiScreen, re: RegExp): UiEl | undefined {
  return s.els.find((e) => isVisible(e) && e.enabled && (re.test(e.text.trim()) || re.test(e.desc.trim())));
}

/** Element whose resource-id (the part after ':id/') matches `re`. */
export function byResId(s: UiScreen, re: RegExp): UiEl | undefined {
  return s.els.find((e) => isVisible(e) && e.enabled && re.test(e.resId.replace(/^.*:id\//, '')));
}

/** Any text/desc on screen matches `re` (substring search). */
export function screenHas(s: UiScreen, re: RegExp): boolean {
  return s.els.some((e) => re.test(e.text) || re.test(e.desc));
}

export function editTexts(s: UiScreen): UiEl[] {
  return s.els.filter((e) => isVisible(e) && /EditText$/.test(e.cls));
}

/** Nearest clickable ancestor-or-self (labels are often non-clickable TextViews). */
export function clickTarget(el: UiEl): UiEl {
  let t: UiEl | null = el;
  while (t && !t.clickable) t = t.parent;
  return t ?? el;
}

export function center(el: UiEl): { x: number; y: number } {
  const [x1, y1, x2, y2] = el.bounds;
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

// ── Device side ───────────────────────────────────────────────────────────────

const DUMP_PATH = '/sdcard/kmm_ui.xml';
export const DEBUG_DIR = '/sdcard/kmm-debug';

/**
 * Dump the current window. `uiautomator dump` refuses while the screen never goes idle
 * (a playing video preview), so it is retried a few times before giving up.
 */
export async function dumpScreen(adb: AdbClient, deviceId: string, attempts = 3): Promise<UiScreen | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const dumpCmd = i % 2 === 0 ? `uiautomator dump --compressed ${DUMP_PATH}` : `uiautomator dump ${DUMP_PATH}`;
      const out = await adb.fastShell(deviceId, `${dumpCmd} >/dev/null 2>&1; cat ${DUMP_PATH}; rm -f ${DUMP_PATH}`, 20_000);
      const start = out.indexOf('<?xml');
      if (start >= 0 && out.includes('<hierarchy')) return parseUi(out.slice(start));
    } catch {
      // retry
    }
    await sleep(800);
  }
  return null;
}

/**
 * Tap the element itself (its own centre). A touch inside a label reaches its clickable
 * parent anyway, whereas the centre of that parent can be far away when the parent is a
 * large container (a bottom panel, the whole page) — a tap that misses the button.
 * The clickable ancestor is used only when the element has no size of its own.
 */
export async function tapEl(adb: AdbClient, deviceId: string, el: UiEl): Promise<void> {
  const { x, y } = center(isVisible(el) ? el : clickTarget(el));
  await adb.tap(deviceId, x, y);
}

const ADB_KEYBOARD_PKG = 'com.android.adbkeyboard';
const ADB_KEYBOARD_IME = `${ADB_KEYBOARD_PKG}/.AdbIME`;

/** Printable ASCII only — the only thing Android's `input text` can type. */
export function isPlainAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

export async function hasAdbKeyboard(adb: AdbClient, deviceId: string): Promise<boolean> {
  const out = await adb.fastShell(deviceId, `pm list packages ${ADB_KEYBOARD_PKG}`).catch(() => '');
  return out.includes(`package:${ADB_KEYBOARD_PKG}`);
}

/**
 * Type `text` into the focused field.
 *   - plain ASCII on one line → `input text` (spaces sent as %s, which every Android accepts);
 *   - anything else (Cyrillic, emoji, newlines) → ADBKeyboard (github.com/senzhk/ADBKeyBoard):
 *     switch IME, send the text base64-encoded, restore the previous IME.
 * Throws when the text needs ADBKeyboard and it is not installed.
 */
export async function typeText(adb: AdbClient, deviceId: string, text: string): Promise<void> {
  if (isPlainAscii(text)) {
    // Escape everything sh would interpret (incl. "#" — a word starting with it is a comment),
    // then send spaces as %s, which `input text` turns back into spaces.
    const escaped = text.replace(/([\\"$`'()|&;<>*?~#[\]{}])/g, '\\$1').replace(/ /g, '%s');
    await adb.fastShell(deviceId, `input text ${escaped}`);
    return;
  }
  if (!(await hasAdbKeyboard(adb, deviceId))) {
    throw new Error(
      'Для ввода подписи с кириллицей/эмодзи на плате нужен ADBKeyboard (пакет com.android.adbkeyboard) — ' +
      'установите APK через «Стойка плат → APK»',
    );
  }
  const prevIme = (await adb.fastShell(deviceId, 'settings get secure default_input_method').catch(() => '')).trim();
  try {
    await adb.fastShell(deviceId, `ime enable ${ADB_KEYBOARD_IME} >/dev/null 2>&1; ime set ${ADB_KEYBOARD_IME}`);
    await sleep(700);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    await adb.fastShell(deviceId, `am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
    await sleep(900);
  } finally {
    if (prevIme && prevIme !== 'null' && prevIme !== ADB_KEYBOARD_IME) {
      await adb.fastShell(deviceId, `ime set ${prevIme}`).catch(() => {});
    }
  }
}

/** Save the current screen (PNG + UI dump) for post-mortem, outside the gallery. */
export async function saveDebugSnapshot(adb: AdbClient, deviceId: string, tag: string, xml?: string): Promise<string> {
  const base = `${DEBUG_DIR}/${tag}_${Date.now()}`;
  await adb.fastShell(deviceId, `mkdir -p ${DEBUG_DIR} && touch ${DEBUG_DIR}/.nomedia && screencap -p ${base}.png`).catch(() => {});
  if (xml) {
    const b64 = Buffer.from(xml, 'utf8').toString('base64');
    // Chunked: one shell line must stay well below the command-line limit.
    await adb.fastShell(deviceId, `rm -f ${base}.b64`).catch(() => {});
    for (let i = 0; i < b64.length; i += 8000) {
      await adb.fastShell(deviceId, `echo -n ${b64.slice(i, i + 8000)} >> ${base}.b64`).catch(() => {});
    }
    await adb.fastShell(deviceId, `base64 -d ${base}.b64 > ${base}.xml && rm -f ${base}.b64`).catch(() => {});
  }
  return base;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
