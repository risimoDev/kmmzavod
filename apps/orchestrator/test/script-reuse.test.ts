import { pickScriptReuse, rotate } from '../src/autopilot/script-reuse';

let failed = 0;
const ok = (c: boolean, m: string) => { if (!c) failed++; console.log(c ? 'PASS' : 'FAIL', m); };
const b = (script: string | null, id = script ?? '-') => ({ id, script });

// Simulate an autopilot producing montages one after another with scriptEvery = N.
function run(every: number, montages: number): string[] {
  const history: { id: string; script: string | null }[] = []; // newest first
  let textNo = 0;
  const out: string[] = [];
  for (let i = 0; i < montages; i++) {
    const reuse = pickScriptReuse(history, every);
    const text = reuse ? reuse.source.script! : `T${++textNo}`;
    out.push(text);
    history.unshift(b(text, `m${i}`));
  }
  return out;
}

ok(JSON.stringify(run(1, 4)) === JSON.stringify(['T1', 'T2', 'T3', 'T4']), 'every=1 → new text every montage');
ok(JSON.stringify(run(3, 7)) === JSON.stringify(['T1', 'T1', 'T1', 'T2', 'T2', 'T2', 'T3']), `every=3 → T1×3, T2×3, T3 (${run(3, 7)})`);
ok(JSON.stringify(run(2, 5)) === JSON.stringify(['T1', 'T1', 'T2', 'T2', 'T3']), 'every=2 → pairs');

ok(pickScriptReuse([], 3) === null, 'no earlier montages → new text');
ok(pickScriptReuse([b(null)], 3) === null, 'newest earlier montage has no script → new text');
const r = pickScriptReuse([b('A'), b('A'), b('B')], 3);
ok(r?.source.script === 'A' && r.usedTimes === 2, 'A used twice of 3 → reuse A (usedTimes=2)');
ok(pickScriptReuse([b('A'), b('A'), b('A')], 3) === null, 'A used 3 of 3 → new text');
ok(pickScriptReuse([b('A'), b('A'), b('A'), b('A')], 3) === null, 'setting lowered below current run → new text');

ok(JSON.stringify(rotate([1, 2, 3, 4], 1)) === '[2,3,4,1]', 'rotate by 1');
ok(JSON.stringify(rotate([1, 2, 3], 7)) === '[2,3,1]', 'rotate wraps');
ok(JSON.stringify(rotate([], 3)) === '[]', 'rotate empty');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exitCode = failed ? 1 : 0;
