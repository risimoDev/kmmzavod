/**
 * Fish Audio TTS client.
 *
 * Unlike the previous services, a missing/foreign voice is an ERROR, not a
 * silent swap to the default voice — a project that chose «Анна» must never
 * get a male narrator without anyone noticing. Model fallback (free → paid
 * tier) is allowed and reported in the result.
 */
import type { FetchLike } from './llm';
import { mp3DurationSec } from './mp3';
import { stripEmotionTags, countWords, sanitizeForVoiceover } from './text';
import type { VoiceGender, VoiceInfo } from './voices';

export const DEFAULT_FISH_MODELS = ['s2.1-pro-free', 's2.1-pro'];

export class FishError extends Error {
  constructor(message: string, public kind: 'no_key' | 'voice_not_found' | 'quota' | 'http' | 'empty') {
    super(message);
    this.name = 'FishError';
  }
}

export interface FishConfig {
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface TtsResult {
  audio: Buffer;
  durationSec: number;
  model: string;
  words: number;
  /** Measured spoken words per second (for pace calibration). */
  wps: number;
}

export async function fishTts(cfg: FishConfig, opts: {
  text: string; voiceId?: string | null; speed?: number; volume?: number;
}): Promise<TtsResult> {
  if (!cfg.apiKey || cfg.apiKey.startsWith('mock_')) {
    throw new FishError('Не задан ключ Fish Audio (Админ → Настройки → FISH_AUDIO_API_KEY)', 'no_key');
  }
  const text = sanitizeForVoiceover(opts.text);
  if (!stripEmotionTags(text)) throw new FishError('Пустой текст для озвучки', 'empty');

  const base = (cfg.baseUrl || 'https://api.fish.audio/v1').replace(/\/+$/, '');
  const doFetch = cfg.fetch ?? ((u, i) => fetch(u, i));
  const models = cfg.models?.length ? cfg.models : DEFAULT_FISH_MODELS;
  const payload: Record<string, unknown> = {
    text,
    format: 'mp3',
    prosody: { speed: clamp(opts.speed ?? 1, 0.5, 2), volume: clamp(opts.volume ?? 0, -20, 20) },
    normalize: true,
    latency: 'balanced',
    ...(opts.voiceId ? { reference_id: opts.voiceId } : {}),
  };

  let lastErr = '';
  let notFound = 0;
  for (const model of models) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 120_000);
    try {
      const res = await doFetch(`${base}/tts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', model },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const audio = Buffer.from(await res.arrayBuffer());
        if (audio.length < 1000) throw new FishError('Fish Audio вернул пустой звук', 'empty');
        const durationSec = mp3DurationSec(audio);
        const words = countWords(text);
        return { audio, durationSec, model, words, wps: durationSec > 0 ? words / durationSec : 0 };
      }
      const body = (await res.text()).slice(0, 300);
      lastErr = `HTTP ${res.status}: ${body}`;
      if (res.status === 401 || res.status === 403) throw new FishError(`Ключ Fish Audio отклонён (${lastErr})`, 'http');
      if (res.status === 402 || /balance|quota|credit/i.test(body)) throw new FishError(`Fish Audio: закончился баланс/квота (${lastErr})`, 'quota');
      if (res.status === 400 || res.status === 404) notFound++;
      // Try the next model (e.g. the free tier rejected this one).
    } catch (e) {
      if (e instanceof FishError) throw e;
      lastErr = (e as Error).name === 'AbortError' ? 'таймаут' : (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }
  // Every model rejected the request as not found → the voice is the problem.
  // Never fall back to another voice silently.
  if (opts.voiceId && notFound === models.length) {
    throw new FishError(`Голос ${opts.voiceId} не найден в Fish Audio или недоступен — выберите другой (${lastErr})`, 'voice_not_found');
  }
  throw new FishError(`Fish Audio TTS не удался: ${lastErr}`, 'http');
}

/** Public voice search (fish.audio model library). Gender is often unknown there. */
export async function fishSearchVoices(cfg: FishConfig, query: { title?: string; language?: string; pageSize?: number }): Promise<VoiceInfo[]> {
  const base = (cfg.baseUrl || 'https://api.fish.audio/v1').replace(/\/+$/, '').replace(/\/v1$/, '');
  const doFetch = cfg.fetch ?? ((u, i) => fetch(u, i));
  const params = new URLSearchParams({ page_size: String(query.pageSize ?? 20) });
  if (query.title) params.set('title', query.title);
  if (query.language) params.set('language', query.language);
  const res = await doFetch(`${base}/model?${params}`, { method: 'GET', headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  if (!res.ok) throw new FishError(`Поиск голосов: HTTP ${res.status}`, 'http');
  const json: any = await res.json();
  const items: any[] = json?.items ?? (Array.isArray(json) ? json : []);
  return items.map((m) => ({
    id: String(m._id ?? m.id),
    name: String(m.title ?? m.name ?? 'Без названия'),
    gender: (m.gender === 'female' || m.gender === 'male' ? m.gender : 'unknown') as VoiceGender,
    category: 'community',
    description: String(m.description ?? '').slice(0, 200),
    previewText: String(m.sample_text ?? ''),
  }));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
