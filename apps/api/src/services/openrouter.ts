/**
 * OpenRouter AI Service for apps/api.
 * Features:
 *  - High-converting viral video copywriting (Hook -> Retain/Agitate -> Value -> Offer/CTA)
 *  - Project title and description integration for targeted messaging and sales push
 *  - Dedicated Text Expansion & Fit engine (when script is too short for video duration)
 *  - Automatic cascade fallback across free models (:free)
 *  - Natural Fish Audio emotion tags ([excited], [confident], [whispering], [surprised], [urgent])
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
  // Preserve bracketed emotion tags like [excited], [confident], [whispering], etc.
  // while removing emojis, markdown asterisks, hashes, backticks, quotes, and normalize spacing.
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
  const name = (projectName || 'наш продукт').trim();
  const infoSnippet = productInfo ? `Ведь ${productInfo.slice(0, 100).trim()}. ` : '';

  const modules = [
    `[confident] Именно поэтому ${name} выбирают те, кто ценит свое время и реальный результат без лишних компромиссов.`,
    `[excited] Попробуйте прямо сейчас и почувствуйте колоссальную разницу уже с первых минут использования.`,
    `[whispering] ${infoSnippet}Не откладывайте решение на потом, ведь лучшие условия и специальные бонусы доступны ограниченное время.`,
    `[confident] Сотни довольных пользователей уже проверили это на практике и убедились в стопроцентной эффективности.`,
    `[urgent] Переходите по ссылке в описании профиля прямо сейчас, забирайте предложение и выходите на новый уровень уже сегодня!`,
  ];

  let current = script.trim();
  for (const mod of modules) {
    if (countWords(current) >= countWords(script) + deficit) break;
    current += ` ${mod}`;
  }

  while (countWords(current) < countWords(script) + deficit) {
    current += ` [urgent] Действуйте прямо сейчас, пока предложение доступно на лучших условиях!`;
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
  const name = (opts.projectName || opts.topic || 'Продукт').trim();
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
        hashtags: ['#вирусное', '#reels', '#shorts', '#продажи', '#тренды'],
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
  const name = (opts.projectName || opts.topic || 'Секреты создания контента').trim();
  const info = (opts.productInfo || '').trim();
  const sec = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
  const targetWords = Math.round(sec * 2.05);

  let hook = `[surprised] Вы совершаете эту ошибку каждый день, когда речь заходит про ${name}!`;
  let body = `[confident] Большинство людей тратят часы на лишние действия. [whispering] Но секрет в том, чтобы сосредоточиться на простых шагах, которые дают восемьдесят процентов результата прямо сейчас. [excited] Проект ${name} решает эту задачу с максимальной отдачей.`;
  let cta = `[urgent] Переходите по ссылке в описании профиля прямо сейчас и забирайте специальное предложение!`;

  if (opts.style === 'sales' || !opts.style) {
    hook = `[confident] Ищете лучший способ решить вопрос с ${name}? [surprised] Досмотрите до конца!`;
    body = `[confident] Мы протестировали десятки вариантов и нашли решение, которое экономит ваше время и бюджет уже с первого дня. [excited] Проект ${name} уже помог сотням людей добиться потрясающих результатов без лишних усилий. [whispering] Здесь всё продумано до мелочей, чтобы вы получали стабильный результат без риска и переплат.`;
    cta = `[urgent] Жмите на ссылку в профиле прямо сейчас и забирайте персональную скидку, пока действует спецпредложение!`;
  } else if (opts.style === 'hype') {
    hook = `[gasp] Шок! [excited] Это полностью изменит ваше представление про ${name}!`;
    body = `[excited] То, что раньше казалось невозможным, теперь доступно каждому в один клик. [confident] Смотрите, как это работает на практике. [surprised] Просто невероятный объем и качество без единого сложного движения. [whispering] Такого уровня вы еще точно нигде не видели!`;
    cta = `[urgent] Ставьте лайк, сохраняйте это видео и переходите по ссылке в описании, пока предложение доступно!`;
  } else if (opts.style === 'story') {
    hook = `[curious] Мало кто знает, какая реальная история стоит за созданием проекта ${name}.`;
    body = `[whispering] Сначала в это никто не верил, и казалось, что проект обречен на провал. [confident] Но одно нестандартное решение перевернуло абсолютно всё. [excited] Мы изменили ключевые детали, и результат превзошел любые ожидания за считанные дни. [curious] Самое интересное началось в тот момент, когда первые клиенты увидели разницу.`;
    cta = `[urgent] Напишите в комментариях, хотите ли узнать подробности, или сразу переходите по ссылке в профиле!`;
  }

  if (info) {
    body += ` [confident] Главная фишка: ${info.slice(0, 100)}.`;
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
        hashtags: ['#вирусное', '#тренды', '#рекомендации', '#reels', '#shorts'],
      },
      {
        caption: `Секрет раскрыт: ${name}! Смотри подробности в видео.`,
        hashtags: ['#полезное', '#лайфхак', '#топ', '#бизнес'],
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
        'OpenRouter (api): Key not set or mock mode, using heuristic generator with Fish Audio emotion tags',
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
      systemPrompt = `Ты — ведущий сценарист и маркетолог вирусных коротких видео (TikTok, Instagram Reels, YouTube Shorts).
Твоя задача — ДОРАБОТАТЬ, УЛУЧШИТЬ И АДАПТИРОВАТЬ имеющийся текст автора под хронометраж видео.

КОНТЕКСТ ПРОЕКТА:
- Название проекта/бренда/ролика: "${effectiveProjectName}"
${effectiveProductInfo ? `- Описание проекта / продукта / оффер: "${effectiveProductInfo}"` : ''}

КРИТИЧЕСКИ ВАЖНО — ТОЧНОСТЬ ХРОНОМЕТРАЖА:
- Длительность видео: ровно ${seconds} секунд.
- Озвучка ДОЛЖНА длиться ровно ${seconds} секунд!
- Исходный черновик содержит всего ${currentWordCount} слов.
- Итоговый объем слов (без тегов в скобках) ДОЛЖЕН составлять СТРОГО от ${minWords} до ${maxWords} слов (целевой объем: ровно ${targetWords} слов).
- Если слов будет меньше ${minWords}, в конце видео образуется неловкая тишина!

ПРАВИЛА УЛУЧШЕНИЯ И РАСШИРЕНИЯ ТЕКСТА:
1. СОХРАНИ ГОЛОС И СУТЬ: Сохрани ключевой посыл, стиль и главные мысли автора из исходного текста.
2. ДОБАВЬ УДЕРЖАНИЕ И ПРОДАЖИ:
   - Раскрой сочные подробности и конкретную выгоду продукта "${effectiveProjectName}".
   - Добавь эмоциональный накал, интригующие связки ("И вот в чем главный секрет...", "Только представьте...").
   - Усили призыв к покупке (CTA): прямой призыв перейти по ссылке в описании, успеть заказать, забрать спецпредложение.
3. ТЕГИ ЭМОЦИЙ FISH AUDIO (обязательно 3–6 тегов перед ключевыми репликами):
   - [excited] — драйв, воодушевление, энергия
   - [confident] — экспертность, убедительность
   - [whispering] — интрига, по секрету
   - [surprised] — шок, сенсация, удивление
   - [urgent] — срочность, призыв к действию (CTA)
4. ЧИСТЫЙ ТЕКСТ ДЛЯ ОЗВУЧКИ (script):
   - Никаких смайликов/эмодзи, решеток, звездочек и ссылок!
   - Все числа обязательно пиши СЛОВАМИ (например, "пять шагов", "девяносто девять процентов", "две тысячи рублей").
   - Итоговый объем: СТРОГО от ${minWords} до ${maxWords} слов!

Ответ верни СТРОГО в формате JSON:
{
  "hook": "первая цепляющая фраза-крючок (до 8 слов, без тегов)",
  "title": "цепляющий заголовок для ролика",
  "script": "улучшенный и расширенный текст для диктора с тегами эмоций в скобках",
  "captions": [
    {
      "caption": "текст поста для соцсетей с призывом",
      "hashtags": ["#хэштег1", "#хэштег2", "#хэштег3", "#хэштег4"]
    }
  ]
}`;

      userPrompt = [
        `Исходный текст для адаптации и расширения: "${opts.currentScript}"`,
        `Название проекта / продукта: "${effectiveProjectName}"`,
        effectiveProductInfo ? `Описание / оффер / УТП: "${effectiveProductInfo}"` : '',
        `СТРОГО СОБЛЮДАЙ ХРОНОМЕТРАЖ: ровно ${seconds} секунд видео (от ${minWords} до ${maxWords} слов текста, цель: ~${targetWords} слов).`,
      ].filter(Boolean).join('\n');
    } else {
      systemPrompt = `Ты — топ-1 сценарист и маркетолог вирусных продающих коротких видео (TikTok, Instagram Reels, YouTube Shorts).
Твоя задача — создать захватывающий сценарий для озвучки ролика, который с первых секунд цепляет зрителя, удерживает внимание до конца и решительно подталкивает к покупке.

КОНТЕКСТ ПРОЕКТА:
- Название проекта/ролика: "${effectiveProjectName}"
${effectiveProductInfo ? `- Описание проекта / продукта / оффер: "${effectiveProductInfo}"` : ''}

КРИТИЧЕСКИ ВАЖНО — ТОЧНОСТЬ ХРОНОМЕТРАЖА:
- Длительность видео: ровно ${seconds} секунд.
- Озвучка ДОЛЖНА звучать ровно ${seconds} секунд!
- Общий объем произносимых слов (без учета тегов в скобках): СТРОГО от ${minWords} до ${maxWords} слов (в среднем ${targetWords} слов).
- Рассчитывай тайминг:
  * 0–3 сек: взрывной хук (первая фраза-крючок, 6–8 слов, парадокс или удар по боли)
  * 3–${Math.max(4, seconds - 5)} сек: динамичное удержание (раскрытие проблемы, выгоды проекта "${effectiveProjectName}", снятие возражений)
  * Последние 4–5 сек: мощный призыв к действию / покупке (CTA) с тегом [urgent]

СТРУКТУРА ВЫСОКОГО УДЕРЖАНИЯ И ПРОДАЖ (AIDA):
1. ХУК В ПЕРВЫЕ 3 СЕКУНДЫ: мгновенно цепляет внимание зрителя с тегом [surprised], [curious] или [excited]. Задай провокационный вопрос или озвучь неожиданный факт о "${effectiveProjectName}".
2. УДЕРЖАНИЕ И ВЫГОДА: короткие, динамичные фразы (3–8 слов), плотная подача без воды и приветствий. Покажи, какую конкретную боль решает продукт и почему это необходимо зрителю прямо сейчас.
3. ПОДТАЛКИВАНИЕ К ПОКУПКЕ (CTA): закрой ролик убедительным призывом к действию с тегом [urgent] (перейти по ссылке в описании, забрать скидку, написать кодовое слово).

ТЕГИ ЭМОЦИЙ FISH AUDIO (обязательно используй 3–6 тегов):
[excited], [confident], [whispering], [surprised], [urgent], [curious], [laughing]

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
      "caption": "текст поста для соцсетей с призывом",
      "hashtags": ["#хэштег1", "#хэштег2", "#хэштег3", "#хэштег4"]
    }
  ]
}`;

      userPrompt = [
        `Название проекта / тема ролика: "${effectiveProjectName}"`,
        effectiveTopic !== effectiveProjectName ? `Дополнительная тема: "${effectiveTopic}"` : '',
        opts.style ? `Стиль повествования: ${style}` : '',
        effectiveProductInfo ? `Информация о продукте/предложении/оффер: "${effectiveProductInfo}"` : '',
        opts.sourceTranscript
          ? `Исходная речь / транскрипт видео для вдохновения: "${opts.sourceTranscript.slice(0, 1500)}"`
          : '',
        `СТРОГО СОБЛЮДАЙ ХРОНОМЕТРАЖ: ровно ${seconds} секунд видео (от ${minWords} до ${maxWords} слов текста, цель: ~${targetWords} слов).`,
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

      // Post-processing safety net: If generated words are below minWords, enrich to targetWords
      const actualWords = countWords(scriptClean);
      if (actualWords < minWords) {
        logger.info(
          { actualWords, minWords, targetWords, projectName: effectiveProjectName },
          'OpenRouter script below target duration, enriching to meet exact video length',
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
          : [{ caption: parsed.title || effectiveProjectName, hashtags: ['#viral', '#reels', '#shorts'] }],
        modelUsed,
      };
    } catch (err: unknown) {
      const errMsg = axios.isAxiosError(err)
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data ?? err.message)}`
        : err instanceof Error ? err.message : String(err);

      logger.warn({ err: errMsg }, 'OpenRouter (api) failed, using smart heuristic script generator');
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
