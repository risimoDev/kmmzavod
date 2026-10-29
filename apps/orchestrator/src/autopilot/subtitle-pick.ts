/**
 * Autopilot subtitle style for the next montage: a random one of the selected styles,
 * never the same as the previous montage when there is a choice.
 */
export function pickSubtitleStyle(
  selected: string[],
  fallback: string,
  previous: string | null | undefined,
  rng: () => number = Math.random,
): string {
  const list = [...new Set(selected.filter(Boolean))];
  if (list.includes('none')) return 'none';
  if (list.length === 0) return fallback || 'tiktok';
  const pool = list.length > 1 && previous ? list.filter((s) => s !== previous) : list;
  return pool[Math.floor(rng() * pool.length)] ?? list[0];
}
