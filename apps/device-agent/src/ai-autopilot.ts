/**
 * AI-powered Autopilot advisor for phone automation (TikTok & Instagram).
 *
 * Uses ClaudeHub API (gemini-flash-3.8 / claude-haiku-5-5) with Vision + UI dump
 * analysis as an intelligent fallback whenever the deterministic state machine
 * encounters an unknown screen, unexpected popup, modal consent dialog, or
 * blocker.
 *
 * Standard screens continue to be processed instantly in 100-200ms by heuristic
 * rules (free, 0 latency). The AI steps in ONLY when the script gets stuck,
 * closing dialogs, picking targets, and preventing 3-minute timeouts.
 */
import axios from 'axios';
import type { Logger } from 'pino';
import { config } from './config';
import type { FlowPlatform, FlowState } from './publish-flow';
import type { UiEl, UiScreen } from './ui-automation';

export interface AiAutopilotInput {
  platform: FlowPlatform;
  deviceId: string;
  stage: string;
  st: FlowState;
  hasCaption: boolean;
  captionText?: string;
  screen: UiScreen;
  base64Screenshot?: string;
  screenSize: { width: number; height: number };
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  logger: Logger;
}

export type AiActionKind = 'tap' | 'tap_coord' | 'type_caption' | 'tap_draft' | 'retry_network' | 'key_back' | 'swipe_up' | 'abort' | 'require_human' | 'none';

export interface AiAutopilotDecision {
  screenType: 'modal_dialog' | 'editor' | 'compose' | 'share_target' | 'drafts' | 'network_error' | 'blocker' | 'feed' | 'other';
  action: AiActionKind;
  targetText?: string;
  x?: number;
  y?: number;
  marks?: 'next' | 'target' | 'share';
  reason: string;
}

/**
 * Cleanly extracts a JSON object from model output (even if wrapped in markdown blocks).
 */
export function extractJsonFromText<T>(text: string): T | null {
  try {
    const trimmed = text.trim();
    // First, test if it's already pure JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      return JSON.parse(trimmed) as T;
    }
    // Check for ```json ... ``` or ``` ... ```
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    }
    // Fallback: match outermost braces
    const braceMatch = trimmed.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      return JSON.parse(braceMatch[0]) as T;
    }
  } catch {
    // parse failed
  }
  return null;
}

/**
 * Builds a compact summary of visible interactive UI elements.
 */
function buildElementsSummary(screen: UiScreen): string {
  const visible = screen.els.filter(
    (e) => (e.text?.trim() || e.desc?.trim() || e.clickable) && e.bounds[2] > e.bounds[0] && e.bounds[3] > e.bounds[1]
  );

  return visible
    .slice(0, 45)
    .map((e, idx) => {
      const label = (e.text?.trim() || e.desc?.trim() || '').replace(/\s+/g, ' ');
      const id = e.resId ? e.resId.split('/').pop() : '';
      return `[${idx}] "${label}" id=${id || 'none'} bounds=[${e.bounds.join(',')}] click=${e.clickable}`;
    })
    .join('\n');
}

/**
 * Calls ClaudeHub API using OpenAI-compatible endpoint, falling back to Anthropic format if needed.
 */
