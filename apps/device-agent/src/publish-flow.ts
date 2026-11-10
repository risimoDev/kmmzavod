/**
 * Decision logic of the on-phone publishing flows (Instagram Reels, TikTok).
 *
 * `decide()` looks at ONE screen dump and returns the next action. It is a pure
 * function: the device loop in publish.ts executes the action, dumps again and asks
 * again. Labels are matched in English and Russian; anything unrecognised is reported
 * as `unknown` instead of being tapped blindly.
 */
import { byLabel, byResId, clickTarget, editTexts, isVisible, screenHas, type UiEl, type UiScreen } from './ui-automation';

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
const ALLOW = /^(allow|allow all|разрешить|разрешить все|while using the app|при использовании приложения|только во время использования приложения|всегда разрешать|разрешать только при использовании приложения|разрешить доступ ко всем фото и видео|разрешить доступ|выбрать все фото|разрешить все)$/i;
/** Harmless "close this tip/prompt" buttons. */
const DISMISS = /^(not now|не сейчас|skip|пропустить|got it|понятно|понял|ok|ок|okay|no thanks|нет,?\s*спасибо|later|позже|maybe later|dismiss|отклонить|не разрешать|не переносить|отмена|cancel|close|закрыть|сохранить|понятно, продолжить)$/i;
/** "Discard reel?" dialogs → keep editing, never discard. */
const KEEP_EDITING = /^(keep editing|продолжить редактирование|continue editing)$/i;
const LOGGED_OUT = /^(log in|войти|sign up|зарегистрироваться|create new account|создать новый аккаунт|log into another account)$/i;

const NEXT = /^(next|далее|дальше|продолжить|выбрать|готово|save|сохранить)(\s*\(\d+\))?$/i;
const NEXT_ID = /(^|_)(next|btn_next|next_btn|action_btn|action_bar_button_action|bb_primary_action_container|creation_secondary_cta|right_action_button)(_button|_btn|_textview)?$/i;
const IG_REELS_TARGET = /^(reels?|видео\s*reels|ролик\s*reels|клип\s*reels)$/i;
const IG_OTHER_TARGETS = /^(feed|лента|story|stories|история|истории|post|публикация|chats|чаты|сообщения|direct|сообщение)$/i;
const TT_FEED_TARGET = /^(video|видео|post(\s+to\s+feed)?|лента|опубликовать(\s+в\s+ленту)?|поделиться\s+в\s+(tiktok|ленту)|tiktok\s+video|запись)$/i;
const TT_OTHER_TARGETS = /^(message|сообщение|chats|чаты|друзья|friends|direct|сообщения|messages|история|истории|story|stories)$/i;
const IG_SHARE = /^(share(\s+to\s+reels?)?|поделиться(\s+в\s+reels?)?|опубликовать(\s+в\s+reels?)?)(\s*\(\d+\))?$/i;
const IG_SHARE_ID = /share_button|share_footer_button|bb_primary_action_container|share_reels_button|(^|_)share$/i;
/**
 * The final button's WHOLE label. Never a substring match: the TikTok post screen also has
 * a "Post" title in its header and a "Everyone can view this post" privacy row — tapping
 * either of those leaves the video unposted.
 */
const TT_POST = /^(post|post now|post video|post to feed|post entry|share|share to feed|share to tiktok|share video|share post|опубликовать|опубликовать сейчас|опубликовать видео|опубликовать запись|опубликовать клип|опубликовать в tiktok|опубликовать в ленту|поделиться|поделиться в tiktok|поделиться видео|поделиться записью|поделиться в ленту|отправить|отправить в tiktok|publish)(\s*\(\d+\))?$/i;
const TT_POST_EXCLUDE = /story|draft|черновик|истори/i;
const TT_POST_ID = /publish_btn|publish_button|post_button|post_btn|btn_post|btn_publish|(^|_)publish$/i;
const POST_CONFIRM = /^(post now|опубликовать сейчас|post anyway|всё равно опубликовать|share now|поделиться сейчас|продолжить|continue|всё равно продолжить|подтвердить|confirm)$/i;
const TT_HOME_NAV = /^(home|главная|friends|друзья|explore|интересное|inbox|входящие|profile|профиль|я|me)$/i;

