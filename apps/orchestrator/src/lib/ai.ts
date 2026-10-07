/**
 * Server-side AI configuration for the orchestrator (autopilot).
 *
 * Keys and model lists live in AdminSetting (Админ → Настройки → «Провайдеры AI»)
 * with env fallback — never in the browser. All AI traffic goes through the
 * AI_PROXY_URL proxy when one is configured.
 */
import {
  LlmChain, DEFAULT_OPENROUTER_MODELS, DEFAULT_GPTUNNEL_MODEL, DEFAULT_FISH_MODELS,
  observePace, type FishConfig, type PaceTable,
} from '@kmmzavod/ai';
import { db } from './db';
import { config } from '../config';
import { proxyFetch } from './proxy';

const KEYS = [
  'OPENROUTER_API_KEY', 'OPENROUTER_MODELS', 'GPTUNNEL_API_KEY', 'GPTUNNEL_TEXT_MODEL',
  'FISH_AUDIO_API_KEY', 'FISH_AUDIO_MODELS',
] as const;

async function settings(): Promise<Record<string, string>> {
  const rows = await db.adminSetting.findMany({ where: { key: { in: [...KEYS] } } }).catch(() => []);
  const out: Record<string, string> = {};
  for (const r of rows) {
    const v = typeof r.value === 'string' ? r.value : r.value != null ? String(r.value) : '';
    if (v.trim()) out[r.key] = v.trim();
  }
  return out;
}

const list = (v: string | undefined, d: string[]) =>
  v ? v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : d;
const realKey = (v: string | undefined) => (v && !v.startsWith('mock_') ? v : '');
const aiFetch = (url: string, init: RequestInit) => proxyFetch(url, init);

export async function getLlm(): Promise<LlmChain> {
  const s = await settings();
  return new LlmChain([
    {
      name: 'openrouter',
      baseUrl: config.OPENROUTER_BASE_URL,
      apiKey: realKey(s.OPENROUTER_API_KEY ?? config.OPENROUTER_API_KEY),
      models: list(s.OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODELS),
    },
    {
      name: 'gptunnel',
      baseUrl: config.GPTUNNEL_BASE_URL,
      apiKey: realKey(s.GPTUNNEL_API_KEY ?? config.GPTUNNEL_API_KEY),
      models: [s.GPTUNNEL_TEXT_MODEL ?? DEFAULT_GPTUNNEL_MODEL],
      authScheme: 'raw',
      jsonMode: true,
    },
  ], aiFetch);
}

export async function getFishConfig(): Promise<FishConfig> {
  const s = await settings();
  return {
    apiKey: realKey(s.FISH_AUDIO_API_KEY ?? config.FISH_AUDIO_API_KEY),
    baseUrl: config.FISH_AUDIO_BASE_URL,
    models: list(s.FISH_AUDIO_MODELS, DEFAULT_FISH_MODELS),
    fetch: aiFetch,
  };
}

export async function aiStatus() {
  const [llm, fish] = await Promise.all([getLlm(), getFishConfig()]);
  const s = await settings();
  return {
    llmProviders: llm.providerNames,
    openrouter: llm.providerNames.includes('openrouter'),
    gptunnel: llm.providerNames.includes('gptunnel'),
    fishAudio: Boolean(fish.apiKey),
    openrouterModels: list(s.OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODELS),
    fishModels: fish.models,
  };
}

// ── Speech pace calibration (shared with the orchestrator via AdminSetting) ──

export async function getPaceTable(): Promise<PaceTable> {
  const row = await db.adminSetting.findUnique({ where: { key: 'VOICE_PACE' } }).catch(() => null);
  return (row?.value && typeof row.value === 'object' ? row.value : {}) as unknown as PaceTable;
}

export async function recordPace(voiceId: string | null | undefined, speed: number, words: number, seconds: number): Promise<void> {
  const next = observePace(await getPaceTable(), voiceId, speed, words, seconds);
  await db.adminSetting.upsert({
    where: { key: 'VOICE_PACE' },
    create: { key: 'VOICE_PACE', value: next as object, description: 'Калибровка темпа речи голосов (слов/сек), обновляется автоматически' },
    update: { value: next as object },
  }).catch(() => {});
}
