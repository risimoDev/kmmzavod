/**
 * Minimal IANA time-zone helpers (no deps) for wall-clock schedules such as
 * autopilot publish windows ("10:00, 14:30, 19:00 in Europe/Moscow").
 */

function partsInTz(date: Date, timeZone: string): Record<string, number> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `timeZone` from UTC at `date`, in ms (Moscow → +3h). */
function tzOffsetMs(date: Date, timeZone: string): number {
  const p = partsInTz(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `timeZone`. Day overflow (d=32) is normalized. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = tzOffsetMs(new Date(guess), timeZone);
  let t = guess - off;
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (off2 !== off) t = guess - off2; // DST edge
  return new Date(t);
}

/** Midnight of the local day containing `date`, as a UTC instant. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const p = partsInTz(date, timeZone);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, timeZone);
}

/** Parse "HH:MM" → [h, m]; null when malformed. */
export function parseHhMm(s: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}

/** Earliest wall-clock time from `times` strictly after `after` (searches 3 days). */
export function nextWallClock(times: string[], timeZone: string, after: Date): Date | null {
  const parsed = times.map(parseHhMm).filter((x): x is [number, number] => x !== null);
  if (parsed.length === 0) return null;
  const p = partsInTz(after, timeZone);
  let best: Date | null = null;
  for (let k = 0; k <= 2; k++) {
    for (const [h, mi] of parsed) {
      const t = zonedToUtc(p.year, p.month, p.day + k, h, mi, timeZone);
      if (t > after && (!best || t < best)) best = t;
    }
    if (best) return best;
  }
  return best;
}
