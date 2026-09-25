/**
 * OpenRouter AI Service for apps/api.
 * Features:
 *  - Native E-commerce & Product Review Architecture (goods/commodities on WB, Ozon, TikTok Shop)
 *  - Automatic product category and audience deduction from project title and details
 *  - Conversational, natural product naming (synonyms like "эта плойка", "стайлер", "эта малышка", "находка")
 *  - Multiple personas: Live Blogger/UGC, Pain -> Solution (Before/After), Honest Crash-Test, Viral POV
 *  - Diverse native CTAs: Dynamic marketplace articles in description/comments OR secret keyword to DM
 *  - Dedicated Text Expansion & Fit engine (when script is too short for video duration)
 *  - Automatic cascade fallback across free models (:free)
 *  - Natural Fish Audio emotion tags ([excited], [confident], [whispering], [surprised], [gasp], [calm])
 *  - Offline / mock intelligent heuristic generator
 */

import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';

const BASE_URL = (config.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const API_KEY = config.OPENROUTER_API_KEY || '';

export const OPENROUTER_FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-small-24b-instruct-2501:free',
  'deepseek/deepseek-r1:free',
];

export interface ScriptGenerationResult {
  hook: string;
  script: string;
  title: string;
  captions: Array<{ caption: string; hashtags: string[] }>;
  modelUsed: string;
}

export type ScriptStyle =
  | 'blogger'     // Живой блогер / Находка
  | 'story'       // Боль → Решение (До/После)
  | 'review'      // Честный краш-тест / Обзор
  | 'hype'        // Вирусный POV / Шок
  | 'educational' // Экспертный лайфхак
  | 'sales'       // Нативная рекомендация
  | 'humor'       // С юмором
  | 'minimal';

export interface GenerateScriptOptions {
  topic?: string;
  projectName?: string;
  productInfo?: string;
  style?: ScriptStyle;
  targetSeconds?: number;
  sourceTranscript?: string;
  currentScript?: string;
  mode?: 'generate' | 'expand' | 'fit';
  ctaType?: 'article' | 'direct' | 'auto';
  directWord?: string;
  language?: string;
  variantCount?: number;
  apiKey?: string;
}

