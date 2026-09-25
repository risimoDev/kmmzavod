/**
 * OpenRouter AI Service for apps/orchestrator.
 * Features:
 *  - Native marketing & organic recommendation architecture (value-first, soft-sell, no "hard-sell in the face")
 *  - Project title and description integration for targeted messaging and organic discovery
 *  - Dedicated Text Expansion & Fit engine (when script is too short for video duration)
 *  - Automatic cascade fallback across free models (:free)
 *  - Natural Fish Audio emotion tags ([excited], [confident], [whispering], [surprised], [calm])
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

export type ScriptStyle = 'hype' | 'educational' | 'story' | 'sales' | 'humor' | 'minimal';

export interface GenerateScriptOptions {
  topic?: string;
  projectName?: string;
  productInfo?: string;
  style?: ScriptStyle;
  targetSeconds?: number;
  sourceTranscript?: string;
  currentScript?: string;
  mode?: 'generate' | 'expand' | 'fit';
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
): string {
  if (deficit <= 0) return script;
  const name = (projectName || 'этот инструмент').trim();
  const infoSnippet = productInfo ? `Ведь ${productInfo.slice(0, 100).trim()}. ` : '';

  const modules = [
    `[confident] Самое приятное, что ${name} избавляет от всей рутины и экономит часы времени каждую неделю.`,
    `[whispering] ${infoSnippet}Я сам перепробовал кучу вариантов, но именно это решение дало самый предсказуемый и качественный результат.`,
    `[excited] Попробуйте применить этот подход сами — разницу почувствуете буквально с первых минут.`,
    `[confident] Если вам тоже актуально упростить эту задачу — сохраняйте ролик, чтобы не потерять.`,
    `[whispering] А ссылку на ${name} и все подробности я аккуратно оставил в описании профиля.`,
  ];

  let current = script.trim();
  for (const mod of modules) {
    if (countWords(current) >= countWords(script) + deficit) break;
    current += ` ${mod}`;
  }

  while (countWords(current) < countWords(script) + deficit) {
    current += ` [confident] Все детали и ссылку прикрепил в описании профиля, пользуйтесь на здоровье!`;
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
}): ScriptGenerationResult {
  const name = (opts.projectName || opts.topic || 'этот инструмент').trim();
  const info = (opts.productInfo || '').trim();
  const sec = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
  const targetWords = Math.round(sec * 2.05);

  let baseScript = opts.currentScript.trim();
  let currentCount = countWords(baseScript);

  if (currentCount < targetWords) {
    const deficit = targetWords - currentCount;
    baseScript = enrichScriptToWordCount(baseScript, deficit, name, info);
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
        hashtags: ['#вирусное', '#лайфхак', '#reels', '#shorts', '#находка'],
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
}): ScriptGenerationResult {
  const name = (opts.projectName || opts.topic || 'этот инструмент').trim();
  const info = (opts.productInfo || '').trim();
  const sec = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
  const targetWords = Math.round(sec * 2.05);

  let hook = `[surprised] Большинство людей даже не догадываются, сколько времени они теряют на эту простую задачу!`;
  let body = `[confident] Вместо того чтобы часами делать всё вручную и переделывать по кругу, есть гораздо более удобный способ. [whispering] Я сам долго мучился, пока не открыл для себя ${name}. [excited] Фишка в том, что весь процесс теперь занимает считанные секунды и работает практически на автомате.`;
  let cta = `[confident] Кому актуально — обязательно сохраняйте, [whispering] а ссылку на ${name} я оставил в описании профиля!`;

  if (opts.style === 'sales' || !opts.style) {
    hook = `[curious] Знаете, почему у одних уходит целый день на рутину, а другие закрывают этот вопрос за пять минут?`;
    body = `[confident] Всё дело в правильном инструменте. [whispering] Мы долго тестировали разные варианты, пока не нашли ${name}. [excited] Это решение буквально забирает на себя девяносто процентов работы и выдает результат без лишней головной боли. [confident] Главное — один раз настроить и забыть о проблеме.`;
    cta = `[whispering] Если хотите внедрить это у себя — загляните в описание профиля, там оставил подробный разбор и ссылку.`;
  } else if (opts.style === 'hype') {
    hook = `[gasp] Честно, я сам был в шоке, когда впервые увидел, как это работает!`;
    body = `[excited] То, на что раньше уходили недели сложных действий, теперь делается буквально в один клик. [confident] Смотрите сами на эту скорость и аккуратность. [whispering] Про ${name} пока мало кто знает, но именно такие находки дают максимальное преимущество.`;
    cta = `[confident] Сохраняйте себе этот лайфхак, а ссылку на инструмент я прикрепил в шапке профиля.`;
  } else if (opts.style === 'story') {
    hook = `[curious] Мало кто знает, как мы случайно нашли способ упростить этот процесс в несколько раз.`;
    body = `[whispering] Сначала казалось, что без огромной команды тут не справиться. [confident] Но однажды мы протестировали подход на базе ${name} — и всё изменилось. [excited] Рутина исчезла, а качество выросло так, что первые результаты удивили даже нас самих.`;
    cta = `[confident] Кому интересно повторить этот опыт — загляните в профиль, там оставил все контакты и детали.`;
  } else if (opts.style === 'educational') {
    hook = `[confident] Вот три неочевидных правила, о которых молчат девяносто процентов специалистов.`;
    body = `[confident] Первое — не усложнять то, что можно автоматизировать. [whispering] Второе — использовать проверенные решения вроде ${name}, которые берут базовую рутину на себя. [excited] И третье — сосредоточиться только на главном результате, пока система делает остальное.`;
    cta = `[confident] Сохраняйте эту памятку, а ссылку на сам инструмент найдете в описании профиля!`;
  }

  if (info) {
    body += ` [confident] Кстати, ключевая особенность: ${info.slice(0, 100)}.`;
  }

  let fullScript = `${hook} ${body} ${cta}`;
  const curWords = countWords(fullScript);
  if (curWords < targetWords) {
    fullScript = enrichScriptToWordCount(fullScript, targetWords - curWords, name, info);
  }

  fullScript = sanitizeForVoiceover(fullScript);

  return {
    hook: stripEmotionTags(hook),
    script: fullScript,
    title: name.slice(0, 60),
    captions: [
      {
        caption: `${stripEmotionTags(hook)}\n\n${stripEmotionTags(body)}`,
        hashtags: ['#лайфхак', '#полезное', '#рекомендации', '#reels', '#shorts'],
      },
      {
        caption: `Полезная находка: ${name}! Подробности в видео.`,
        hashtags: ['#лайфхак', '#советы', '#топ', '#тренды'],
      },
    ],
    modelUsed: 'mock-heuristic-fallback',
  };
}

export class OpenRouterService {
  async generateScript(opts: GenerateScriptOptions): Promise<ScriptGenerationResult> {
    const effectiveKey = (opts.apiKey || API_KEY || '').trim();
    const isMock = !effectiveKey || effectiveKey.startsWith('mock_');
    const style = opts.style || 'hype';
    const seconds = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
    const minWords = Math.max(15, Math.round(seconds * 1.95));
    const maxWords = Math.round(seconds * 2.20);
    const targetWords = Math.round(seconds * 2.05);
    const variantCount = Math.max(1, Math.min(10, opts.variantCount ?? 3));

    const effectiveProjectName = (opts.projectName || opts.topic || 'Видеоролик').trim();
    const effectiveTopic = (opts.topic || effectiveProjectName).trim();
    const effectiveProductInfo = (opts.productInfo || '').trim();

    const isFitMode = (opts.mode === 'fit' || opts.mode === 'expand') && Boolean(opts.currentScript?.trim());

    if (isMock) {
      logger.info(
        { projectName: effectiveProjectName, topic: effectiveTopic, style, seconds, targetWords, isFitMode },
        'OpenRouter (orchestrator): Key not set or mock mode, using native heuristic generator with Fish Audio emotion tags',
      );
      if (isFitMode) {
        return generateMockFitScript({
          currentScript: opts.currentScript!,
          topic: effectiveTopic,
          projectName: effectiveProjectName,
          productInfo: effectiveProductInfo,
          targetSeconds: seconds,
        });
      }
      return generateMockScript({
        topic: effectiveTopic,
        projectName: effectiveProjectName,
        productInfo: effectiveProductInfo,
        style,
        targetSeconds: seconds,
      });
    }

    let systemPrompt: string;
    let userPrompt: string;

    if (isFitMode) {
      const currentWordCount = countWords(opts.currentScript || '');
      systemPrompt = `Ты — ведущий сценарист вирусных коротких видео (TikTok, Instagram Reels, YouTube Shorts), мастер НАТИВНЫХ интеграций и скрытого органического маркетинга.
Твоя задача — ДОРАБОТАТЬ, УЛУЧШИТЬ И АДАПТИРОВАТЬ имеющийся текст автора под хронометраж видео, сделав интеграцию продукта "${effectiveProjectName}" МАКСИМАЛЬНО НАТИВНОЙ, мягкой и органичной (БЕЗ агрессивных продаж в лоб).

КОНТЕКСТ ПРОЕКТА:
- Продукт/проект/инструмент: "${effectiveProjectName}"
${effectiveProductInfo ? `- Описание, польза и фишки: "${effectiveProductInfo}"` : ''}

КРИТИЧЕСКИ ВАЖНО — ТОЧНОСТЬ ХРОНОМЕТРАЖА:
- Длительность видео: ровно ${seconds} секунд.
- Озвучка ДОЛЖНА длиться ровно ${seconds} секунд!
- Исходный черновик содержит всего ${currentWordCount} слов.
- Итоговый объем слов (без тегов в скобках) ДОЛЖЕН составлять СТРОГО от ${minWords} до ${maxWords} слов (целевой объем: ровно ${targetWords} слов).
- Если слов будет меньше ${minWords}, в конце видео образуется неловкая тишина!

ГЛАВНЫЕ ПРИНЦИПЫ НАТИВНОЙ ПОДАЧИ:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ агрессивные продажи в лоб ("купите прямо сейчас", "уникальная цена", "скидка", "спешите заказать").
2. СОХРАНИ ГОЛОС И СУТЬ: Сохрани ключевой посыл, стиль и главные мысли автора из исходного текста.
3. НАТИВНАЯ ИНТЕГРАЦИЯ:
   - Раскрой подробности, личный опыт или практическую пользу инструмента "${effectiveProjectName}".
   - Покажи, как продукт естественно закрывает рутину, экономит время или нервы.
   - Используй живые разговорные связки ("И вот в чем секрет...", "Самое удобное, что...").
4. МЯГКИЙ НАТИВНЫЙ ФИНАЛ: В конце не дави на зрителя, а мягко предложи заглянуть за подробностями ("Кому актуально — сохраняйте, ссылку оставил в описании", "Попробуйте сами, детали в профиле", "Если нужно такое же решение — ссылка в шапке").
5. ТЕГИ ЭМОЦИЙ FISH AUDIO (обязательно 3–6 тегов перед ключевыми репликами):
   - [whispering] — секрет, интрига, рекомендация по дружбе
   - [confident] — экспертность, убедительность, польза
   - [excited] — искреннее воодушевление результатом
   - [surprised] — удивление, разрыв шаблона
   - [calm] — спокойная, доверительная подача
6. ЧИСТЫЙ ТЕКСТ ДЛЯ ОЗВУЧКИ (script):
   - Никаких смайликов/эмодзи, решеток, звездочек и ссылок!
   - Все числа обязательно пиши СЛОВАМИ (например, "пять шагов", "девяносто девять процентов", "две тысячи рублей").
   - Итоговый объем: СТРОГО от ${minWords} до ${maxWords} слов!

Ответ верни СТРОГО в формате JSON:
{
  "hook": "первая цепляющая фраза-крючок (до 8 слов, без тегов)",
  "title": "цепляющий заголовок для ролика",
  "script": "нативно улучшенный и расширенный текст для диктора с тегами эмоций в скобках",
  "captions": [
    {
      "caption": "текст поста для соцсетей с мягкой рекомендацией",
      "hashtags": ["#хэштег1", "#хэштег2", "#хэштег3", "#хэштег4"]
    }
  ]
}`;

      userPrompt = [
        `Исходный текст для нативной адаптации и расширения: "${opts.currentScript}"`,
        `Продукт / инструмент: "${effectiveProjectName}"`,
        effectiveProductInfo ? `Польза / особенности: "${effectiveProductInfo}"` : '',
        `СТРОГО СОБЛЮДАЙ ХРОНОМЕТРАЖ: ровно ${seconds} секунд видео (от ${minWords} до ${maxWords} слов текста, цель: ~${targetWords} слов).`,
        `ВАЖНО: Никаких продаж в лоб. Только нативная, искренняя и мягкая подача через пользу.`,
      ].filter(Boolean).join('\n');
    } else {
      systemPrompt = `Ты — ведущий сценарист вирусных коротких видео (TikTok, Instagram Reels, YouTube Shorts), мастер НАТИВНЫХ интеграций и скрытого органического маркетинга.
Твоя задача — создать захватывающий сценарий для озвучки ролика, который НЕ продает "в лоб", а воспринимается как ценный контент, полезный лайфхак или искренняя личная рекомендация, ненавязчиво подводя зрителя к продукту "${effectiveProjectName}".

КОНТЕКСТ ПРОЕКТА:
- Продукт/проект/инструмент: "${effectiveProjectName}"
${effectiveProductInfo ? `- Описание, польза и особенности: "${effectiveProductInfo}"` : ''}

КРИТИЧЕСКИ ВАЖНО — ТОЧНОСТЬ ХРОНОМЕТРАЖА:
- Длительность видео: ровно ${seconds} секунд.
- Озвучка ДОЛЖНА звучать ровно ${seconds} секунд!
- Общий объем произносимых слов (без учета тегов в скобках): СТРОГО от ${minWords} до ${maxWords} слов (в среднем ${targetWords} слов).
- Рассчитывай тайминг:
  * 0–3 сек: Взрывной хук (первая фраза-крючок, 6–8 слов, жизненная ситуация, неочевидный факт или инсайт)
  * 3–${Math.max(4, seconds - 5)} сек: Удержание через пользу (разбор проблемы, личный опыт, как инструмент "${effectiveProjectName}" нативно решает вопрос)
  * Последние 4–5 сек: Мягкое нативное предложение (сохранить, заглянуть в шапку профиля или описание)

ЖЕСТКИЕ ПРАВИЛА — НАТИВНОСТЬ, А НЕ ПРОДАЖА В ЛОБ:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ фразы телевизионной рекламы и агрессивные продажи в лоб: "купите прямо сейчас", "специальное предложение", "успейте купить", "уникальная цена", "скидка", "акция". Зритель мгновенно свайпает такую рекламу!
2. ПОЗИЦИЯ АВТОРА: Эксперт, практик или друг, который делится инсайтом, решением наболевшей проблемы или крутой находкой ("я сам долго искал способ", "делюсь тем, что реально сработало", "многие даже не знают про эту фишку").
3. РОЛЬ ПРОДУКТА: Продукт "${effectiveProjectName}" упоминается органично — как инструмент, который помог получить результат, автоматизировать рутину или сэкономить время.
4. МЯГКИЙ НАТИВНЫЙ ФИНАЛ:
   - "Кому актуально — сохраняйте, ссылку на ${effectiveProjectName} оставил в описании профиля."
   - "Попробуйте применить сами — все подробности прикрепил в шапке."
   - "Если нужно такое же решение без лишней головной боли — ссылка в профиле."
   - "Сохраняйте лайфхак, чтобы не потерять!"

ТЕГИ ЭМОЦИЙ FISH AUDIO (обязательно используй 3–6 тегов):
[whispering] (секрет/делюсь находкой), [confident] (экспертная польза), [excited] (воодушевление результатом), [surprised] (удивление в хуке), [calm] (доверительный совет)

ПРАВИЛА ТЕКСТА ДЛЯ ОЗВУЧКИ:
- Только слова для произношения + теги эмоций в квадратных скобках!
- НИКАКИХ смайликов/эмодзи, ссылок, звездочек и решеток!
- Все числа обязательно пиши СЛОВАМИ (например, "пять шагов", "двадцать шестой год", "сто тысяч рублей").
- Проверь итоговое количество слов: ровно от ${minWords} до ${maxWords} слов!

Ответ верни СТРОГО в формате JSON:
{
  "hook": "первая фраза-крючок (до 8 слов, без тегов)",
  "title": "цепляющий заголовок для ролика",
  "script": "полный текст для диктора с тегами эмоций в скобках",
  "captions": [
    {
      "caption": "текст поста для соцсетей с мягкой рекомендацией",
      "hashtags": ["#хэштег1", "#хэштег2", "#хэштег3", "#хэштег4"]
    }
  ]
}`;

      userPrompt = [
        `Продукт / тема ролика: "${effectiveProjectName}"`,
        effectiveTopic !== effectiveProjectName ? `Дополнительный контекст: "${effectiveTopic}"` : '',
        opts.style ? `Стиль повествования: ${style}` : '',
        effectiveProductInfo ? `Польза / особенности продукта: "${effectiveProductInfo}"` : '',
        opts.sourceTranscript
          ? `Исходная речь / транскрипт видео для вдохновения: "${opts.sourceTranscript.slice(0, 1500)}"`
          : '',
        `СТРОГО СОБЛЮДАЙ ХРОНОМЕТРАЖ: ровно ${seconds} секунд видео (от ${minWords} до ${maxWords} слов текста, цель: ~${targetWords} слов).`,
        `ВАЖНО: Подача ДОЛЖНА быть нативной и органической, без прямых продаж в лоб.`,
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
          : [{ caption: parsed.title || effectiveProjectName, hashtags: ['#лайфхак', '#reels', '#shorts'] }],
        modelUsed,
      };
    } catch (err: unknown) {
      const errMsg = axios.isAxiosError(err)
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data ?? err.message)}`
        : err instanceof Error ? err.message : String(err);

      logger.warn({ err: errMsg }, 'OpenRouter (orchestrator) failed, using native heuristic script generator');
      if (isFitMode) {
        return generateMockFitScript({
          currentScript: opts.currentScript!,
          topic: effectiveTopic,
          projectName: effectiveProjectName,
          productInfo: effectiveProductInfo,
          targetSeconds: seconds,
        });
      }
      return generateMockScript({
        topic: effectiveTopic,
        projectName: effectiveProjectName,
        productInfo: effectiveProductInfo,
        style,
        targetSeconds: seconds,
      });
    }
  }
}
