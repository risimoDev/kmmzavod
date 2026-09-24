/**
 * OpenRouter AI Service for Video Scripts & Hook Generation.
 * Docs: https://openrouter.ai/api/v1/chat/completions
 * Features:
 *  - Automatic cascade fallback across high-quality free models (:free suffix)
 *  - High-retention short-form video script architecture (Hook, Body, CTA)
 *  - Voiceover text sanitization (spelling out numbers, stripping emojis/markdown)
 *  - Fallback heuristic generation when in mock/offline mode
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

/** Extract JSON from model text that may contain markdown fences or surrounding prose. */
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

/** Sanitize script text for natural TTS synthesis (Fish Audio). */
export function sanitizeForVoiceover(text: string): string {
  return text
    // Remove markdown symbols (asterisks, hashtags, underscores, brackets)
    .replace(/[*#_~`\[\]\(\)\{\}<>]/g, ' ')
    // Remove emojis and non-alphanumeric symbols except standard punctuation
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    // Normalize dashes and quotation marks
    .replace(/[«»"']/g, '')
    // Replace multiple spaces with a single space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fallback heuristic script generator when in mock mode or API is unavailable. */
function generateMockScript(opts: {
  topic: string;
  style?: ScriptStyle;
  targetSeconds?: number;
}): ScriptGenerationResult {
  const topic = opts.topic.trim() || 'Секреты создания вирусного контента';
  const sec = opts.targetSeconds ?? 30;

  let hook = `Вы совершаете эту ошибку каждый день, когда речь заходит про ${topic}!`;
  let body = `Большинство людей тратят часы на лишние действия. Но секрет в том, чтобы сосредоточиться на трех простых шагах, которые дают восемьдесят процентов результата прямо сейчас.`;
  let cta = `Подпишитесь на канал, чтобы не пропустить продолжение в следующем ролике!`;

  if (opts.style === 'sales') {
    hook = `Ищете лучший способ решить вопрос с ${topic}? Досмотрите до конца.`;
    body = `Мы протестировали десятки вариантов и нашли решение, которое экономит ваше время и бюджет уже с первого дня использования.`;
    cta = `Переходите по ссылке в описании профиля и забирайте специальное предложение!`;
  } else if (opts.style === 'story') {
    hook = `Мало кто знает, с чего на самом деле началась история про ${topic}.`;
    body = `Сначала в это никто не верил, и казалось, что проект обречен на провал. Но одно нестандартное решение перевернуло абсолютно всё.`;
    cta = `Напишите в комментариях, как бы вы поступили в такой ситуации!`;
  } else if (opts.style === 'hype') {
    hook = `Шок! Это полностью изменит ваше представление про ${topic}!`;
    body = `То, что раньше казалось невозможным, теперь доступно каждому за считанные секунды. Смотрите, как это работает на практике.`;
    cta = `Ставьте лайк и делитесь этим видео с друзьями прямо сейчас!`;
  }

  const fullScript = sanitizeForVoiceover(`${hook} ${body} ${cta}`);

  return {
    hook,
    script: fullScript,
    title: topic.slice(0, 60),
    captions: [
      {
        caption: `${hook}\n\n${body}`,
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
  /**
   * Generate an engaging video voiceover script, hook, and social captions
   * using OpenRouter's free model cascade.
   */
  async generateScript(opts: {
    topic: string;
    style?: ScriptStyle;
    targetSeconds?: number;
    sourceTranscript?: string;
    productInfo?: string;
    language?: string;
    variantCount?: number;
  }): Promise<ScriptGenerationResult> {
    const isMock = !API_KEY || API_KEY.startsWith('mock_') || API_KEY.trim() === '';
    const style = opts.style || 'hype';
    const lang = opts.language || 'ru';
    const seconds = Math.max(10, Math.min(180, opts.targetSeconds ?? 30));
    const targetWords = Math.round(seconds * 2.4); // ~2.4 words per second
    const variantCount = Math.max(1, Math.min(10, opts.variantCount ?? 3));

    if (isMock) {
      logger.info(
        { topic: opts.topic, style },
        'OpenRouter: API key not set or mock mode, using smart heuristic script generator',
      );
      return generateMockScript({ topic: opts.topic, style, targetSeconds: seconds });
    }

    const systemPrompt = `Ты — лучший сценарист вирусных коротких видео (TikTok, Instagram Reels, YouTube Shorts).
Твоя задача — создать захватывающий сценарий для озвучки ролика на русском языке.

ПРАВИЛА ОЗВУЧКИ:
1. ХУК В ПЕРВЫЕ 3 СЕКУНДЫ: мгновенно цепляет внимание зрителя, создает интригу или задает парадоксальный вопрос.
2. ДИНАМИКА: короткие предложения, плотная подача без воды.
3. ТЕКСТ ДЛЯ ОЗВУЧКИ (script):
   - Только слова, которые диктор произносит вслух!
   - НИКАКИХ смайликов/эмодзи, сносок, ссылок, звездочек и решеток!
   - Все числа обязательно пиши СЛОВАМИ (например, "пять шагов", "двадцать шестой год", "сто тысяч рублей").
   - Точно уложись в объем: ${targetWords} слов (длительность ролика ~${seconds} сек).
4. Заверши сценарий коротким призывом к действию (CTA).

Ответ верни СТРОГО в формате JSON без какого-либо дополнительного текста вокруг:
{
  "hook": "первая фраза-крючок (до 8 слов)",
  "title": "цепляющий заголовок для ролика",
  "script": "полный текст для диктора с хуком и призывом",
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
      logger.info(
        { topic: opts.topic, style, targetWords },
        'OpenRouter: Calling API with free models cascade',
      );

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
            Authorization: `Bearer ${API_KEY}`,
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
        hook: parsed.hook || opts.topic,
        script: scriptClean,
        title: parsed.title || opts.topic,
        captions: Array.isArray(parsed.captions) && parsed.captions.length > 0
          ? parsed.captions
          : [{ caption: parsed.title || opts.topic, hashtags: ['#viral', '#reels', '#shorts'] }],
        modelUsed,
      };
    } catch (err: unknown) {
      const errMsg = axios.isAxiosError(err)
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data ?? err.message)}`
        : err instanceof Error ? err.message : String(err);

      logger.warn(
        { err: errMsg },
        'OpenRouter API failed or rate-limited; falling back to heuristic script generator',
      );
      return generateMockScript({ topic: opts.topic, style, targetSeconds: seconds });
    }
  }
}
