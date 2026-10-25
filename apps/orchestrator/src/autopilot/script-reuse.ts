/**
 * Autopilot setting «Новый текст озвучки каждые N роликов» (Autopilot.scriptEvery).
 *
 * The voiceover text of the newest montage is reused until it has been used N times in
 * a row; then a fresh script is written. Montage, music and the rotated voice still
 * change every time.
 */

export interface ScriptReuse<T> {
  /** Earlier batch whose text is reused. */
  source: T;
  /** How many montages in a row already used this text (≥ 1). */
  usedTimes: number;
}

/**
 * @param prevNewestFirst earlier batches of this autopilot that got a script and did not
 *   fail, newest first (at least `every` of them are enough).
 * @returns the batch to reuse, or null → write a new script.
 */
export function pickScriptReuse<T extends { script: string | null }>(prevNewestFirst: T[], every: number): ScriptReuse<T> | null {
  if (every <= 1) return null;
  const newest = prevNewestFirst[0];
  if (!newest?.script) return null;
  let used = 0;
  for (const b of prevNewestFirst) {
    if (b.script !== newest.script) break;
    used++;
  }
  return used < every ? { source: newest, usedTimes: used } : null;
}

/** Rotate a list by `offset` (captions of a reused text start elsewhere each repeat). */
export function rotate<T>(list: T[], offset: number): T[] {
  if (list.length === 0) return list;
  const k = ((offset % list.length) + list.length) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}
