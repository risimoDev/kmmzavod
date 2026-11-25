/**
 * Scriptwriter for short product videos (Reels/TikTok/Shorts), Russian.
 *
 * Guarantees the caller can rely on:
 *   • length: written for `seconds × wps` spoken words; out-of-range answers get
 *     one corrective round-trip, then the MIDDLE is trimmed (hook + CTA survive);
 *   • grammar: first-person forms agree with the narrator's voice gender;
 *   • freshness: hooks too similar to `avoidHooks` are re-requested, and each call
 *     suggests different hook archetypes;
 *   • captions: exactly `captionsCount` distinct captions;
 *   • no silent junk: if every provider fails, `LlmUnavailableError` is thrown
 *     unless the caller explicitly allows the generic template.
 */
import { LlmChain, LlmUnavailableError } from './llm';
import {
  countWords, firstSentence, normalizeForCompare, sanitizeForVoiceover, similarity,
  stripEmotionTags, trimMiddle,
} from './text';
import { DEFAULT_WPS, wordsFor } from './pace';
import type { VoiceGender } from './voices';

export type ScriptStyle =
  | 'blogger' | 'story' | 'review' | 'hype' | 'educational' | 'sales' | 'humor' | 'minimal';

export const SCRIPT_STYLES: { id: ScriptStyle; label: string; desc: string }[] = [
  { id: 'blogger', label: 'Блогер / Находка', desc: 'Живой UGC, восторг от находки' },
  { id: 'story', label: 'Боль → Решение', desc: 'Проблема, до/после' },
  { id: 'review', label: 'Тест / Обзор', desc: 'Честная проверка на практике' },
  { id: 'hype', label: 'Вирусный POV', desc: 'Цепкая первая реплика, быстрый темп' },
  { id: 'educational', label: 'Лайфхак', desc: 'Экспертный совет' },
  { id: 'sales', label: 'Рекомендация', desc: 'Выгода и нативный оффер' },
  { id: 'humor', label: 'С юмором', desc: 'Лёгкая ирония' },
  { id: 'minimal', label: 'Коротко', desc: 'Только факты и CTA' },
];

export type CtaType = 'article' | 'direct' | 'auto' | 'none';

export interface ScriptBrief {
  /** What is in the video (product / topic name). */
  product: string;
  productInfo?: string;
  audience?: string;
  style: ScriptStyle;
  seconds: number;
  /** Narrator pace in spoken words per second (calibrated per voice). */
  wps?: number;
  narrator?: VoiceGender;
  cta?: { type: CtaType; word?: string };
  /** Recent hooks of this project/autopilot — must not be repeated. */
  avoidHooks?: string[];
  /** What is said/shown in the source footage (helps ground the script). */
  sourceTranscript?: string;
  captionsCount?: number;
  /** generate = new script; fit = adapt `currentScript` to the length; rewrite =
   *  same meaning, new wording (for variants). */
  mode?: 'generate' | 'fit' | 'rewrite';
  currentScript?: string;
  /** For fit: how long `currentScript` actually sounded (seconds). */
  measuredSeconds?: number;
  /** Allow the generic template when every LLM provider fails (manual use only). */
  allowTemplate?: boolean;
}

export interface ScriptCaption { caption: string; hashtags: string[] }

export interface ScriptResult {
  hook: string;
  title: string;
  script: string;
  captions: ScriptCaption[];
  words: number;
  targetWords: number;
  estSeconds: number;
  provider: string;
  model: string;
  /** Human-readable notes (length correction, template fallback, …). */
  notes: string[];
}

// ── Prompt building blocks ────────────────────────────────────────────────────

const PERSONA: Record<ScriptStyle, string> = {
  blogger: 'Живой блогер делится находкой: разговорно, тепло, с искренним восторгом, как другу.',
  story: 'Начни с короткой узнаваемой ситуации и объясни, что в ней меняет товар.',
  review: 'Дай полезный критерий выбора и объясни, кому подойдёт товар, опираясь на его свойства.',
  hype: 'Откройся неожиданным, но подтверждённым наблюдением. Держи темп короткими фразами.',
  educational: 'Экспертный лайфхак: полезный совет, как правильно пользоваться, чего избегать.',
  sales: 'Нативная рекомендация: выгоды для зрителя на первом месте, без телемагазина.',
  humor: 'Лёгкая ирония и самоирония, шутка на узнаваемой бытовой ситуации, но товар — главный герой.',
  minimal: 'Коротко и по делу: 2–3 сильных факта и призыв, без воды.',
};

