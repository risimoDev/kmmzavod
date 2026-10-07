/**
 * Metrics & learning core — pure functions (unit-tested in test/metrics.test.ts).
 *
 *   matchTiles        profile grid tiles ↔ our published posts (newest ↔ newest)
 *   perfScore         post success relative to its own account (log ratio)
 *   shadowbanVerdict  "posts get ~no views" detector → account health
 *   thompsonPick      bandit choice among configured options using past perf
 */

export interface Tile { index: number; views: number | null; pinned: boolean }
export interface PostRef { id: string; publishedAt: Date }

export interface TileMatch {
  publishJobId: string;
  tileIndex: number;
  views: number | null;
}

export interface MatchResult {
  matches: TileMatch[];
  /** Low confidence: the grid shows fewer posts than we believe we published. */
  lowConfidence: boolean;
  /** Our posts that could not be found on the profile. */
  unverified: string[];
  note: string | null;
}

/**
 * Pinned tiles are skipped; the remaining grid is newest-first, matched to our
 * posts newest-first. When the screen isn't full (< fullGrid tiles) the grid IS
 * the whole profile, so "fewer tiles than posts" proves some posts never appeared.
 */
export function matchTiles(tiles: Tile[], posts: PostRef[], fullGrid = 9): MatchResult {
  const grid = tiles.filter((t) => !t.pinned);
  const ours = [...posts].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  const n = Math.min(grid.length, ours.length);
  const matches: TileMatch[] = [];
  for (let i = 0; i < n; i++) matches.push({ publishJobId: ours[i].id, tileIndex: grid[i].index, views: grid[i].views });

  const wholeProfileVisible = tiles.length < fullGrid;
  const missing = wholeProfileVisible && grid.length < ours.length ? ours.length - grid.length : 0;
  return {
    matches,
    lowConfidence: missing > 0,
    unverified: ours.slice(n).map((p) => p.id),
    note: missing > 0
      ? `На профиле ${grid.length} постов, а опубликовано ${ours.length}: ${missing} публикаций не появились (приложение не завершило загрузку?)`
      : null,
  };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** ln((views+10)/(baseline+10)): 0 = typical for this account, +0.7 ≈ 2× better. */
export function perfScore(views: number, baseline: number): number {
  return Math.round(Math.log((views + 10) / (baseline + 10)) * 1000) / 1000;
}

export interface MaturePost { views: number; ageHours: number }

/**
 * Last `n` mature (≥24h) posts all below `floor` views → likely shadow-banned.
 * A recent strong post (≥ recover) is evidence of recovery.
 */
export function shadowbanVerdict(postsNewestFirst: MaturePost[], opts = { n: 3, floor: 30, recover: 200 }):
  'suspect' | 'recovered' | 'ok' | 'unknown' {
  const mature = postsNewestFirst.filter((p) => p.ageHours >= 24);
  if (mature.length && mature[0].views >= opts.recover) return 'recovered';
  if (mature.length < opts.n) return 'unknown';
  return mature.slice(0, opts.n).every((p) => p.views < opts.floor) ? 'suspect' : 'ok';
}

export interface Arm { key: string; mean: number; n: number }

/** Box–Muller standard normal (rng injectable for tests). */
function gauss(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Thompson sampling with a Gaussian posterior over the mean perf score:
 * prior N(0, 1), observation variance 0.5. Untried options have wide posteriors
 * and get explored; with probability `exploration` a uniformly random option is
 * taken regardless (keeps learning even after a clear winner emerges).
 */
export function thompsonPick(options: string[], arms: Arm[], exploration = 0.2, rng: () => number = Math.random): string {
  if (!options.length) throw new Error('thompsonPick: no options');
  if (options.length === 1) return options[0];
  if (rng() < exploration) return options[Math.floor(rng() * options.length)];
  const OBS_VAR = 0.5;
  let best = options[0];
  let bestSample = -Infinity;
  for (const key of options) {
    const a = arms.find((x) => x.key === key);
    const n = a?.n ?? 0;
    const precision = 1 + n / OBS_VAR;
    const postMean = n ? (n * a!.mean / OBS_VAR) / precision : 0;
    const sample = postMean + gauss(rng) / Math.sqrt(precision);
    if (sample > bestSample) { bestSample = sample; best = key; }
  }
  return best;
}

/** Aggregate (key, perf) observations into arms. */
export function toArms(obs: { key: string; perf: number }[]): Arm[] {
  const m = new Map<string, { sum: number; n: number }>();
  for (const o of obs) {
    const e = m.get(o.key) ?? { sum: 0, n: 0 };
    e.sum += o.perf;
    e.n += 1;
    m.set(o.key, e);
  }
  return [...m].map(([key, e]) => ({ key, mean: Math.round((e.sum / e.n) * 1000) / 1000, n: e.n }));
}