function extractJson(raw: string): any {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

export function stripEmotionTags(text: string): string {
  return text.replace(/\[[a-zA-Z_\s-]+\]/g, '').replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  const clean = stripEmotionTags(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  return clean ? clean.split(/\s+/).filter(Boolean).length : 0;
}

export function sanitizeForVoiceover(text: string): string {
  return text
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/[*#_~`\(\)\{\}<>]/g, ' ')
    .replace(/[«»"']/g, '')
    .replace(/\[\s*([a-zA-Z_\s-]+?)\s*\]/g, '[$1]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function enrichScriptToWordCount(
  script: string,
  deficit: number,
  projectName?: string,
  productInfo?: string,
  ctaType: 'article' | 'direct' | 'auto' = 'article',
  directWord: string = 'ХОЧУ',
): string {
  if (deficit <= 0) return script;
  const name = (projectName || 'этот товар').trim();
  const infoSnippet = productInfo ? `Кстати, ${productInfo.slice(0, 90).trim()}. ` : '';

  const ctaPhrase =
    ctaType === 'direct'
      ? `[whispering] Напиши слово ${directWord.toUpperCase()} мне в директ — сразу пришлю прямую ссылку, где заказывала!`
      : `[whispering] Артикул на эту прелесть я уже закрепила в описании профиля, сохраняйте, пока не раскупили!`;

  const modules = [
    `[confident] Самое приятное, что эта штука реально избавляет от лишней возни и экономит кучу времени.`,
    `[whispering] ${infoSnippet}Качество оказалось в разы лучше, чем я ожидала за эти деньги.`,
    `[excited] Попробуйте сами — разницу заметите буквально с первого применения.`,
    `[confident] Обязательно сохраняйте видео, чтобы не потерять классную находку.`,
    ctaPhrase,
  ];

  let current = script.trim();
  for (const mod of modules) {
    if (countWords(current) >= countWords(script) + deficit) break;
    current += ` ${mod}`;
  }

  while (countWords(current) < countWords(script) + deficit) {
    if (ctaType === 'direct') {
      current += ` [confident] Напиши ${directWord.toUpperCase()} в директ, пришлю все подробности!`;
    } else {
      current += ` [confident] Все подробности и артикул оставила в описании, пользуйтесь!`;
    }
  }

  return current;
}

export function truncateScriptToWordCount(script: string, maxWords: number): string {
  const words = script.split(/\s+/);
  if (words.length <= maxWords) return script;
  let res = words.slice(0, maxWords).join(' ');
  if (!/[.!?]$/.test(res)) {
    res += '!';
  }
  return res;
}

function generateMockFitScript(opts: {
  currentScript: string;
  topic?: string;
  projectName?: string;
  productInfo?: string;
  targetSeconds?: number;
  ctaType?: 'article' | 'direct' | 'auto';
  directWord?: string;
}): ScriptGenerationResult {
  const name = (opts.projectName || opts.topic || 'товар').trim();
  const info = (opts.productInfo || '').trim();
  const sec = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
  const targetWords = Math.round(sec * 2.05);
  const cta = opts.ctaType || 'article';
  const word = opts.directWord || 'ХОЧУ';

  let baseScript = opts.currentScript.trim();
  let currentCount = countWords(baseScript);

  if (currentCount < targetWords) {
    const deficit = targetWords - currentCount;
    baseScript = enrichScriptToWordCount(baseScript, deficit, name, info, cta, word);
  } else if (currentCount > Math.round(sec * 2.25)) {
    baseScript = truncateScriptToWordCount(baseScript, Math.round(sec * 2.15));
  }

  const scriptClean = sanitizeForVoiceover(baseScript);
  const hookMatch = scriptClean.match(/^([^.!?]+[.!?])/);
  const hook = hookMatch ? stripEmotionTags(hookMatch[1]) : name;

  return {
    hook,
    script: scriptClean,
    title: name.slice(0, 60),
    captions: [
      {
        caption: `${hook}\n\n${stripEmotionTags(scriptClean).slice(0, 160)}...`,
        hashtags: ['#находка', '#распаковка', '#вайлдберриз', '#озон', '#тренды'],
      },
    ],
    modelUsed: 'mock-fit-fallback',
  };
}

function generateMockScript(opts: {
  topic: string;
  projectName?: string;
  productInfo?: string;
  style?: ScriptStyle;
  targetSeconds?: number;
  ctaType?: 'article' | 'direct' | 'auto';
  directWord?: string;
}): ScriptGenerationResult {
  const rawName = (opts.projectName || opts.topic || 'плойка для волос').trim();
  const info = (opts.productInfo || '').trim();
  const sec = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
  const targetWords = Math.round(sec * 2.05);
  const ctaType = opts.ctaType || 'article';
  const directWord = (opts.directWord || 'ХОЧУ').trim();

  // Natural short name deduction for mock
  let shortName = 'эта штука';
  if (/плойк|стайлер|завивк|щипц/i.test(rawName)) shortName = 'эта плойка';
  else if (/пылесос/i.test(rawName)) shortName = 'этот пылесос';
  else if (/наушник/i.test(rawName)) shortName = 'эти наушники';
  else if (/органайзер/i.test(rawName)) shortName = 'этот органайзер';
  else if (/отпаривател/i.test(rawName)) shortName = 'этот отпариватель';

  let cta = `[whispering] Артикул на эту прелесть оставила в описании профиля, сохраняйте!`;
  if (ctaType === 'direct') {
    cta = `[whispering] Напиши слово ${directWord.toUpperCase()} мне в директ, и я сразу пришлю прямую ссылку!`;
  }

  let hook = `[surprised] Девчонки, я просто в шоке от того, как работает ${shortName}!`;
  let body = `[excited] Заказала на пробу чисто из любопытства, но это реально лучшая находка за последнее время. [confident] Локоны крутятся буквально за пять секунд, волосы не пережигаются и держатся до самого вечера. [whispering] Больше никаких сорока минут перед зеркалом — всё делается легко и на полном расслаблении.`;

  if (opts.style === 'review') {
    hook = `[curious] Проверяем самый вирусный девайс из соцсетей: реально ли ${shortName} стоит своих денег?`;
    body = `[confident] Протестировала на себе вдоль и поперек. [excited] Нагревается моментально, покрытие качественное, а главное — пряди не путаются и укладка получается как из салона. [whispering] Честно, я ожидала подвоха, но тут всё сделано на совесть.`;
    cta = ctaType === 'direct'
      ? `[whispering] Кому интересно протестировать — пиши ${directWord.toUpperCase()} в директ, скину ссылку на проверенного продавца!`
      : `[confident] Артикул на проверенный магазин закрепила в комментариях, пользуйтесь!`;
  } else if (opts.style === 'story') {
    hook = `[gasp] Если вас тоже бесит тратить кучу времени на сборы — смотрите сюда!`;
    body = `[confident] Раньше у меня уходило полтора часа, чтобы привести себя в порядок. [whispering] Пока я случайно не наткнулась на эту находку. [excited] Теперь на всю красоту уходит ровно пять минут, а результат держится идеально. [confident] Просто спасение на каждый день.`;
    cta = ctaType === 'direct'
      ? `[whispering] Напиши ${directWord.toUpperCase()} в директ — поделюсь ссылкой и лайфхаком по настройке!`
      : `[whispering] Сохраняйте, чтобы не потерять, а артикул уже ждет вас в описании профиля!`;
  } else if (opts.style === 'hype') {
    hook = `[gasp] Честно, я ни за что бы не поверила, пока сама не увидела этот эффект!`;
    body = `[excited] Смотрите, как ${shortName} справляется всего за одно движение! [surprised] Никаких сложных настроек, просто берешь и делаешь салонный результат дома. [whispering] Удивительно, как такая компактная вещица заменяет кучу дорогих приборов.`;
  }

  if (info) {
    body += ` [confident] Кстати, ${info.slice(0, 90)}.`;
  }

  let fullScript = `${hook} ${body} ${cta}`;
  const curWords = countWords(fullScript);
  if (curWords < targetWords) {
    fullScript = enrichScriptToWordCount(fullScript, targetWords - curWords, rawName, info, ctaType, directWord);
  }

  fullScript = sanitizeForVoiceover(fullScript);

  return {
    hook: stripEmotionTags(hook),
    script: fullScript,
    title: rawName.slice(0, 60),
    captions: [
      {
        caption: `${stripEmotionTags(hook)}\n\n${stripEmotionTags(body)}`,
        hashtags: ['#находка', '#распаковка', '#вайлдберриз', '#озон', '#shorts', '#reels'],
      },
      {
        caption: `Находка года: ${rawName}! Артикул и тест в видео.`,
        hashtags: ['#вайлдберриз', '#озон', '#обзор', '#лайфхак', '#тренды'],
      },
    ],
    modelUsed: 'mock-heuristic-fallback',
  };
}

export class OpenRouterService {
  async generateScript(opts: GenerateScriptOptions): Promise<ScriptGenerationResult> {
    const effectiveKey = (opts.apiKey || API_KEY || '').trim();
    const isMock = !effectiveKey || effectiveKey.startsWith('mock_');
    const style = opts.style || 'blogger';
    const seconds = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
    const minWords = Math.max(15, Math.round(seconds * 1.95));
    const maxWords = Math.round(seconds * 2.20);
    const targetWords = Math.round(seconds * 2.05);
    const variantCount = Math.max(1, Math.min(10, opts.variantCount ?? 3));

    const effectiveProjectName = (opts.projectName || opts.topic || 'Товар').trim();
    const effectiveTopic = (opts.topic || effectiveProjectName).trim();
    const effectiveProductInfo = (opts.productInfo || '').trim();
    const ctaType = opts.ctaType || 'article';
    const directWord = (opts.directWord || 'ХОЧУ').trim();

    const isFitMode = (opts.mode === 'fit' || opts.mode === 'expand') && Boolean(opts.currentScript?.trim());

    if (isMock) {
      logger.info(
        { projectName: effectiveProjectName, topic: effectiveTopic, style, seconds, targetWords, isFitMode, ctaType },
        'OpenRouter (api): Key not set or mock mode, using native product heuristic generator with Fish Audio emotion tags',
      );
      if (isFitMode) {
        return generateMockFitScript({
          currentScript: opts.currentScript!,
          topic: effectiveTopic,
          projectName: effectiveProjectName,
          productInfo: effectiveProductInfo,
          targetSeconds: seconds,
          ctaType,
          directWord,
        });
      }
      return generateMockScript({
        topic: effectiveTopic,
        projectName: effectiveProjectName,
        productInfo: effectiveProductInfo,
        style,
        targetSeconds: seconds,
        ctaType,
        directWord,
      });
    }

    // Dynamic CTA specification
    let ctaInstructions: string;
    if (ctaType === 'direct') {
      ctaInstructions = `ФИНАЛЬНЫЙ ПРИЗЫВ (СТРОГО В ДИРЕКТ):
- В самом конце ролика призови написать в директ/личку кодовое слово "${directWord.toUpperCase()}".
- Пример: "[whispering] Напиши слово ${directWord.toUpperCase()} мне в директ, и я сразу пришлю прямую ссылку, где заказывала со скидкой!" или "[confident] Пиши ${directWord.toUpperCase()} в директ — скину ссылочку на проверенного продавца!"`;
    } else if (ctaType === 'article') {
      ctaInstructions = `ФИНАЛЬНЫЙ ПРИЗЫВ (СТРОГО АРТИКУЛ НА МАРКЕТПЛЕЙСЕ):
- В самом конце ролика нативно предложи артикул (на WB / Ozon), каждый раз формулируя по-разному, живо и без рекламы в лоб:
  * "[whispering] Артикул на эту прелесть уже оставила в описании, сохраняйте, пока не раскупили!"
  * "[confident] Артикул закрепила в комментариях под этим роликом — пользуйтесь на здоровье!"
  * "[whispering] Сохраняйте лайфхак себе, а артикул на товар ждет вас в шапке профиля!"
  * "[confident] Кому нужен артикул на эту находку — ищите прямо в описании!"`;
    } else {
      ctaInstructions = `ФИНАЛЬНЫЙ ПРИЗЫВ:
- Нативно предложи артикул в описании/комментариях или кодовое слово в директ ("${directWord.toUpperCase()}"), выбери самый органичный вариант под контекст.`;
    }

    // Persona & Style specification
    let personaGuidance: string;
    if (style === 'blogger' || style === 'sales') {
      personaGuidance = `ПЕРСОНАЖ: Искренний живой блогер / покупатель («Находка с маркетплейса / Распаковка»).
- Тон: Разговорный, теплый, эмоциональный, как будто делишься крутой находкой с лучшей подругой или другом.
- Лексика: «девчонки/ребята», «урвала на пробу», «эта малышка», «находка года», «я просто в шоке», «спасение на каждый день».`;
    } else if (style === 'story') {
      personaGuidance = `ПЕРСОНАЖ: Боль → Решение / Контраст «До и После».
- Тон: Жизненный сторителлинг. Начни с наболевшей проблемы («Раньше я тратила сорок минут на укладку/уборку...», «Если вас тоже бесит, когда...»).
- Развитие: Как случайно открыла для себя этот товар и как он решил проблему за считанные минуты.`;
    } else if (style === 'review' || style === 'educational') {
      personaGuidance = `ПЕРСОНАЖ: Честный краш-тест / Экспертный обзор вирусного товара.
- Тон: Проверка на практике («Решила проверить самый вирусный девайс из Тиктока: реально ли он так хорош?»).
- Подача: Честный разбор фактов, удобства, фишек, проверка заявленных свойств. Звучит авторитетно и независимо.`;
    } else {
      personaGuidance = `ПЕРСОНАЖ: Вирусный POV / Шок-эффект.
- Тон: Высокий драйв, разрыв шаблона в первые 3 секунды («Ни за что бы не поверила, пока сама не попробовала!»).
- Подача: Фокус на визуальном вау-эффекте от работы товара.`;
    }

    let systemPrompt: string;
    let userPrompt: string;

    if (isFitMode) {
      const currentWordCount = countWords(opts.currentScript || '');
      systemPrompt = `Ты — топовый сценарист вирусных роликов для соцсетей (Reels, TikTok, Shorts), специализирующийся на товарном маркетинге (Wildberries, Ozon, TikTok Shop).
Твоя задача — ДОРАБОТАТЬ, УЛУЧШИТЬ И АДАПТИРОВАТЬ текст автора под видеохронометраж, сделав озвучку МАКСИМАЛЬНО НАТИВНЫМ обзором товара (БЕЗ рекламы "в лоб").

ТОВАР В КАДРЕ:
- Название/исходные данные: "${effectiveProjectName}"
${effectiveProductInfo ? `- Особенности, польза и детали: "${effectiveProductInfo}"` : ''}

ОПРЕДЕЛЕНИЕ ТОВАРА И НАИМЕНОВАНИЕ:
1. По названию "${effectiveProjectName}" САМ определи, что это за конкретный товар (например, плойка/стайлер, отпариватель, автопылесос, увлажнитель, органайзер и т.д.).
2. НЕ НАЗЫВАЙ товар формальным длинным названием! Называй его естественно и разнообразно в разговорной речи: "эта плойка", "стайлер", "эта малышка", "девайс", "находка", "эта штука", "прибор".

КРИТИЧЕСКИ ВАЖНО — ТОЧНОСТЬ ХРОНОМЕТРАЖА:
- Длительность видео: ровно ${seconds} секунд.
- Озвучка ДОЛЖНА длиться ровно ${seconds} секунд!
- Исходный черновик содержит всего ${currentWordCount} слов.
- Итоговый объем произносимых слов (без тегов в скобках) ДОЛЖЕН составлять СТРОГО от ${minWords} до ${maxWords} слов (целевой объем: ровно ${targetWords} слов).
- Если слов меньше ${minWords}, в конце видео будет неловкая пауза и тишина!

${personaGuidance}

${ctaInstructions}

ПРАВИЛА ОЗВУЧКИ:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ телевизионные клише "в лоб": "купите прямо сейчас", "уникальная цена", "скидка пятьдесят процентов", "спешите приобрести". Зритель должен слышать живой искренний обзор, а не рекламу из телемагазина!
2. СОХРАНИ ГОЛОС И СУТЬ: Сохрани ключевой посыл автора из исходного текста, но раскрой сочные детали использования товара, скорость работы и результат.
3. ТЕГИ ЭМОЦИЙ FISH AUDIO (обязательно 3–6 тегов перед ключевыми фразами):
   - [surprised] — удивление, шок
   - [gasp] — резкий вдох от неожиданности
   - [whispering] — секрет, интрига, доверительная рекомендация
   - [confident] — экспертная польза, факт
   - [excited] — восторг от вау-эффекта
   - [calm] — спокойная дружеская реплика
4. ЧИСТЫЙ ТЕКСТ ДЛЯ ДИКТОРСКОЙ ОЗВУЧКИ:
   - Никаких смайликов/эмодзи, решеток, звездочек и ссылок!
   - Все числа обязательно пиши СЛОВАМИ (например, "пять минут", "двести градусов", "три насадки").

Ответ верни СТРОГО в формате JSON:
{
  "hook": "первая цепляющая фраза-крючок (до 8 слов, без тегов)",
  "title": "название товара или ролика",
  "script": "нативно адаптированный текст для диктора с тегами эмоций в скобках",
  "captions": [
    {
      "caption": "текст поста для соцсетей с артикулом/призывом",
      "hashtags": ["#вайлдберриз", "#озон", "#находка", "#reels", "#shorts"]
    }
  ]
}`;

      userPrompt = [
        `Черновик текста для адаптации и добора слов: "${opts.currentScript}"`,
        `Товар: "${effectiveProjectName}"`,
        effectiveProductInfo ? `Польза / фишки: "${effectiveProductInfo}"` : '',
        `СТРОГО СОБЛЮДАЙ ХРОНОМЕТРАЖ: ровно ${seconds} секунд видео (от ${minWords} до ${maxWords} слов текста, цель: ~${targetWords} слов).`,
        `Цель: нативный обзор реального товара. Никаких продаж в лоб.`,
      ].filter(Boolean).join('\n');
    } else {
      systemPrompt = `Ты — топовый сценарист вирусных роликов для соцсетей (Reels, TikTok, Shorts), специализирующийся на товарном маркетинге (Wildberries, Ozon, TikTok Shop).
Твоя задача — создать захватывающий сценарий для озвучки, который воспринимается как живой искренний обзор крутого товара или лайфхак (БЕЗ продаж "в лоб"), с мягким нативным предложением в финале.

ТОВАР В КАДРЕ:
- Название/исходные данные: "${effectiveProjectName}"
${effectiveProductInfo ? `- Особенности, польза и детали: "${effectiveProductInfo}"` : ''}

ОПРЕДЕЛЕНИЕ ТОВАРА И НАИМЕНОВАНИЕ:
1. По названию "${effectiveProjectName}" САМ логически определи, что это за конкретный товар (плойка/стайлер, отпариватель, робот-пылесос, увлажнитель, автоаксессуар, органайзер и т.д.).
2. НЕ НАЗЫВАЙ товар формальным длинным магазинным названием! Называй его естественно и разговорно: "эта плойка", "стайлер", "эта малышка", "девайс", "находка", "эта штука", "прибор".
3. Пойми боль целевой аудитории (что бесило раньше) и как этот товар быстро закрывает вопрос в реальной жизни.

КРИТИЧЕСКИ ВАЖНО — ТОЧНОСТЬ ХРОНОМЕТРАЖА:
- Длительность видео: ровно ${seconds} секунд.
- Озвучка ДОЛЖНА звучать ровно ${seconds} секунд!
- Общий объем произносимых слов (без учета тегов в скобках): СТРОГО от ${minWords} до ${maxWords} слов (в среднем ${targetWords} слов).
- Рассчитывай тайминг:
  * 0–3 сек: Взрывной эмоциональный хук (первая фраза-крючок, 6–8 слов, жизненная ситуация, разрыв шаблона или интрига)
  * 3–${Math.max(4, seconds - 5)} сек: Динамичный обзор в реальном деле (как товар работает, скорость, простота, тактильные ощущения, решение проблемы)
  * Последние 4–5 сек: Мягкий нативный CTA

${personaGuidance}

${ctaInstructions}

ПРАВИЛА ОЗВУЧКИ:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ клише "магазина на диване": "купите прямо сейчас", "скидка пятьдесят процентов", "спешите приобрести". Зритель мгновенно свайпает такую рекламу!
2. Говори живым языком реального человека, который сам пользуется этой вещью и в восторге от нее.
3. ТЕГИ ЭМОЦИЙ FISH AUDIO (обязательно 3–6 тегов):
   - [surprised] — удивление, шок
   - [gasp] — резкий вдох от неожиданности
   - [whispering] — секрет, интрига, рекомендация по дружбе
   - [confident] — экспертная польза, факт
   - [excited] — искренний восторг от вау-эффекта
   - [calm] — доверительная реплика
4. ТЕКСТ ДЛЯ ОЗВУЧКИ:
   - Только слова для произношения + теги эмоций в квадратных скобках!
   - НИКАКИХ смайликов/эмодзи, ссылок, звездочек и решеток!
   - Все числа обязательно пиши СЛОВАМИ (например, "пять минут", "двести градусов", "три насадки").
   - Проверь итоговое количество слов: ровно от ${minWords} до ${maxWords} слов!

Ответ верни СТРОГО в формате JSON:
{
  "hook": "первая фраза-крючок (до 8 слов, без тегов)",
  "title": "название товара или ролика",
  "script": "полный текст для диктора с тегами эмоций в скобках",
  "captions": [
    {
      "caption": "текст поста для соцсетей с артикулом/призывом",
      "hashtags": ["#вайлдберриз", "#озон", "#находка", "#обзор", "#shorts"]
    }
  ]
}`;

      userPrompt = [
        `Товар: "${effectiveProjectName}"`,
        effectiveTopic !== effectiveProjectName ? `Дополнительный контекст: "${effectiveTopic}"` : '',
        `Стиль / формат обзора: ${style}`,
        effectiveProductInfo ? `Польза / особенности товара: "${effectiveProductInfo}"` : '',
        opts.sourceTranscript
          ? `Транскрипт видеоряда для опоры: "${opts.sourceTranscript.slice(0, 1500)}"`
          : '',
        `СТРОГО СОБЛЮДАЙ ХРОНОМЕТРАЖ: ровно ${seconds} секунд видео (от ${minWords} до ${maxWords} слов текста, цель: ~${targetWords} слов).`,
        `ВАЖНО: Говори как живой человек, нативно обозревающий товар, БЕЗ рекламы в лоб.`,
        `Количество вариантов описаний (captions): ${variantCount}.`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    try {
      const res = await axios.post(
        `${BASE_URL}/chat/completions`,
        {
          models: OPENROUTER_FREE_MODELS,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.75,
        },
        {
          headers: {
            Authorization: `Bearer ${effectiveKey}`,
            'HTTP-Referer': 'https://kmmzavod.local',
            'X-Title': 'KMM Zavod Smart Editor',
            'Content-Type': 'application/json',
          },
          timeout: 45_000,
        },
      );

      const choice = res.data?.choices?.[0];
      const modelUsed = res.data?.model || 'openrouter-cascade';
      const rawText = choice?.message?.content || '';

      const parsed = extractJson(rawText);
      let scriptClean = sanitizeForVoiceover(parsed.script || rawText);

      // Post-processing safety net: If generated words are below minWords, enrich natively
      const actualWords = countWords(scriptClean);
      if (actualWords < minWords) {
        logger.info(
          { actualWords, minWords, targetWords, projectName: effectiveProjectName },
          'OpenRouter script below target duration, enriching natively to meet exact video length',
        );
        scriptClean = enrichScriptToWordCount(
          scriptClean,
          targetWords - actualWords,
          effectiveProjectName,
          effectiveProductInfo,
          ctaType,
          directWord,
        );
        scriptClean = sanitizeForVoiceover(scriptClean);
      }

      return {
        hook: stripEmotionTags(parsed.hook || effectiveProjectName),
        script: scriptClean,
        title: parsed.title || effectiveProjectName,
        captions: Array.isArray(parsed.captions) && parsed.captions.length > 0
          ? parsed.captions.map((c: any) => ({
              caption: stripEmotionTags(c.caption || ''),
              hashtags: c.hashtags || [],
            }))
          : [{ caption: parsed.title || effectiveProjectName, hashtags: ['#вайлдберриз', '#озон', '#находка'] }],
        modelUsed,
      };
    } catch (err: unknown) {
      const errMsg = axios.isAxiosError(err)
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data ?? err.message)}`
        : err instanceof Error ? err.message : String(err);

      logger.warn({ err: errMsg }, 'OpenRouter (api) failed, using native product heuristic script generator');
      if (isFitMode) {
        return generateMockFitScript({
          currentScript: opts.currentScript!,
          topic: effectiveTopic,
          projectName: effectiveProjectName,
          productInfo: effectiveProductInfo,
          targetSeconds: seconds,
          ctaType,
          directWord,
        });
      }
      return generateMockScript({
        topic: effectiveTopic,
        projectName: effectiveProjectName,
        productInfo: effectiveProductInfo,
        style,
        targetSeconds: seconds,
        ctaType,
        directWord,
      });
    }
  }
}
