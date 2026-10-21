/**
 * Decision logic of the on-phone publishing flows (Instagram Reels, TikTok).
 *
 * `decide()` looks at ONE screen dump and returns the next action. It is a pure
 * function: the device loop in publish.ts executes the action, dumps again and asks
 * again. Labels are matched in English and Russian; anything unrecognised is reported
 * as `unknown` instead of being tapped blindly.
 */
import { byLabel, byResId, editTexts, isVisible, screenHas, type UiEl, type UiScreen } from './ui-automation';

export type FlowPlatform = 'instagram' | 'tiktok';

export interface FlowState {
  /** The share-target choice (Instagram: Reels vs Feed/Story) was made. */
  targetChosen: boolean;
  /** The caption was typed into the caption field. */
  captionDone: boolean;
  /** The final Share/Post button was tapped — from here on the post may exist. */
  shareTapped: boolean;
  nextTaps: number;
}

export type FlowAction =
  | { kind: 'tap'; el: UiEl; why: string; marks?: 'share' | 'target' | 'next' }
  | { kind: 'caption'; el: UiEl }
  | { kind: 'progress'; why: string }
  | { kind: 'success'; why: string }
  | { kind: 'error'; why: string; retryable: boolean }
  | { kind: 'unknown' };

export function initialFlowState(): FlowState {
  return { targetChosen: false, captionDone: false, shareTapped: false, nextTaps: 0 };
}

// ── Labels ────────────────────────────────────────────────────────────────────

const PERMISSION_ALLOW_ID = /^permission_allow(_foreground_only|_all|_one_time)?_button$/;
const ALLOW = /^(allow|allow all|разрешить|разрешить все|while using the app|при использовании приложения|только во время использования приложения)$/i;
/** Harmless "close this tip/prompt" buttons. Deliberately no "Close"/"Cancel": those discard drafts. */
const DISMISS = /^(not now|не сейчас|skip|пропустить|got it|понятно|понял|ok|ок|okay|no thanks|нет, спасибо|later|позже|maybe later|dismiss)$/i;
/** "Discard reel?" dialogs → keep editing, never discard. */
const KEEP_EDITING = /^(keep editing|продолжить редактирование|continue editing)$/i;
const LOGGED_OUT = /^(log in|войти|sign up|зарегистрироваться|create new account|создать новый аккаунт|log into another account)$/i;

const NEXT = /^(next|далее|дальше)$/i;
const NEXT_ID = /(^|_)next(_button)?(_textview)?$/i;
const IG_REELS_TARGET = /^(reels?)$/i;
const IG_OTHER_TARGETS = /^(feed|лента|story|stories|история|истории|post|публикация|chats|чаты)$/i;
const TT_FEED_TARGET = /^(post(\s+to\s+feed)?|лента|опубликовать(\s+в\s+ленту)?|поделиться\s+в\s+tiktok)$/i;
const TT_OTHER_TARGETS = /^(chats|чаты|друзья|friends|direct|сообщения|messages)$/i;
const IG_SHARE = /^(share|поделиться|опубликовать)$/i;
const IG_SHARE_ID = /share_button|(^|_)share$/i;
const TT_POST = /(?:^|\b|\W)(post(\s+now|\s+video)?|опубликовать(\s+сейчас|\s+видео)?|publish)(?:$|\b|\W)/i;
const TT_POST_EXCLUDE = /story|draft|черновик|истори/i;
const TT_POST_ID = /publish|post_button|(^|_)post(_layout|_btn|_view|_title|_action)?$/i;
const POST_CONFIRM = /^(post now|опубликовать сейчас|post anyway|всё равно опубликовать|share now|поделиться сейчас|продолжить|continue|всё равно продолжить)$/i;
const TT_HOME_NAV = /^(home|главная|friends|друзья|inbox|входящие|profile|профиль|я)$/i;

const CAPTION_FIELD_ID = /caption|desc|title/i;
const CAPTION_FIELD_HINT = /caption|подпис|describe|description|описан|хэштег|hashtag/i;

