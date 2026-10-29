import { pickSubtitleStyle } from '../src/autopilot/subtitle-pick';

let failed = 0;
const ok = (c: boolean, m: string) => { if (!c) failed++; console.log(c ? 'PASS' : 'FAIL', m); };

ok(pickSubtitleStyle([], 'mrbeast', null) === 'mrbeast', 'nothing selected → the single subtitleStyle');
ok(pickSubtitleStyle(['none', 'tiktok'], 'tiktok', null) === 'none', '"none" selected → no subtitles');
ok(pickSubtitleStyle(['tiktok'], 'x', 'tiktok') === 'tiktok', 'one style → always it, even if it was last');

const sel = ['tiktok', 'yellow_box', 'gaming', 'pastel'];
let prev: string | null = null;
let repeats = 0;
const seen = new Set<string>();
for (let i = 0; i < 400; i++) {
  const s = pickSubtitleStyle(sel, 'tiktok', prev);
  if (s === prev) repeats++;
  if (!sel.includes(s)) repeats += 1000;
  seen.add(s);
  prev = s;
}
ok(repeats === 0, `400 montages: never the same style twice in a row, never outside the selection (${repeats})`);
ok(seen.size === sel.length, `all ${sel.length} selected styles get used (${[...seen].join(', ')})`);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exitCode = failed ? 1 : 0;
