import { matchTiles, perfScore, median, shadowbanVerdict, thompsonPick, toArms } from '../src/metrics/core';
const ok = (c: boolean, m: string) => console.log(c ? 'PASS' : 'FAIL', m);
const d = (h: number) => new Date(Date.UTC(2026, 9, 7, h));

// 1. Pinned skipped, newest↔newest.
const tiles = [{ index: 0, views: 900000, pinned: true }, { index: 1, views: 120, pinned: false }, { index: 2, views: 4500, pinned: false }, { index: 3, views: 33, pinned: false }];
const posts = [{ id: 'old', publishedAt: d(1) }, { id: 'new', publishedAt: d(9) }, { id: 'mid', publishedAt: d(5) }];
const r = matchTiles(tiles, posts);
ok(JSON.stringify(r.matches.map((m) => [m.publishJobId, m.views])) === JSON.stringify([['new', 120], ['mid', 4500], ['old', 33]]), `match ${JSON.stringify(r.matches.map((m) => [m.publishJobId, m.views]))}`);
ok(!r.lowConfidence && r.unverified.length === 0, 'all verified');

// 2. Whole profile visible but fewer tiles than posts → low confidence + note.
const r2 = matchTiles([{ index: 0, views: 50, pinned: false }], posts);
ok(r2.lowConfidence && r2.unverified.length === 2 && /не появились/.test(r2.note ?? ''), `missing posts detected: ${r2.note}`);
// Full grid on screen (9 tiles) → cannot conclude anything is missing.
const full = Array.from({ length: 9 }, (_, i) => ({ index: i, views: i * 10, pinned: false }));
ok(!matchTiles(full, Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, publishedAt: d(i) }))).lowConfidence, 'full grid → no false alarm');

// 3. perf / median.
ok(median([5, 1, 3]) === 3 && median([1, 2, 3, 4]) === 2.5 && median([]) === null, 'median');
ok(perfScore(500, 500) === 0 && perfScore(1010, 500) > 0.69 && perfScore(0, 500) < -3.9, `perf: ${perfScore(1010, 500)} / ${perfScore(0, 500)}`);

// 4. Shadow-ban heuristic.
ok(shadowbanVerdict([{ views: 3, ageHours: 30 }, { views: 10, ageHours: 50 }, { views: 0, ageHours: 80 }]) === 'suspect', 'suspect');
ok(shadowbanVerdict([{ views: 3, ageHours: 5 }, { views: 10, ageHours: 50 }, { views: 0, ageHours: 80 }]) === 'unknown', 'fresh post ignored → unknown (only 2 mature)');
ok(shadowbanVerdict([{ views: 450, ageHours: 30 }, { views: 1, ageHours: 50 }]) === 'recovered', 'recovered');
ok(shadowbanVerdict([{ views: 80, ageHours: 30 }, { views: 10, ageHours: 50 }, { views: 0, ageHours: 80 }]) === 'ok', 'ok');

// 5. Bandit: clear winner chosen most of the time; untried option still explored.
let seed = 42; const rng = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const arms = toArms([...Array(20)].map(() => ({ key: 'story', perf: 0.8 })).concat([...Array(20)].map(() => ({ key: 'hype', perf: -0.5 }))));
ok(arms.find((a) => a.key === 'story')!.mean === 0.8 && arms.find((a) => a.key === 'hype')!.n === 20, 'toArms');
const counts: Record<string, number> = { story: 0, hype: 0, review: 0 };
for (let i = 0; i < 2000; i++) counts[thompsonPick(['story', 'hype', 'review'], arms, 0.2, rng)]++;
ok(counts.story > 1300 && counts.hype < 250 && counts.review > 150, `picks ${JSON.stringify(counts)} (winner dominates, untried explored, loser rare)`);
ok(thompsonPick(['only'], [], 0.2) === 'only', 'single option');