/** Before sharing: the app refused the video itself — retrying the same file will not help. */
const VIDEO_REJECTED = /(video|видео) (is )?(too (short|long)|слишком (коротк|длинн))|unsupported (video|file|format)|неподдерживаем|can.?t (use|import) this video|не удалось импортировать/i;
const UPLOAD_FAILED = /((couldn.?t|could not|can.?t|unable to) (post|upload|share))|не удалось (опубликовать|загрузить|поделиться|отправить)|upload failed|ошибка (загрузки|публикации)|публикация не удалась/i;
const IN_PROGRESS = /\b(posting|uploading|sharing|processing)\b|публикуется|загружается|идёт загрузка|идет загрузка|отправка|обработка видео|^публикация\.{0,3}$|\b\d{1,3}\s?%/i;
const POSTED = /\b(shared|posted|uploaded)\b|опубликован|видео загружено|^загружено$|публикация завершена/i;

// ── Decision ──────────────────────────────────────────────────────────────────

/**
 * Locate the final Share/Post button in the lower half of the screen.
 * TikTok headers often have static title text "Post" at the top of the screen —
 * restricting candidates to the bottom half (y >= maxY * 0.45) prevents tapping the title.
 */
export function findPostButton(s: UiScreen, platform: FlowPlatform): UiEl | undefined {
  const maxY = Math.max(...s.els.map((e) => e.bounds[3]), 1000);
  const bottomHalfMinY = maxY * 0.45;

  const matchEl = (e: UiEl, labelRe: RegExp, idRe: RegExp): boolean => {
    if (!isVisible(e) || !e.enabled) return false;
    const txt = `${e.text} ${e.desc}`.trim();
    if (TT_POST_EXCLUDE.test(txt)) return false;
    const resId = e.resId.replace(/^.*:id\//, '');
    return labelRe.test(txt) || idRe.test(resId);
  };

  if (platform === 'instagram') {
    return s.els.slice().reverse().find((e) => e.bounds[1] >= bottomHalfMinY && matchEl(e, IG_SHARE, IG_SHARE_ID))
      ?? s.els.slice().reverse().find((e) => matchEl(e, IG_SHARE, IG_SHARE_ID));
  }

  // TikTok: strictly in the lower half of the screen, bottom-most first
  return s.els.slice().reverse().find((e) => e.bounds[1] >= bottomHalfMinY && matchEl(e, TT_POST, TT_POST_ID));
}

function captionField(s: UiScreen): UiEl | undefined {
  const fields = editTexts(s);
  return fields.find((e) => CAPTION_FIELD_ID.test(e.resId.replace(/^.*:id\//, '')) || CAPTION_FIELD_HINT.test(`${e.text} ${e.desc}`))
    ?? (fields.length === 1 ? fields[0] : undefined);
}

export function decide(platform: FlowPlatform, s: UiScreen, st: FlowState, hasCaption: boolean): FlowAction {
  // System runtime-permission dialog (gallery / media access).
  const allow = byResId(s, PERMISSION_ALLOW_ID)
    ?? (/permissioncontroller|packageinstaller/.test(s.pkg) ? byLabel(s, ALLOW) : undefined);
  if (allow) return { kind: 'tap', el: allow, why: 'разрешение доступа к медиа' };

  const keep = byLabel(s, KEEP_EDITING);
  if (keep) return { kind: 'tap', el: keep, why: 'не удалять черновик' };

  if (st.shareTapped) return decideAfterShare(s);

  if (byLabel(s, LOGGED_OUT) && !editTexts(s).some((e) => CAPTION_FIELD_ID.test(e.resId))) {
    return { kind: 'error', why: 'Аккаунт не авторизован в приложении (экран входа) — выполните вход на плате', retryable: false };
  }
  if (screenHas(s, VIDEO_REJECTED)) {
    return { kind: 'error', why: 'Приложение отклонило видео (длина/формат)', retryable: false };
  }

  if (platform === 'instagram' && !st.targetChosen) {
    // Share sheet "Reels / Feed / Story / Chats" — only when the alternatives are on screen too,
    // so the profile's "Reels" tab is never mistaken for it.
    const reels = byLabel(s, IG_REELS_TARGET);
    if (reels && s.els.some((e) => IG_OTHER_TARGETS.test(e.text.trim()) || IG_OTHER_TARGETS.test(e.desc.trim()))) {
      return { kind: 'tap', el: reels, why: 'выбор «Reels»', marks: 'target' };
    }
  }

  if (platform === 'tiktok' && !st.targetChosen) {
    const feed = byLabel(s, TT_FEED_TARGET);
    if (feed && s.els.some((e) => TT_OTHER_TARGETS.test(e.text.trim()) || TT_OTHER_TARGETS.test(e.desc.trim()))) {
      return { kind: 'tap', el: feed, why: 'выбор публикации в ленту TikTok', marks: 'target' };
    }
  }

  const preConfirm = byLabel(s, POST_CONFIRM);
  if (preConfirm && !editTexts(s).some((e) => CAPTION_FIELD_ID.test(e.resId))) {
    return { kind: 'tap', el: preConfirm, why: `подтверждение «${preConfirm.text || preConfirm.desc}»` };
  }

  // Final screen: caption field + Share/Post button.
  const finalBtn = platform === 'instagram'
    ? byLabel(s, IG_SHARE) ?? byResId(s, IG_SHARE_ID)
    : byLabel(s, TT_POST) ?? byResId(s, TT_POST_ID);
  const field = captionField(s);
  if (finalBtn && field) {
    if (hasCaption && !st.captionDone) return { kind: 'caption', el: field };
    return { kind: 'tap', el: finalBtn, why: platform === 'instagram' ? '«Поделиться»' : '«Опубликовать»', marks: 'share' };
  }

  const next = byLabel(s, NEXT) ?? byResId(s, NEXT_ID);
  if (next && st.nextTaps < 6) return { kind: 'tap', el: next, why: '«Далее»', marks: 'next' };

  // Final button visible but no caption field (keyboard covering it, or none needed).
  if (finalBtn && (!hasCaption || st.captionDone)) {
    return { kind: 'tap', el: finalBtn, why: 'публикация', marks: 'share' };
  }

  const dismiss = byLabel(s, DISMISS);
  if (dismiss) return { kind: 'tap', el: dismiss, why: `закрыть подсказку «${dismiss.text || dismiss.desc}»` };

  return { kind: 'unknown' };
}

/** Minimal profile view for post verification (see profile-stats.snapshotProfile). */
export interface ProfileView {
  posts: number | null;
  tiles: { views: number | null }[]; // non-pinned, newest first
}

/** Views a brand-new post can plausibly have within minutes of upload. */
const FRESH_POST_MAX_VIEWS = 100;

/**
 * Did a new post appear between `before` and `after` (own profile, same account)?
 *   - Instagram: the header post count grew;
 *   - grid not full before (< 9 tiles) and it gained a tile;
 *   - the previous newest tile moved to position 2 (views never drop, so it has at least
 *     as many as before) and the new first tile has STRICTLY fewer views than the old
 *     newest had — without a new post the first tile is that same old post, whose views
 *     cannot have gone down. A first tile with no counter yet (still processing) counts
 *     as fresh. Equal counts (both 0) are ambiguous → false: unverified, never a guess.
 */
export function isNewPostOnProfile(before: ProfileView, after: ProfileView): boolean {
  if (before.posts != null && after.posts != null) return after.posts > before.posts;
  if (before.tiles.length < 9 && after.tiles.length > before.tiles.length) return true;
  const prevNewest = before.tiles[0];
  const shifted = after.tiles[1];
  const fresh = after.tiles[0];
  if (!prevNewest || !shifted || !fresh || prevNewest.views == null || shifted.views == null) return false;
  if (shifted.views < prevNewest.views) return false;
  return fresh.views == null || (fresh.views < prevNewest.views && fresh.views <= FRESH_POST_MAX_VIEWS);
}

function decideAfterShare(s: UiScreen): FlowAction {
  if (screenHas(s, UPLOAD_FAILED)) return { kind: 'error', why: 'Приложение сообщило об ошибке загрузки', retryable: false };
  const confirm = byLabel(s, POST_CONFIRM);
  if (confirm) return { kind: 'tap', el: confirm, why: 'подтверждение публикации' };
  if (screenHas(s, IN_PROGRESS)) return { kind: 'progress', why: 'идёт загрузка' };
  if (screenHas(s, POSTED)) return { kind: 'success', why: 'приложение подтвердило публикацию' };
  const hasBottomNav = s.els.some((e) => isVisible(e) && (TT_HOME_NAV.test(e.text.trim()) || TT_HOME_NAV.test(e.desc.trim())));
  if (hasBottomNav && !editTexts(s).length) {
    return { kind: 'success', why: 'приложение вернулось на главный экран — видео в процессе отправки' };
  }
  const dismiss = byLabel(s, DISMISS);
  if (dismiss) return { kind: 'tap', el: dismiss, why: `закрыть подсказку «${dismiss.text || dismiss.desc}»` };
  return { kind: 'unknown' };
}
