/**
 * LLM provider chain — one place that knows how to get a JSON answer out of a
 * chat model, trying providers in order until one returns parseable JSON.
 *
 *   OpenRouter (configurable model list, its own server-side fallback via `models`)
 *     → GPTunnel (OpenAI-compatible, reachable from RU networks)
 *
 * Dependency-free: uses an injected `fetch` so callers can route through their
 * proxy (AI_PROXY_URL) without this package knowing about agents.
 */
import { extractJson } from './text';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LlmProvider {
  name: 'openrouter' | 'gptunnel' | string;
  baseUrl: string;
  apiKey: string;
  /** Models tried by this provider (OpenRouter receives them all as `models`). */
  models: string[];
  /** GPTunnel expects the raw key in Authorization; OpenRouter a Bearer token. */
  authScheme?: 'bearer' | 'raw';
  /** OpenAI `response_format: json_object` — supported by GPTunnel/OpenAI models. */
  jsonMode?: boolean;
}

export interface ChatJsonResult<T = any> {
  data: T;
  provider: string;
  model: string;
}

export class LlmUnavailableError extends Error {
  constructor(public attempts: string[]) {
    super(attempts.length
      ? `Все AI-провайдеры недоступны: ${attempts.join(' | ')}`
      : 'Не настроен ни один AI-провайдер (OPENROUTER_API_KEY / GPTUNNEL_API_KEY)');
    this.name = 'LlmUnavailableError';
  }
}

export const DEFAULT_OPENROUTER_MODELS = [
  'google/gemini-2.0-flash-001',
  'openai/gpt-4o-mini',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
];
export const DEFAULT_GPTUNNEL_MODEL = 'gpt-4o-mini';

export class LlmChain {
  constructor(
    private providers: LlmProvider[],
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private timeoutMs = 60_000,
  ) {}

  get configured(): boolean {
    return this.providers.some((p) => p.apiKey);
  }

  get providerNames(): string[] {
    return this.providers.filter((p) => p.apiKey).map((p) => p.name);
  }

  async chatJson<T = any>(system: string, user: string, opts: {
    temperature?: number; maxTokens?: number;
  } = {}): Promise<ChatJsonResult<T>> {
    const attempts: string[] = [];
    for (const p of this.providers) {
      if (!p.apiKey) continue;
      try {
        const { content, model } = await this.call(p, system, user, opts);
        try {
          return { data: extractJson(content) as T, provider: p.name, model };
        } catch {
          attempts.push(`${p.name}: ответ не JSON`);
        }
      } catch (e) {
        attempts.push(`${p.name}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    throw new LlmUnavailableError(attempts);
  }

  private async call(p: LlmProvider, system: string, user: string, opts: {
    temperature?: number; maxTokens?: number;
  }): Promise<{ content: string; model: string }> {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: opts.temperature ?? 0.8,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(p.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    if (p.name === 'openrouter' && p.models.length > 1) body.models = p.models;
    else body.model = p.models[0];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: p.authScheme === 'raw' ? p.apiKey : `Bearer ${p.apiKey}`,
          'Content-Type': 'application/json',
          ...(p.name === 'openrouter' ? { 'HTTP-Referer': 'https://kmmzavod.local', 'X-Title': 'KMM Zavod' } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      const content: string = json?.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) throw new Error('пустой ответ модели');
      return { content, model: json?.model ?? String(body.model ?? p.models[0]) };
    } finally {
      clearTimeout(timer);
    }
  }
}