const CAPTION_FIELD_ID = /caption|desc|title|content|input|text_field/i;
const CAPTION_FIELD_HINT = /caption|подпис|describe|description|описан|хэштег|hashtag|расскажите|о чем|добавьте|введите|write a caption|напишите подпись/i;

/** Before sharing: the app refused the video itself — retrying the same file will not help. */
const VIDEO_REJECTED = /(video|видео) (is )?(too (short|long)|слишком (коротк|длинн))|unsupported (video|file|format)|неподдерживаем|can.?t (use|import) this video|не удалось импортировать/i;
const UPLOAD_FAILED = /((couldn.?t|could not|can.?t|unable to) (post|upload|share))|не удалось (опубликовать|загрузить|поделиться|отправить)|upload failed|ошибка (загрузки|публикации)|публикация не удалась/i;
const IN_PROGRESS = /\b(posting|uploading|sharing|processing)\b|публикуется|загружается|идёт загрузка|идет загрузка|отправка|обработка видео|^публикация\.{0,3}$|\b\d{1,3}\s?%/i;
/** The app itself says it has no connection (TikTok: "Network error / Please check your network"). */
const APP_OFFLINE = /network error|check your network|no internet connection|you.?re offline|нет (подключения к интернету|соединения|сети)|ошибка сети|проверьте (подключение|соединение)/i;
const PERCENT = /^(\d{1,3})\s?%$/;
const POSTED = /\b(shared|posted|uploaded)\b|опубликован|видео загружено|^загружено$|публикация завершена/i;

// ── Decision ──────────────────────────────────────────────────────────────────

/**
 * The final Share/Post button: an element whose whole label (or resource-id) says so,
 * in the lower part of the screen, the bottom-most one. Headers ("Post" title) and rows
 * like "Everyone can view this post" are never candidates; "Drafts"/"Story" are excluded.
 */
export function findPostButton(s: UiScreen, platform: FlowPlatform): UiEl | undefined {
  const screenH = Math.max(...s.els.map((e) => e.bounds[3]), 1);
  const screenW = Math.max(...s.els.map((e) => e.bounds[2]), 1);
  const labelRe = platform === 'instagram' ? IG_SHARE : TT_POST;
  const idRe = platform === 'instagram' ? IG_SHARE_ID : TT_POST_ID;

  const candidates = s.els.filter((e) => {
    if (!isVisible(e) || !e.enabled) return false;
    const text = e.text.replace(/[\u00A0\s]+/g, ' ').trim();
    const desc = e.desc.replace(/[\u00A0\s]+/g, ' ').trim();
    if (TT_POST_EXCLUDE.test(`${text} ${desc}`)) return false;
    return labelRe.test(text) || labelRe.test(desc) || idRe.test(e.resId.replace(/^.*:id\//, ''));
  });

  // TikTok keeps Post in a bottom bar; Instagram's Share also sits at the bottom on new
  // versions but in the top bar on old ones → bottom half preferred, top accepted for IG.
  const lower = candidates.filter((e) => e.bounds[1] >= screenH * 0.5);
  const pool = lower.length ? lower : platform === 'instagram' ? candidates : [];
  if (pool.length > 0) {
    return pool.sort((a, b) => b.bounds[1] - a.bounds[1])[0];
  }

  // Structural fallback for TikTok: if Drafts button is visible in the bottom bar (y >= screenH * 0.7),
  // the primary action button to its right is the Post/Share button, even with obfuscated IDs/text.
  if (platform === 'tiktok') {
    const draftsBtn = s.els.find((e) =>
      isVisible(e) && e.enabled && e.bounds[1] >= screenH * 0.7 &&
      (/^(drafts?|черновик(и)?)$/i.test(e.text.trim()) || /^(drafts?|черновик(и)?)$/i.test(e.desc.trim()) || /draft/i.test(e.resId))
    );
    if (draftsBtn) {
      const rightBtns = s.els.filter((e) =>
        isVisible(e) && e.enabled && (e.clickable || /Button|TextView/i.test(e.cls)) &&
        e.bounds[1] >= screenH * 0.7 && e.bounds[0] >= Math.round(screenW * 0.45) &&
        !/draft|черновик/i.test(`${e.text} ${e.desc} ${e.resId}`)
      );
      if (rightBtns.length > 0) {
        return rightBtns.sort((a, b) => (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]) - (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]))[0];
      }
    }
  }

  // Structural fallback for Instagram Reels: primary action button in bottom 25% of screen
  if (platform === 'instagram') {
    const bottomBtn = s.els.find((e) =>
      isVisible(e) && e.enabled && (e.clickable || /Button|TextView/i.test(e.cls)) &&
      e.bounds[1] >= screenH * 0.75 &&
      !/draft|черновик|cancel|отмена|discard/i.test(`${e.text} ${e.desc} ${e.resId}`)
    );
    if (bottomBtn) return bottomBtn;
  }

  return undefined;
}