export async function queryClaudeHubVision(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  base64Image?: string;
  logger: Logger;
}): Promise<string> {
  const { apiKey, baseUrl, model, systemPrompt, userPrompt, base64Image, logger } = params;
  const cleanBase = baseUrl.replace(/\/+$/, '');

  // 1. Try OpenAI-compatible endpoint (/v1/chat/completions or /chat/completions)
  const chatUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/chat/completions` : `${cleanBase}/v1/chat/completions`;

  const openAiUserContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: userPrompt },
  ];
  if (base64Image) {
    const imgUrl = base64Image.startsWith('data:') ? base64Image : `data:image/png;base64,${base64Image}`;
    openAiUserContent.push({
      type: 'image_url',
      image_url: { url: imgUrl },
    });
  }

  try {
    const res = await axios.post(
      chatUrl,
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: openAiUserContent },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
        maxBodyLength: 50 * 1024 * 1024,
        maxContentLength: 50 * 1024 * 1024,
      }
    );

    const content = res.data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
  } catch (err: any) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.warn({ status: err.response?.status, detail: errDetail, model }, 'claudehub: openAi chat/completions failed, trying Anthropic format');
  }

  // 2. Fallback: Anthropic messages endpoint
  const anthropicBase = cleanBase.replace(/\/v1$/, '');
  const messagesUrl = `${anthropicBase}/v1/messages`;

  const anthropicUserContent: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [
    { type: 'text', text: userPrompt },
  ];
  if (base64Image) {
    const rawData = base64Image.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
    anthropicUserContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: rawData },
    });
  }

  const res = await axios.post(
    messagesUrl,
    {
      model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: anthropicUserContent }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
      maxBodyLength: 50 * 1024 * 1024,
      maxContentLength: 50 * 1024 * 1024,
    }
  );

  const block = res.data?.content?.[0];
  const text = typeof block?.text === 'string' ? block.text : '';
  if (!text.trim()) {
    throw new Error(`ClaudeHub returned empty text response for model ${model}`);
  }
  return text.trim();
}

/**
 * Main AI advisor decision function.
 * Evaluates current unrecognized screen and returns an actionable decision.
 */
export async function consultAiAutopilot(input: AiAutopilotInput): Promise<AiAutopilotDecision | null> {
  const apiKey = input.apiKey || config.CLAUDEHUB_API_KEY || process.env.CLAUDEHUB_API_KEY;
  if (!apiKey || apiKey.startsWith('change_me')) {
    input.logger.warn({ deviceId: input.deviceId }, 'ai-autopilot: CLAUDEHUB_API_KEY is not configured — AI advice skipped. Set CLAUDEHUB_API_KEY in .env on Farm PC or server');
    return null;
  }

  const baseUrl = input.baseUrl || config.CLAUDEHUB_BASE_URL || process.env.CLAUDEHUB_BASE_URL || 'https://api.claudehub.fun/v1';
  const primaryModel = input.model || config.CLAUDEHUB_MODEL || process.env.CLAUDEHUB_VISION_MODEL || 'gemini-flash-3.8';
  const fallbackModel = 'claude-haiku-5-5';

  const elementsSummary = buildElementsSummary(input.screen);

  const systemPrompt = `Ты — автономный мобильный AI-ассистент автоматизации публикации видео в ${input.platform}.
Твоя цель: помочь скрипту преодолеть любой экран на телефоне (включая черновики, сбои сети, модальные окна) и гарантированно выложить ролик с правильным описанием.

ПРАВИЛА И СТРАТЕГИИ ПОВЕДЕНИЯ:

1. ЧЕРНОВИКИ / DRAFTS (ВОССТАНОВЛЕНИЕ НЕВЫЛОЖЕННОГО РОЛИКА):
   - Если открыт профиль, галерея или раздел черновиков, и виден пункт "Черновики" / "Drafts" (например "Drafts: 1", "Черновики: 1"):
     action = "tap" (targetText = "Черновики" / "Drafts") или "tap_coord" по плитке черновиков. marks = "target".
   - Если открыт список черновиков (список видео): нажми на первый (самый новый/верхний) черновик. action = "tap" или "tap_coord".
   - Если открылся видеоредактор черновика: нажми "Далее" / "Next" (marks = "next").
   - Если открылся экран публикации черновика: проверь подпись (если пустая — action = "type_caption"), и нажми "Опубликовать" / "Post" (marks = "share").

2. СЕТЕВЫЕ СБОИ И ПОВТОРЫ ЗАГРУЗКИ ("Network error" / "Ошибка сети"):
   - Если на экране ошибка сети ("Network error", "Не удалось загрузить", "Сохранено в черновиках", "Попробуйте позже"):
     - Если есть кнопка "Повторить" / "Retry" / "Попробовать снова" — action = "retry_network" (или "tap", targetText = "Повторить" / "Retry").
     - Если есть кнопка "ОК" / "Понятно" / "Закрыть" — action = "tap", targetText = "ОК" / "Понятно".

3. МОДАЛЬНЫЕ ОКНА / РАЗРЕШЕНИЯ / ОПРОСЫ / АКЦИИ:
   - Если открыто всплывающее окно (синхронизация контактов, запрос уведомлений, опрос, реклама, подтверждение):
     - Найди способ отклонить или закрыть: крестик [X], "Не сейчас", "Позже", "Отклонить", "Пропустить", "Don't allow", "Not now", "Dismiss", "Cancel", "OK".
     - Если диалог спрашивает "Сохранить в черновики или сбросить?" ("Save to drafts or discard?"):
       ВСЕГДА выбирай "Сохранить в черновики" ("Save to drafts" / "Keep editing"), НИКОГДА не удаляй/сбрасывай черновик!
     - action = "tap" (с targetText) или "tap_coord" (с x, y).

4. ВЫБОР ФОРМАТА / ШТОРКА (Share on TikTok, Reels vs Feed):
   - Если открыт выбор куда публиковать, выбери видеоленту ("Video", "Reels", "Feed").
   - marks = "target".

5. ВИДЕОРЕДАКТОР / КАМЕРА:
   - Если открыт редактор или камера с загруженным роликом, нажми "Next" / "Далее" / "Upload".
   - marks = "next".

6. ЭКРАН ПУБЛИКАЦИИ / ОПИСАНИЯ:
   - Если подпись еще не введена (${input.st.captionDone ? 'УЖЕ введена' : 'ЕЩЕ НЕ введена'}), и видно поле ввода описания — action = "type_caption".
   - Если подпись готова (или поле заполнено) и видна кнопка "Post" / "Опубликовать" / "Поделиться" / "Post now":
     нажми её! action = "tap", marks = "share".

7. БЛОКИРОВКИ / КРИТИЧЕСКИЕ ДЕЙСТВИЯ:
   - Если аккаунт заблокирован ("Account suspended", "Banned"), появилась капча-пазл со слайдером, или требуется SMS-код:
     action = "abort", укажи понятную причину в reason.
   - Если диалог требует опасных действий (удаление аккаунта, отвязка данных, сброс настроек):
     action = "require_human", reason = "Требуется подтверждение человека для критического действия на телефоне".

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON, без разметки markdown):
{
  "screenType": "modal_dialog" | "editor" | "compose" | "share_target" | "drafts" | "network_error" | "blocker" | "feed" | "other",
  "action": "tap" | "tap_coord" | "type_caption" | "tap_draft" | "retry_network" | "key_back" | "swipe_up" | "abort" | "require_human" | "none",
  "targetText": "текст или описание кнопки",
  "x": 540,
  "y": 1800,
  "marks": "next" | "target" | "share" | null,
  "reason": "Краткое объяснение на русском: что на экране и почему такое действие"
}`;

  const userPrompt = `Платформа: ${input.platform}
