/**
 * OpenRouter AI Service for apps/api.
 * Features:
 *  - Automatic cascade fallback across free models (:free)
 *  - High-retention short-form video script architecture
 *  - Fallback heuristic generation in mock mode
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

function generateMockScript(opts: {
  topic: string;
  style?: ScriptStyle;
  targetSeconds?: number;
}): ScriptGenerationResult {
  const topic = opts.topic.trim() || 'Секреты создания вирусного контента';
  const sec = opts.targetSeconds ?? 30;

  let hook = `[surprised] Вы совершаете эту ошибку каждый день, когда речь заходит про ${topic}!`;
  let body = `[confident] Большинство людей тратят часы на лишние действия. [whispering] Но секрет в том, чтобы сосредоточиться на трех простых шагах, которые дают восемьдесят процентов результата прямо сейчас.`;
  let cta = `[urgent] Подпишитесь на канал, чтобы не пропустить продолжение в следующем ролике!`;

  if (opts.style === 'sales') {
    hook = `[confident] Ищете лучший способ решить вопрос с ${topic}? [excited] Досмотрите до конца!`;
    body = `[confident] Мы протестировали десятки вариантов и нашли решение, которое экономит ваше время и бюджет уже с первого дня использования.`;
    cta = `[urgent] Переходите по ссылке в описании профиля и забирайте специальное предложение!`;
  } else if (opts.style === 'story') {
    hook = `[curious] Мало кто знает, с чего на самом деле началась история про ${topic}.`;
    body = `[whispering] Сначала в это никто не верил, и казалось, что проект обречен на провал. [confident] Но одно нестандартное решение перевернуло абсолютно всё.`;
    cta = `[curious] Напишите в комментариях, как бы вы поступили в такой ситуации!`;
  } else if (opts.style === 'hype') {
    hook = `[surprised] Шок! [excited] Это полностью изменит ваше представление про ${topic}!`;
    body = `[excited] То, что раньше казалось невозможным, теперь доступно каждому за считанные секунды. [confident] Смотрите, как это работает на практике.`;
    cta = `[urgent] Ставьте лайк и делитесь этим видео с друзьями прямо сейчас!`;
  }

  const fullScript = sanitizeForVoiceover(`${hook} ${body} ${cta}`);

  return {
    hook: stripEmotionTags(hook),
    script: fullScript,
    title: topic.slice(0, 60),
    captions: [
      {
        caption: `${stripEmotionTags(hook)}\n\n${stripEmotionTags(body)}`,
        hashtags: ['#вирусное', '#тренды', '#рекомендации', '#reels', '#shorts'],
      },
      {
        caption: `Секрет раскрыт: ${topic}! Смотри подробности в видео.`,
        hashtags: ['#полезное', '#лайфхак', '#топ', '#tiktok'],
      },
    ],
    modelUsed: 'mock-heuristic-fallback',
  };
}

export class OpenRouterService {
  async generateScript(opts: {
    topic: string;
    style?: ScriptStyle;
    targetSeconds?: number;
    sourceTranscript?: string;
    productInfo?: string;
    language?: string;
    variantCount?: number;
    apiKey?: string;
  }): Promise<ScriptGenerationResult> {
    const effectiveKey = (opts.apiKey || API_KEY || '').trim();
    const isMock = !effectiveKey || effectiveKey.startsWith('mock_');
    const style = opts.style || 'hype';
    const lang = opts.language || 'ru';
    const seconds = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
    const targetWords = Math.round(seconds * 2.4);
    const variantCount = Math.max(1, Math.min(10, opts.variantCount ?? 3));

    if (isMock) {
      logger.info(
        { topic: opts.topic, style },
        'OpenRouter (api): Key not set or mock mode, using heuristic generator with Fish Audio emotion tags',
      );
      return generateMockScript({ topic: opts.topic, style, targetSeconds: seconds });
    }

    const systemPrompt = `Ты — лучший сценарист вирусных коротких видео (TikTok, Instagram Reels, YouTube Shorts).
Твоя задача — создать захватывающий сценарий для озвучки ролика на русском языке.

ОЗВУЧКА И ЭФФЕКТЫ (FISH AUDIO S2.1-PRO):
Модель синтеза речи Fish Audio поддерживает теги эмоций и интонаций в квадратных скобках (bracket syntax).
ОБЯЗАТЕЛЬНО используй от 2 до 5 тегов эмоций в тексте сценария перед ключевыми фразами:
- [excited] — энергично, воодушевленно, максимальный драйв
- [confident] — уверенно, авторитетно, экспертно
- [whispering] — шёпотом, интригующе, по секрету
- [laughing] — со смехом, весело, с иронией
- [surprised] — с удивлением, шок
- [gasp] — резкий вдох от неожиданности
- [curious] — с любопытством, загадочно
- [urgent] — призывно, срочно (для призыва к действию / CTA)
- [calm] — спокойно, размеренно
- [sigh] — со вздохом облегчения или усталости

ПРАВИЛА ОЗВУЧКИ:
1. ХУК В ПЕРВЫЕ 3 СЕКУНДЫ: мгновенно цепляет внимание зрителя с тегом эмоции (например, "[surprised] Вы ни за что не поверите!").
2. ДИНАМИКА: короткие предложения, плотная подача без воды.
3. ТЕКСТ ДЛЯ ОЗВУЧКИ (script):
   - Только слова для произношения + теги эмоций в квадратных скобках!
   - НИКАКИХ смайликов/эмодзи, ссылок, звездочек и решеток!
   - Все числа обязательно пиши СЛОВАМИ (например, "пять шагов", "двадцать шестой год", "сто тысяч рублей").
   - Пример: "[surprised] Вы совершаете эту ошибку каждый день! [confident] Но всё решается за три простых шага. [whispering] Главное — никому об этом не говорите. [urgent] Жмите подписаться прямо сейчас!"
   - Точно уложись в объем: ${targetWords} слов (длительность ролика ~${seconds} сек).
4. Заверши сценарий коротким призывом к действию (CTA) с тегом [urgent] или [excited].

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

    const userPrompt = [
      `Тема или суть ролика: "${opts.topic}"`,
      opts.style ? `Стиль повествования: ${style}` : '',
      opts.productInfo ? `Информация о продукте/предложении: "${opts.productInfo}"` : '',
      opts.sourceTranscript
        ? `Исходная речь / транскрипт видео для вдохновения: "${opts.sourceTranscript.slice(0, 1500)}"`
        : '',
      `Целевой хронометраж: ~${seconds} секунд (целевое количество слов: ~${targetWords} слов).`,
      `Количество вариантов описаний (captions): ${variantCount}.`,
    ]
      .filter(Boolean)
      .join('\n');

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
      const scriptClean = sanitizeForVoiceover(parsed.script || rawText);

      return {
        hook: stripEmotionTags(parsed.hook || opts.topic),
        script: scriptClean,
        title: parsed.title || opts.topic,
        captions: Array.isArray(parsed.captions) && parsed.captions.length > 0
          ? parsed.captions.map((c: any) => ({
              caption: stripEmotionTags(c.caption || ''),
              hashtags: c.hashtags || [],
            }))
          : [{ caption: parsed.title || opts.topic, hashtags: ['#viral', '#reels', '#shorts'] }],
        modelUsed,
      };
    } catch (err: unknown) {
      const errMsg = axios.isAxiosError(err)
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data ?? err.message)}`
        : err instanceof Error ? err.message : String(err);

      logger.warn({ err: errMsg }, 'OpenRouter (api) failed, using heuristic script with emotions');
      return generateMockScript({ topic: opts.topic, style, targetSeconds: seconds });
    }
  }
}