/** Still on the final compose screen (Share/Post button visible)? */
export function isComposeScreen(platform: FlowPlatform, s: UiScreen): boolean {
  return Boolean(findPostButton(s, platform));
}

function captionField(s: UiScreen): UiEl | undefined {
  const screenH = Math.max(...s.els.map((e) => e.bounds[3]), 1);
  const fields = editTexts(s);

  // 1. Matched by ID or Hint
  const matched = fields.find((e) =>
    CAPTION_FIELD_ID.test(e.resId.replace(/^.*:id\//, '')) ||
    CAPTION_FIELD_HINT.test(`${e.text} ${e.desc}`)
  );
  if (matched) return matched;

  // 2. If exactly one edit field
  if (fields.length === 1) return fields[0];

  // 3. Any edit field in the upper half of screen (y between 5% and 60%)
  const topFields = fields.filter((e) => e.bounds[1] >= screenH * 0.05 && e.bounds[1] <= screenH * 0.6);
  if (topFields.length > 0) {
    // Pick the one with the largest area (main caption box)
    return topFields.sort((a, b) =>
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]) -
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1])
    )[0];
  }

  // 4. Clickable placeholder view with caption hint (some custom TikTok layouts lazy-inflate EditText)
  return s.els.find((e) =>
    isVisible(e) && e.clickable && e.bounds[1] <= screenH * 0.6 &&
    CAPTION_FIELD_HINT.test(`${e.text} ${e.desc}`)
  );
}

