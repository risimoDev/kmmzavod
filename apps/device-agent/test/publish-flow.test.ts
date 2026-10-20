import { decide, initialFlowState, isNewPostOnProfile, type FlowState } from '../src/publish-flow';
import { parseUi } from '../src/ui-automation';
import { parsePostsCount } from '../src/profile-stats';

let failed = 0;
const ok = (c: boolean, m: string) => { if (!c) failed++; console.log(c ? 'PASS' : 'FAIL', m); };

// ── fixture builders ──────────────────────────────────────────────────────────
type B = [number, number, number, number];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const el = (o: { text?: string; desc?: string; id?: string; cls?: string; click?: boolean; b: B }, inner = '') =>
  `<node index="0" text="${esc(o.text ?? '')}" resource-id="${o.id ?? ''}" class="${o.cls ?? 'android.widget.TextView'}" ` +
  `package="PKG" content-desc="${esc(o.desc ?? '')}" checkable="false" checked="false" clickable="${o.click ? 'true' : 'false'}" ` +
  `enabled="true" focusable="false" focused="false" bounds="[${o.b[0]},${o.b[1]}][${o.b[2]},${o.b[3]}]"${inner ? `>${inner}</node>` : ' />'}`;
const screen = (pkg: string, ...children: string[]) =>
  parseUi(`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    el({ cls: 'android.widget.FrameLayout', b: [0, 0, 1080, 2400] }, children.join('')).replace(/PKG/g, pkg) + `</hierarchy>`);
const IG = 'com.instagram.android';
const TT = 'com.zhiliaoapp.musically';
const st = (o: Partial<FlowState> = {}): FlowState => ({ ...initialFlowState(), ...o });
const button = (label: string, b: B, id = '') => el({ id, cls: 'android.widget.Button', click: true, b }, el({ text: label, b }));

// ── Instagram ─────────────────────────────────────────────────────────────────
const igShareSheet = screen(IG,
  el({ text: 'Share to', b: [40, 1500, 600, 1560] }),
  button('Feed', [40, 1600, 1040, 1700]),
  button('Reels', [40, 1720, 1040, 1820]),
  button('Story', [40, 1840, 1040, 1940]));
let a = decide('instagram', igShareSheet, st(), true);
ok(a.kind === 'tap' && a.marks === 'target' && a.el.text === 'Reels', `IG share sheet → tap Reels (${a.kind})`);
a = decide('instagram', igShareSheet, st({ targetChosen: true }), true);
ok(a.kind !== 'tap' || a.marks !== 'target', 'IG share sheet not re-chosen once targetChosen');

const igProfileTabs = screen(IG,
  el({ desc: 'Reels', click: true, b: [360, 1000, 720, 1100] }),
  el({ desc: 'Tagged', click: true, b: [720, 1000, 1080, 1100] }));
a = decide('instagram', igProfileTabs, st(), true);
ok(!(a.kind === 'tap' && a.marks === 'target'), 'IG profile "Reels" tab is NOT treated as share target');

const igEditor = screen(IG,
  el({ desc: 'Close', click: true, b: [20, 80, 140, 200] }),
  button('Next', [800, 2200, 1040, 2320], 'com.instagram.android:id/clips_right_action_button'));
a = decide('instagram', igEditor, st({ targetChosen: true }), true);
ok(a.kind === 'tap' && a.marks === 'next', `IG editor → Next (${a.kind})`);

const igEditorRu = screen(IG, button('Далее', [800, 2200, 1040, 2320]));
a = decide('instagram', igEditorRu, st({ targetChosen: true }), true);
ok(a.kind === 'tap' && a.marks === 'next', 'IG editor (ru) → Далее');

const igCaption = screen(IG,
  el({ id: 'com.instagram.android:id/caption_input_text_view', cls: 'android.widget.EditText', text: 'Write a caption...', click: true, b: [40, 300, 1040, 500] }),
  button('Share', [40, 2200, 1040, 2320], 'com.instagram.android:id/share_button'));
a = decide('instagram', igCaption, st({ targetChosen: true }), true);
ok(a.kind === 'caption', `IG caption screen → type caption first (${a.kind})`);
a = decide('instagram', igCaption, st({ targetChosen: true, captionDone: true }), true);
ok(a.kind === 'tap' && a.marks === 'share', 'IG caption screen, caption typed → Share');
a = decide('instagram', igCaption, st({ targetChosen: true }), false);
ok(a.kind === 'tap' && a.marks === 'share', 'IG caption screen, no caption → Share directly');

const permission = screen('com.google.android.permissioncontroller',
  el({ text: 'Allow Instagram to access photos and videos?', b: [60, 900, 1020, 1000] }),
  button('Allow', [60, 1100, 1020, 1200], 'com.android.permissioncontroller:id/permission_allow_button'),
  button("Don't allow", [60, 1220, 1020, 1320], 'com.android.permissioncontroller:id/permission_deny_button'));
a = decide('instagram', permission, st(), true);
ok(a.kind === 'tap' && a.el.resId.endsWith('permission_allow_button'), 'permission dialog → Allow');

const discard = screen(IG,
  el({ text: 'Discard reel?', b: [60, 900, 1020, 1000] }),
  button('Discard', [60, 1100, 1020, 1200]),
  button('Keep editing', [60, 1220, 1020, 1320]));
a = decide('instagram', discard, st({ targetChosen: true }), true);
ok(a.kind === 'tap' && /keep editing/i.test(a.el.text || a.el.parent?.text || ''), 'discard dialog → Keep editing (never Discard)');

const tip = screen(IG, el({ text: 'Reels are now longer', b: [60, 900, 1020, 1000] }), button('OK', [60, 1100, 1020, 1200]));
a = decide('instagram', tip, st({ targetChosen: true }), true);
ok(a.kind === 'tap' && !a.marks, 'tip dialog → OK');

const loggedOut = screen(IG, button('Log in', [60, 1500, 1020, 1600]), button('Create new account', [60, 1700, 1020, 1800]));
a = decide('instagram', loggedOut, st(), true);
ok(a.kind === 'error' && !a.retryable, 'login screen → non-retryable error');

const unknown = screen(IG, el({ text: 'Something', b: [0, 0, 500, 100] }));
ok(decide('instagram', unknown, st(), true).kind === 'unknown', 'unrecognised screen → unknown (no blind taps)');

// After Share
const posting = screen(IG, el({ text: 'Posting…', b: [100, 200, 900, 260] }));
ok(decide('instagram', posting, st({ shareTapped: true }), true).kind === 'progress', 'after share: "Posting…" → progress');
const pct = screen(IG, el({ text: '45%', b: [100, 200, 300, 260] }));
ok(decide('instagram', pct, st({ shareTapped: true }), true).kind === 'progress', 'after share: "45%" → progress');
const shared = screen(IG, el({ text: 'Your reel has been shared.', b: [100, 200, 900, 260] }));
ok(decide('instagram', shared, st({ shareTapped: true }), true).kind === 'success', 'after share: "shared" → success');
const sharedRu = screen(IG, el({ text: 'Видео Reels опубликовано', b: [100, 200, 900, 260] }));
ok(decide('instagram', sharedRu, st({ shareTapped: true }), true).kind === 'success', 'after share (ru): "опубликовано" → success');
const failedUp = screen(IG, el({ text: "Couldn't post. Tap to retry.", b: [100, 200, 900, 260] }));
a = decide('instagram', failedUp, st({ shareTapped: true }), true);
ok(a.kind === 'error' && !a.retryable, 'after share: upload failed → error, not retryable');
// The caption screen must never be "shared" twice
a = decide('instagram', igCaption, st({ targetChosen: true, captionDone: true, shareTapped: true }), true);
ok(!(a.kind === 'tap' && a.marks === 'share'), 'after share: never taps Share again');

// ── TikTok ────────────────────────────────────────────────────────────────────
const ttEditor = screen(TT, button('Next', [700, 2200, 1040, 2320]), el({ desc: 'Sounds', click: true, b: [300, 80, 780, 180] }));
a = decide('tiktok', ttEditor, st(), true);
ok(a.kind === 'tap' && a.marks === 'next', 'TikTok editor → Next');

const ttPost = screen(TT,
  el({ id: 'com.zhiliaoapp.musically:id/desc', cls: 'android.widget.EditText', text: 'Добавьте описание...', click: true, b: [40, 300, 800, 600] }),
  button('Черновики', [40, 2200, 520, 2320]),
  button('Опубликовать', [560, 2200, 1040, 2320]));
a = decide('tiktok', ttPost, st(), true);
ok(a.kind === 'caption', 'TikTok post screen (ru) → type description');
a = decide('tiktok', ttPost, st({ captionDone: true }), true);
ok(a.kind === 'tap' && a.marks === 'share' && /Опубликовать/.test(a.el.text || ''), 'TikTok post screen → Опубликовать (not Черновики)');

const ttConfirm = screen(TT, el({ text: 'Post video?', b: [60, 900, 1020, 1000] }), button('Post now', [60, 1100, 1020, 1200]));
a = decide('tiktok', ttConfirm, st({ shareTapped: true }), true);
ok(a.kind === 'tap' && !a.marks, 'TikTok confirm → Post now');

const ttShareSheet = screen(TT,
  el({ text: 'Поделиться', b: [40, 1500, 600, 1560] }),
  button('Чаты', [40, 1600, 1040, 1700]),
  button('Опубликовать в ленту', [40, 1720, 1040, 1820]));
a = decide('tiktok', ttShareSheet, st(), true);

ok(a.kind === 'tap' && a.marks === 'target' && /Опубликовать в ленту/.test(a.el.text || ''), `TikTok share sheet → tap Feed target (${a.kind})`);

const ttPostNow = screen(TT,
  el({ id: 'com.zhiliaoapp.musically:id/desc', cls: 'android.widget.EditText', text: 'Добавьте описание...', click: true, b: [40, 300, 800, 600] }),
  button('Опубликовать сейчас', [560, 2200, 1040, 2320]));
a = decide('tiktok', ttPostNow, st({ captionDone: true }), true);
ok(a.kind === 'tap' && a.marks === 'share', 'TikTok post screen → Опубликовать сейчас');

const ttPreConfirm = screen(TT,
  el({ text: 'Проверка авторских прав на звук', b: [60, 900, 1020, 1000] }),
  button('Всё равно опубликовать', [60, 1100, 1020, 1200]));
a = decide('tiktok', ttPreConfirm, st(), true);
ok(a.kind === 'tap' && !a.marks && /Всё равно опубликовать/.test(a.el.text || ''), 'TikTok pre-confirm → Всё равно опубликовать');

const ttHomeAfterShare = screen(TT,
  el({ text: 'Главная', b: [50, 2300, 200, 2380] }),
  el({ text: 'Профиль', b: [850, 2300, 1000, 2380] }));
a = decide('tiktok', ttHomeAfterShare, st({ shareTapped: true }), true);
ok(a.kind === 'success', 'TikTok after share: return to home/profile bottom nav → success');

// ── Profile verification ─────────────────────────────────────────────────────
ok(isNewPostOnProfile({ posts: 12, tiles: [] }, { posts: 13, tiles: [] }), 'IG: posts 12 → 13 = new post');
ok(!isNewPostOnProfile({ posts: 12, tiles: [] }, { posts: 12, tiles: [] }), 'IG: posts unchanged = not posted');
ok(isNewPostOnProfile({ posts: null, tiles: [{ views: 5 }, { views: 40 }] }, { posts: null, tiles: [{ views: 0 }, { views: 5 }, { views: 40 }] }),
  'TikTok: grid not full and gained a tile');
const fullBefore = { posts: null, tiles: Array.from({ length: 9 }, (_, i) => ({ views: 300 + i * 100 })) };
ok(isNewPostOnProfile(fullBefore, { posts: null, tiles: [{ views: 0 }, ...fullBefore.tiles.slice(0, 8).map((t) => ({ views: t.views + 3 }))] }),
  'TikTok full grid: newest shifted to #2, fresh tile with 0 views → new post');
ok(!isNewPostOnProfile(fullBefore, { posts: null, tiles: fullBefore.tiles.map((t) => ({ views: t.views + 10 })) }),
  'TikTok full grid: same tiles, views grew → NOT a new post');
const zeroBefore = { posts: null, tiles: Array.from({ length: 9 }, () => ({ views: 0 })) };
ok(!isNewPostOnProfile(zeroBefore, zeroBefore), 'ambiguous (all 0 views, full grid) → unverified, not guessed');

// ── IG header post count ──────────────────────────────────────────────────────
const header = (posts: string) => `<?xml version='1.0' ?><hierarchy rotation="0">` +
  el({ cls: 'android.widget.FrameLayout', b: [0, 0, 1080, 2400] },
    el({ text: posts, b: [300, 300, 450, 360] }) + el({ text: 'posts', b: [300, 370, 450, 420] }) +
    el({ text: '1,234', b: [500, 300, 700, 360] }) + el({ text: 'followers', b: [500, 370, 700, 420] })).replace(/PKG/g, IG) +
  `</hierarchy>`;
ok(parsePostsCount(header('57'), 1080) === 57, `IG header posts 57 → ${parsePostsCount(header('57'), 1080)}`);
const headerRu = `<?xml version='1.0' ?><hierarchy rotation="0">` +
  el({ cls: 'android.widget.FrameLayout', b: [0, 0, 1080, 2400] }, el({ desc: '1 024\nпубликации', b: [300, 300, 450, 420] })).replace(/PKG/g, IG) + `</hierarchy>`;
ok(parsePostsCount(headerRu, 1080) === 1024, `IG header (ru, inline) 1 024 публикации → ${parsePostsCount(headerRu, 1080)}`);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exitCode = failed ? 1 : 0;