Разрешение экрана: ${input.screenSize.width}x${input.screenSize.height} px
Текущий пакет приложения: ${input.screen.pkg || 'unknown'}
Состояние публикации:
- Подпись введена: ${input.st.captionDone ? 'Да' : 'Нет'} (текст подписи: "${input.captionText || ''}")
- Целевая лента выбрана: ${input.st.targetChosen ? 'Да' : 'Нет'}
- Нажатий кнопки "Далее": ${input.st.nextTaps}

Видимые элементы экрана (текст, id, координаты):
${elementsSummary || '(список элементов пуст, ориентируйся на снимок экрана)'}

Что сейчас открыто на экране и какое действие нужно предпринять?`;

  const modelsToTry = [primaryModel, fallbackModel];

  for (const model of modelsToTry) {
    try {
      input.logger.info({ deviceId: input.deviceId, model, platform: input.platform }, 'ai-autopilot: querying ClaudeHub Vision advisor');
      const responseText = await queryClaudeHubVision({
        apiKey,
        baseUrl,
        model,
        systemPrompt,
        userPrompt,
        base64Image: input.base64Screenshot,
        logger: input.logger,
      });

      const parsed = extractJsonFromText<AiAutopilotDecision>(responseText);
      if (parsed && parsed.action) {
        input.logger.info(
          {
            deviceId: input.deviceId,
            action: parsed.action,
            target: parsed.targetText,
            coords: parsed.x && parsed.y ? [parsed.x, parsed.y] : undefined,
            reason: parsed.reason,
            model,
          },
          'ai-autopilot: decision received'
        );
        return parsed;
      }
    } catch (err: any) {
      input.logger.warn({ model, err: err.message }, 'ai-autopilot: model query failed, trying fallback');
    }
  }

  return null;
}