const HOOK_ARCHETYPES = [
  'конкретная бытовая ситуация, в которой зритель узнаёт себя',
  'вопрос о выборе товара, на который следующие фразы дадут ответ',
  'практический совет перед покупкой этой категории товара',
  'одна деталь, которая имеет значение в конкретном сценарии использования',
  'неожиданный факт или цифра, если они прямо есть в брифе',
  'узнаваемое неудобство, с которым связано свойство товара',
  'кому или для какой задачи подойдёт этот товар',
];

function genderRule(g: VoiceGender | undefined): string {
  if (g === 'male') return 'Рассказчик — мужчина: глаголы прошедшего времени и прилагательные от первого лица СТРОГО в мужском роде (купил, был уверен, сам проверил).';
  if (g === 'female') return 'Рассказчик — женщина: глаголы прошедшего времени и прилагательные от первого лица СТРОГО в женском роде (купила, была уверена, сама проверила).';
  return 'Пол рассказчика неизвестен: НЕ используй глаголы прошедшего времени и прилагательные от первого лица единственного числа (никаких «купил/купила»). Пиши в настоящем времени, через «смотрите», «это», «у меня есть».';
}

function ctaRule(cta: ScriptBrief['cta']): string {
  const word = (cta?.word || 'ХОЧУ').toUpperCase();
  switch (cta?.type ?? 'article') {
    case 'direct':
      return `Финал: мягко предложи написать в директ кодовое слово «${word}», чтобы получить ссылку. Формулируй каждый раз по-новому.`;
    case 'auto':
      return `Финал: органично предложи артикул в описании/закрепе ИЛИ кодовое слово «${word}» в директ — что естественнее.`;
    case 'none':
      return 'Финал: без призыва к покупке — завершай сильной мыслью или вопросом к зрителю.';
    default:
      return 'Финал: нативно скажи, что артикул/ссылка в описании, закрепе или шапке профиля. Формулируй каждый раз по-новому.';
  }
}

