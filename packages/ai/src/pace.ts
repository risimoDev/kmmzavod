/**
 * Speech pace (spoken words per second) — per voice, learned from real TTS runs.
 *
 * Every synthesis reports (words, seconds); an exponential moving average per
 * voice+speed converges on how fast that voice actually talks, so scripts are
 * written to the right length instead of a global constant.
 */

/** Typical Russian TTS narration pace before any calibration. */
export const DEFAULT_WPS = 2.3;
const MIN_WPS = 1.4;
const MAX_WPS = 3.6;
/** Weight of a new observation (≈ last 5 runs dominate). */
const ALPHA = 0.3;

export interface PaceEntry { wps: number; n: number }
export type PaceTable = Record<string, PaceEntry>;

/** Pace bucket: voice + speed rounded to 0.05 (speed changes pace ~linearly). */
export function paceKey(voiceId: string | null | undefined, speed = 1): string {
  return `${voiceId || 'default'}@${(Math.round(speed * 20) / 20).toFixed(2)}`;
}

export function paceFor(table: PaceTable | null | undefined, voiceId: string | null | undefined, speed = 1): number {
  const exact = table?.[paceKey(voiceId, speed)];
  if (exact && exact.n > 0) return exact.wps;
  // Same voice at another speed → scale; otherwise the default scaled by speed.
  const base = table?.[paceKey(voiceId, 1)];
  const wps = (base && base.n > 0 ? base.wps : DEFAULT_WPS) * (speed || 1);
  return clamp(wps);
}

/** Fold one measurement into the table (returns a new table). */
export function observePace(
  table: PaceTable | null | undefined, voiceId: string | null | undefined, speed: number,
  words: number, seconds: number,
): PaceTable {
  if (words < 8 || seconds < 3) return { ...(table ?? {}) };
  const measured = clamp(words / seconds);
  const key = paceKey(voiceId, speed);
  const prev = table?.[key];
  const wps = prev && prev.n > 0 ? prev.wps * (1 - ALPHA) + measured * ALPHA : measured;
  return { ...(table ?? {}), [key]: { wps: Math.round(wps * 1000) / 1000, n: (prev?.n ?? 0) + 1 } };
}

export function wordsFor(seconds: number, wps: number): number {
  return Math.max(8, Math.round(seconds * wps));
}

function clamp(v: number): number {
  return Math.min(MAX_WPS, Math.max(MIN_WPS, v));
}