export function decide(platform: FlowPlatform, s: UiScreen, st: FlowState, hasCaption: boolean): FlowAction {
  // System runtime-permission dialog (gallery / media access).
  const allow = byResId(s, PERMISSION_ALLOW_ID)
    ?? (/permissioncontroller|packageinstaller/.test(s.pkg) ? byLabel(s, ALLOW) : undefined);
  if (allow) return { kind: 'tap', el: allow, why: 'разрешение доступа к медиа' };

  // System share chooser / resolver (Android / Samsung share sheet)
  if (/resolver|chooser|intentresolver|sharelive/i.test(s.pkg) || s.pkg === 'android') {
    const targetLabel = platform === 'tiktok' ? /(^|\b)tiktok(\s+lite)?(\b|$)/i : /(^|\b)instagram(\b|$)/i;
    const target = s.els.find((e) => isVisible(e) && (targetLabel.test(e.text.trim()) || targetLabel.test(e.desc.trim())));
    if (target) {
      return { kind: 'tap', el: target, why: `выбор приложения ${platform} в системном меню «Поделиться»` };
    }
    const justOnce = byLabel(s, /^(just once|только сейчас|всегда|always|только один раз)$/i);
    if (justOnce) {
      return { kind: 'tap', el: justOnce, why: 'подтверждение выбора в меню «Поделиться»' };
    }
  }

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
    const isShareSheet = s.els.some((e) =>
      isVisible(e) && /(share on tiktok|поделиться в tiktok|отправить в tiktok|bottom sheet)/i.test(`${e.text} ${e.desc}`)
    );
    const feed = s.els.find((e) =>
      isVisible(e) && (e.clickable || /Button|TextView/i.test(e.cls)) &&
      TT_FEED_TARGET.test(e.text.trim() || e.desc.trim())
    );
    if (feed && (isShareSheet || s.els.some((e) => TT_OTHER_TARGETS.test(e.text.trim()) || TT_OTHER_TARGETS.test(e.desc.trim())))) {
      return { kind: 'tap', el: feed, why: 'выбор публикации в ленту TikTok', marks: 'target' };
    }
  }

  // Confirmation / pre-confirm dialogs ("Post anyway?", "Copyright check", etc.)
  const preConfirm = byLabel(s, POST_CONFIRM);
  if (preConfirm && !editTexts(s).some((e) => CAPTION_FIELD_ID.test(e.resId))) {
    return { kind: 'tap', el: preConfirm, why: `подтверждение «${preConfirm.text || preConfirm.desc}»` };
  }

  // ── Final screen: caption field + Share/Post button ──────────────────────────
  const finalBtn = findPostButton(s, platform);
  const field = captionField(s);

  if (finalBtn) {
    if (hasCaption && !st.captionDone && field) {
      return { kind: 'caption', el: field };
    }
    // If caption is done, or no caption needed, or field is not found (keyboard open / no text field):
    // Tap the Post button! Never fall through to unknown!
    return { kind: 'tap', el: finalBtn, why: platform === 'instagram' ? '«Поделиться»' : '«Опубликовать»', marks: 'share' };
  }

  // ── Navigation & Next button ───────────────────────────────────────────────
  const next = byLabel(s, NEXT) ?? byResId(s, NEXT_ID);
  if (next && st.nextTaps < 6) return { kind: 'tap', el: next, why: '«Далее»', marks: 'next' };

  // Editor screen fallback: if "Your Story" / "В историю" is on the left in the bottom bar,
  // the right button is the Next button
  if (platform === 'tiktok' && st.nextTaps < 6) {
    const screenH = Math.max(...s.els.map((e) => e.bounds[3]), 1);
    const screenW = Math.max(...s.els.map((e) => e.bounds[2]), 1);
    const storyBtn = s.els.find((e) =>
      isVisible(e) && e.enabled && e.bounds[1] >= screenH * 0.7 &&
      (/story|истори/i.test(`${e.text} ${e.desc}`) || /quick_publish/i.test(e.resId))
    );
    if (storyBtn) {
      const editorNext = s.els.find((e) =>
        isVisible(e) && e.enabled && (e.clickable || /Button|TextView/i.test(e.cls)) &&
        e.bounds[1] >= screenH * 0.7 && e.bounds[0] >= Math.round(screenW * 0.45) &&
        !/story|истори/i.test(`${e.text} ${e.desc}`)
      );
      if (editorNext) {
        return { kind: 'tap', el: editorNext, why: 'переход далее из редактора TikTok', marks: 'next' };
      }
    }
  }

  // ── TikTok Main Feed / Bottom Nav navigation fallback ─────────────────────
  if (platform === 'tiktok') {
    const isMainFeed = s.els.some((e) =>
      isVisible(e) && /^(for you|following|explore|рекомендации|подписки)$/i.test(e.text.trim() || e.desc.trim())
    );
    const hasBottomNav = s.els.some((e) =>
      isVisible(e) && /^(home|главная|inbox|входящие|friends|друзья|profile|профиль|я|me)$/i.test(e.text.trim() || e.desc.trim())
    );

    if (hasBottomNav || isMainFeed) {
      const screenH = Math.max(...s.els.map((e) => e.bounds[3]), 1);
      const screenW = Math.max(...s.els.map((e) => e.bounds[2]), 1);

      // 1. Center create button by label/ID
      const createBtn = s.els.find((e) =>
        isVisible(e) && (
          /^(create|создать|record|\+)$/i.test(e.desc.trim()) ||
          /^(create|создать|\+)$/i.test(e.text.trim()) ||
          /create_btn|upload_btn|tab_publish|btn_publish|bottom_bar_create|feed_publish_btn/i.test(e.resId)
        )
      );
      if (createBtn) {
        return { kind: 'tap', el: clickTarget(createBtn), why: 'переход к публикации через «+» в TikTok' };
      }

      // 2. Structural: center element in the bottom bar
      const centerBtn = s.els.find((e) =>
        isVisible(e) && (e.clickable || e.parent?.clickable) &&
        e.bounds[1] >= screenH * 0.85 &&
        e.bounds[0] >= screenW * 0.35 && e.bounds[2] <= screenW * 0.65
      );
      if (centerBtn) {
        return { kind: 'tap', el: clickTarget(centerBtn), why: 'нажатие центральной кнопки «+» в нижней панели TikTok' };
      }
    }

    // ── TikTok Camera screen fallback: "Загрузить" / "Галерея" ───────────────
    const uploadBtn = s.els.find((e) =>
      isVisible(e) && (
        /^(upload|загрузить|галерея|gallery)$/i.test(e.text.trim()) ||
        /^(upload|загрузить|галерея|gallery)$/i.test(e.desc.trim()) ||
        /upload_btn|tv_upload|upload_layout|btn_upload/i.test(e.resId)
      )
    );
    if (uploadBtn) {
      return { kind: 'tap', el: clickTarget(uploadBtn), why: 'выбор «Загрузить» из галереи' };
    }

    // ── Media picker / Gallery fallback (TikTok) ─────────────────────────────
    if (!hasBottomNav && !isMainFeed) {
      const screenH = Math.max(...s.els.map((e) => e.bounds[3]), 1);
      const isGalleryPicker = s.els.some((e) =>
        isVisible(e) && e.bounds[1] <= screenH * 0.35 &&
        /^(videos?|видео|all|все|photos?|фото|недавние|recents|галерея|gallery)$/i.test(e.text.trim() || e.desc.trim())
      ) || s.els.some((e) => /media_grid|gallery_grid|album_recycler/i.test(e.resId));

      if (isGalleryPicker) {
        const nextBtn = byLabel(s, NEXT) ?? byResId(s, NEXT_ID);
        const mediaTile = s.els.find((e) =>
          isVisible(e) && (e.clickable || /checkbox|media_item|iv_cover|thumb/i.test(e.resId)) &&
          e.bounds[1] >= screenH * 0.08 && e.bounds[3] <= (nextBtn ? nextBtn.bounds[1] : screenH * 0.9) &&
          !/^(videos?|видео|all|все|photos?|фото|недавние|recents|галерея|gallery)$/i.test(e.text.trim() || e.desc.trim())
        );
        if (mediaTile && (!nextBtn || !nextBtn.enabled)) {
          return { kind: 'tap', el: clickTarget(mediaTile), why: 'выбор добавленного видео в галерее TikTok', marks: 'target' };
        }
        if (nextBtn) {
          return { kind: 'tap', el: clickTarget(nextBtn), why: 'переход к редактированию видео', marks: 'next' };
        }
      }
    }
  }

  // ── Harmless dismissals / Popups ───────────────────────────────────────────
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

/** The app shows its own "no network" message. */
export function isAppOffline(s: UiScreen): boolean {
  return screenHas(s, APP_OFFLINE);
}

/** Upload percentage shown by the app (TikTok's "58%" badge), or null. */
export function uploadPercent(s: UiScreen): number | null {
  for (const e of s.els) {
    const m = PERCENT.exec(e.text.trim()) ?? PERCENT.exec(e.desc.trim());
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 100) return n;
    }
  }
  return null;
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