function pickArchetypes(n: number): string[] {
  const pool = [...HOOK_ARCHETYPES];
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

function systemPrompt(b: ScriptBrief, words: number, min: number, max: number, hookWords: number): string {
  return [
    'Ты пишешь разговорную озвучку для короткого ролика о товаре. Типичный видеоряд — человек держит товар или красиво двигается с ним. Весь смысл должен быть понятен на слух. Не ссылайся на кадры, жесты и видимый результат. Не обещай показать тест, распаковку или сравнение в кадре.',
    `ПОДАЧА: ${PERSONA[b.style] ?? PERSONA.blogger}`,
    genderRule(b.narrator),
    b.audience
      ? `АУДИТОРИЯ: ${b.audience}. Обращайся к ней естественно.`
      : 'АУДИТОРИЯ не указана: говори нейтрально, без «девчонки/пацаны» и обращения по полу.',
    `ДЛИНА: ролик ${b.seconds} с. Текст для произнесения — ${min}–${max} слов (цель ${words}); теги эмоций в словах не считаются.`,
    `ХУК: первая произнесённая фраза, до ${hookWords} слов. С первых слов назови категорию товара, знакомую ситуацию или понятную пользу. Начинай сразу, без приветствия и разгона. Исключи «досмотри до конца», «вы не поверите», «нашла кое-что» и пустые обещания. Поле hook — дословная первая фраза из script без тегов.`,
    'ОСНОВНАЯ ЧАСТЬ: уже следующая фраза раскрывает хук. Выбери одну главную мысль и свяжи свойство товара с пользой в конкретной ситуации. Добавь ещё одну деталь только если она помогает выбору. Каждая фраза продвигает мысль. Пиши короткими предложениями, которые легко сказать вслух.',
    ctaRule(b.cta),
    'ФАКТЫ: используй сведения из брифа. При нехватке сведений опиши обычную ситуацию применения или критерий выбора. Не выдумывай свойства, гарантии, цены, скидки, сравнения и личный опыт покупки или теста. Избегай «купите прямо сейчас», «спешите», «уникальное предложение».',
    'Назови товар простым словом по его типу. При чтении вслух текст должен звучать как конкретный совет знакомого человека.',
    'ТЕГИ ЭМОЦИЙ: до 3 тегов перед фразами, когда они помогают интонации. Допустимы [excited] [confident] [whispering] [surprised] [gasp] [curious] [calm] [laughing] [urgent] [sigh]. Для начала предпочтительны естественные [curious] или [confident], если подходят по смыслу.',
    'ТЕКСТ: без эмодзи, ссылок, хэштегов и разметки; числа — словами.',
    'Ответ — строго один JSON-объект: {"hook":"хук без тегов","title":"короткое название ролика","script":"текст для диктора с тегами","captions":[{"caption":"подпись к посту","hashtags":["#…"]}]}',
  ].join('\n');
}

function productContext(b: ScriptBrief): string[] {
  return [
    `Товар/тема: «${b.product}»`,
    b.productInfo ? `Факты о товаре (используй только их, не выдумывай): ${b.productInfo}` : '',
    b.sourceTranscript ? `Дополнительный контекст о товаре или теме: ${b.sourceTranscript.slice(0, 1500)}` : '',
  ].filter(Boolean);
}

function userPrompt(b: ScriptBrief, words: number, captions: number): string {
  const lines = productContext(b);
  if (b.mode === 'fit' && b.currentScript) {
    const cur = countWords(b.currentScript);
    lines.push(
      `Адаптируй этот текст под длину ~${words} слов (сейчас ${cur}${b.measuredSeconds ? `, звучит ${b.measuredSeconds.toFixed(1)} с при цели ${b.seconds} с` : ''}). Сохрани смысл, хук и призыв, теги можно поправить:`,
      b.currentScript,
    );
  } else if (b.mode === 'rewrite' && b.currentScript) {
    lines.push('Перепиши заново ДРУГИМИ словами, с другим хуком, сохранив факты и призыв:', b.currentScript);
  } else {
    lines.push(`Для хука используй один из приёмов: ${pickArchetypes(2).join(' ИЛИ ')}.`);
  }
  if (b.avoidHooks?.length) {
    lines.push(`НЕ повторяй и не перефразируй близко эти уже использованные хуки:\n- ${b.avoidHooks.slice(0, 12).join('\n- ')}`);
  }
  lines.push(`Подписей к посту (captions): ровно ${captions}, все разные по формулировке и хэштегам (3–6 хэштегов). Если в фактах о товаре указан артикул (WB/Ozon) или код — обязательно укажи его в каждой подписи к посту (например «Артикул: …»).`);
  return lines.filter(Boolean).join('\n');
}

// ── Scriptwriter ──────────────────────────────────────────────────────────────

interface RawScript { hook?: string; title?: string; script?: string; captions?: { caption?: string; hashtags?: unknown }[] }

export async function writeScript(llm: LlmChain, brief: ScriptBrief): Promise<ScriptResult> {
  const seconds = Math.max(5, Math.min(180, brief.seconds));
  const b: ScriptBrief = { ...brief, seconds, style: brief.style ?? 'blogger' };
  const wps = b.wps && b.wps > 0 ? b.wps : DEFAULT_WPS;
  const target = wordsFor(seconds, wps);
  const min = Math.round(target * 0.9);
  const max = Math.round(target * 1.08);
  const captionsCount = Math.max(1, Math.min(30, b.captionsCount ?? 1));
  const hookWords = Math.min(8, Math.max(3, Math.floor(wps * Math.min(2.7, seconds * 0.4))));
  const instructions = systemPrompt(b, target, min, max, hookWords);
  const notes: string[] = [];

  if (!llm.configured) {
    if (b.allowTemplate) return templateScript(b, { target, wps, notes: ['AI-провайдер не настроен — использован шаблон'] });
    throw new LlmUnavailableError([]);
  }

  let res;
  try {
    res = await llm.chatJson<RawScript>(instructions, userPrompt(b, target, captionsCount), {
      temperature: b.mode === 'fit' ? 0.5 : 0.9, maxTokens: 1800,
    });
  } catch (e) {
    if (b.allowTemplate) return templateScript(b, { target, wps, notes: [`AI недоступен (${(e as Error).message.slice(0, 120)}) — использован шаблон`] });
    throw e;
  }
  let raw = res.data;
  let script = sanitizeForVoiceover(String(raw.script ?? ''));
  if (!script) throw new Error('Модель вернула пустой сценарий');

  // Repeat guard: a hook too close to a recent one gets one re-roll.
  const hook0 = firstSentence(script);
  const repeats = (hook: string) => b.avoidHooks?.some((h) => similarity(h, hook) > 0.55) ?? false;
  const hookIssue = (hook: string): string | undefined => {
    if (repeats(hook)) return 'слишком похож на прошлые';
    if (countWords(hook) > hookWords) return `длиннее ${hookWords} слов`;
    if (/^(?:привет|всем привет|досмотри(?:те)? до конца|вы не поверите|наш[её]л кое-что|нашла кое-что)(?=$|[^\p{L}])/iu.test(hook)) {
      return 'начинается с шаблонной фразы';
    }
  };
  const issue = b.mode === 'fit' ? undefined : hookIssue(hook0);
  if (issue) {
    try {
      const again = await llm.chatJson<RawScript>(instructions,
        `${userPrompt(b, target, captionsCount)}\nПервая фраза «${hook0}» ${issue}. Начни сценарий с другой короткой реплики, которая передаёт конкретику на слух.`,
        { temperature: 1.0, maxTokens: 1800 });
      const s2 = sanitizeForVoiceover(String(again.data.script ?? ''));
      if (s2 && !hookIssue(firstSentence(s2))) {
        raw = again.data;
        script = s2;
        res = again;
        notes.push(`Хук перегенерирован: ${issue}`);
      }
    } catch { /* keep the first answer */ }
  }

  // Length guard: one corrective round-trip, then a structural trim.
  let words = countWords(script);
  if (words < min || words > max) {
    try {
      const fix = await llm.chatJson<RawScript>(instructions,
        `В тексте ${words} слов, нужно ${min}–${max} (цель ${target}). ${words > max ? 'Сократи' : 'Дополни при наличии фактов'} только середину. Первую фразу и призыв сохрани.\n${productContext(b).join('\n')}\nТекущий текст:\n${script}`,
        { temperature: 0.4, maxTokens: 1800 });
      const s2 = sanitizeForVoiceover(String(fix.data.script ?? ''));
      if (s2 && normalizeForCompare(firstSentence(s2)) === normalizeForCompare(firstSentence(script))
        && Math.abs(countWords(s2) - target) < Math.abs(words - target)) {
        script = s2;
        notes.push(`Длина скорректирована: ${words} → ${countWords(s2)} слов`);
        words = countWords(s2);
      }
    } catch { /* keep */ }
  }
  if (words > max) {
    script = trimMiddle(script, max);
    notes.push(`Текст сокращён до ${countWords(script)} слов (хук и призыв сохранены)`);
    words = countWords(script);
  } else if (words < min) {
    notes.push(`Текст короче цели (${words} из ~${target} слов) — видео подстроится под голос`);
  }

  const hook = firstSentence(script);
  const captions = await ensureCaptions(llm, b, normalizeCaptions(raw.captions), captionsCount, hook);
  return {
    hook,
    title: String(raw.title ?? b.product).slice(0, 120),
    script,
    captions,
    words,
    targetWords: target,
    estSeconds: Math.round((words / wps) * 10) / 10,
    provider: res.provider,
    model: res.model,
    notes,
  };
}

function normalizeCaptions(list: RawScript['captions']): ScriptCaption[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ScriptCaption[] = [];
  for (const c of list) {
    const caption = stripEmotionTags(String(c?.caption ?? '')).trim();
    if (!caption) continue;
    const key = normalizeForCompare(caption);
    if (seen.has(key)) continue;
    seen.add(key);
    const hashtags = (Array.isArray(c?.hashtags) ? c.hashtags : [])
      .map((h) => String(h).trim().replace(/\s+/g, ''))
      .filter(Boolean)
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
      .slice(0, 8);
    out.push({ caption, hashtags });
  }
  return out;
}

/** Top up to exactly `n` distinct captions (one extra LLM call, then local variants). */
async function ensureCaptions(llm: LlmChain, b: ScriptBrief, have: ScriptCaption[], n: number, hook: string): Promise<ScriptCaption[]> {
  let caps = have.slice(0, n);
  if (caps.length < n) {
    try {
      const more = await llm.chatJson<{ captions?: RawScript['captions'] }>(
        'Ты пишешь подписи к постам Reels/TikTok о товарах. Ответ — JSON {"captions":[{"caption":"…","hashtags":["#…"]}]}.',
        `Товар: «${b.product}». ${b.productInfo ?? ''}\nНужно ещё ${n - caps.length} подписей, не похожих на эти:\n${caps.map((c) => `- ${c.caption}`).join('\n') || '-'}\nКаждая — 1–3 предложения, свой призыв, 3–6 хэштегов.`,
        { temperature: 1.0, maxTokens: 1500 },
      );
      // Drop only true repeats (same text, or near-identical long captions).
      const extra = normalizeCaptions(more.data.captions).filter((c) => !caps.some((x) =>
        normalizeForCompare(x.caption) === normalizeForCompare(c.caption)
        || (countWords(c.caption) >= 6 && similarity(x.caption, c.caption) > 0.85)));
      caps = [...caps, ...extra].slice(0, n);
    } catch { /* fall through to local variants */ }
  }
  // Snapshot: padding must vary the ORIGINAL captions, not already-padded ones.
  const base = caps.length ? [...caps] : [{ caption: hook || b.product, hashtags: ['#обзор', '#находка'] }];
  const openers = ['', 'Сохраняй, чтобы не потерять 👇', 'Кто уже пробовал?', 'Честно о главном:', 'Мой вывод:'];
  let i = 0;
  while (caps.length < n) {
    const src = base[i % base.length];
    const opener = openers[(i + 1) % openers.length];
    const tags = [...src.hashtags].sort(() => Math.random() - 0.5);
    caps.push({ caption: opener ? `${opener} ${src.caption}` : src.caption, hashtags: tags });
    i++;
  }
  return caps;
}

// ── Generic template (explicit opt-in only) ───────────────────────────────────

/**
 * Product-agnostic emergency script built only from the brief's own facts.
 * Never invents product specifics (the old fallback talked about hair curls for
 * any product); first person avoided when the narrator gender is unknown.
 */
export function templateScript(b: ScriptBrief, ctx: { target: number; wps: number; notes: string[] }): ScriptResult {
  const name = b.product.trim() || 'эта вещь';
  const facts = (b.productInfo ?? '')
    .split(/[.;\n]|,\s(?=[А-ЯA-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .slice(0, 4);
  const word = (b.cta?.word || 'ХОЧУ').toUpperCase();
  const tried = b.narrator === 'female' ? 'проверила' : b.narrator === 'male' ? 'проверил' : null;

  const hook = tried ? `[surprised] Я ${tried} ${name} — и вот что скажу.` : `[surprised] Смотрите: ${name} — и вот почему это стоит внимания.`;
  const body = facts.length
    ? facts.map((f, i) => `${i === 0 ? '[confident] ' : ''}${f.charAt(0).toUpperCase()}${f.slice(1)}.`).join(' ')
    : `[confident] Это одна из тех вещей, которые реально упрощают каждый день.`;
  const cta =
    b.cta?.type === 'direct' ? `[whispering] Напишите ${word} в директ — пришлю ссылку.`
      : b.cta?.type === 'none' ? `[calm] Как вам такая находка? Напишите в комментариях.`
        : `[whispering] Артикул оставил${b.narrator === 'female' ? 'а' : b.narrator === 'male' ? '' : 'и'} в описании профиля.`;
  const script = sanitizeForVoiceover(`${hook} ${body} ${cta}`);
  const words = countWords(script);
  return {
    hook: stripEmotionTags(hook),
    title: name.slice(0, 120),
    script,
    captions: Array.from({ length: Math.max(1, b.captionsCount ?? 1) }, (_, i) => ({
      caption: i === 0 ? `${name}: ${facts[0] ?? 'находка, которая экономит время'}` : `${name} — ${facts[i % Math.max(1, facts.length)] ?? 'честный обзор'} (${i + 1})`,
      hashtags: ['#обзор', '#находка', '#полезное'],
    })),
    words,
    targetWords: ctx.target,
    estSeconds: Math.round((words / ctx.wps) * 10) / 10,
    provider: 'template',
    model: 'template',
    notes: ctx.notes,
  };
}

// ── Captions only (uniquify preserve mode: the video keeps its own voice) ────

export interface CaptionBrief {
  product: string;
  productInfo?: string;
  audience?: string;
  cta?: { type: CtaType; word?: string };
  /** What is said in the video — captions should match it. */
  transcript?: string;
  count: number;
}

/**
 * Exactly `count` distinct post captions (one per unique copy). Each copy on the
 * farm gets its own wording + hashtag set, so posts never look duplicated.
 * Throws LlmUnavailableError when no provider works — callers decide the fallback.
 */
export async function writeCaptions(llm: LlmChain, b: CaptionBrief): Promise<{ captions: ScriptCaption[]; provider: string; model: string }> {
  const n = Math.max(1, Math.min(50, b.count));
  if (!llm.configured) throw new LlmUnavailableError([]);
  const res = await llm.chatJson<{ captions?: RawScript['captions'] }>(
    [
      'Ты пишешь подписи к постам Reels/TikTok/Shorts о товарах. Каждая подпись — 1–3 живых предложения + 3–6 хэштегов.',
      'Все подписи РАЗНЫЕ: другой заход, другие слова, другой набор хэштегов. Без эмодзи-спама, без «купите прямо сейчас», без выдуманных цен.',
      ctaRule(b.cta),
      'Ответ — строго JSON {"captions":[{"caption":"…","hashtags":["#…"]}]}',
    ].join('\n'),
    [
      `Товар/тема: «${b.product}»`,
      b.productInfo ? `Факты: ${b.productInfo}` : '',
      b.audience ? `Аудитория: ${b.audience}` : '',
      b.transcript ? `Что говорится в видео: ${b.transcript.slice(0, 1200)}` : '',
      `Нужно ровно ${n} подписей.`,
    ].filter(Boolean).join('\n'),
    { temperature: 1.0, maxTokens: Math.min(4000, 200 + n * 120) },
  );
  const brief: ScriptBrief = { product: b.product, productInfo: b.productInfo, style: 'blogger', seconds: 30, cta: b.cta };
  const first = normalizeCaptions(res.data.captions);
  const captions = await ensureCaptions(llm, brief, first, n, first[0]?.caption ?? b.product);
  return { captions, provider: res.provider, model: res.model };
}

/** Last-resort local captions (no LLM): varied openers × the product facts. */
export function fallbackCaptions(b: CaptionBrief): ScriptCaption[] {
  const facts = (b.productInfo ?? '').split(/[.;\n]/).map((s) => s.trim()).filter((s) => s.length > 3);
  const openers = ['Смотрите до конца', 'Честно о главном', 'Находка, которую стоит сохранить', 'Как вам такое?', 'Коротко о пользе', 'Не проходите мимо'];
  const tagsPool = ['#обзор', '#находка', '#полезное', '#тренды', '#рекомендации', '#лайфхак', '#shorts', '#reels'];
  return Array.from({ length: Math.max(1, b.count) }, (_, i) => {
    const fact = facts.length ? facts[i % facts.length] : b.product;
    const tags = tagsPool.slice(i % 4, (i % 4) + 4);
    return { caption: `${openers[i % openers.length]}: ${b.product}. ${fact !== b.product ? fact + '.' : ''}`.trim(), hashtags: tags };
  });
}
