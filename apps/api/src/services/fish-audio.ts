/**
 * Fish Audio TTS Service for apps/api.
 * Model: s2.1-pro-free
 * Official Docs: https://docs.fish.audio/overview/capabilities
 */

import axios from 'axios';
import { config } from '../config';
import type { IStorageClient } from '@kmmzavod/storage';
import { logger } from '../logger';

const BASE_URL = (config.FISH_AUDIO_BASE_URL || 'https://api.fish.audio/v1').replace(/\/+$/, '');
const API_KEY = config.FISH_AUDIO_API_KEY || '';

export interface FishAudioVoice {
  id: string;
  name: string;
  gender: 'male' | 'female';
  category: 'viral_reels' | 'storytelling' | 'business_expert' | 'lifestyle' | 'hype_gaming';
  description: string;
  previewText: string;
}

export const FISH_AUDIO_VOICES: FishAudioVoice[] = [
  {
    id: 'e04b4c73046f491c89366fbca39d48dd',
    name: 'Алексей — Энергичный блогер',
    gender: 'male',
    category: 'viral_reels',
    description: 'Быстрый темп, драйвовая подача. Идеален для шортсов, динамичного монтажа и юмора.',
    previewText: 'Смотри, это изменит твой контент навсегда! Досмотри ролик до конца.',
  },
  {
    id: 'c163098e986f4a8393c0bc5ff817cb23',
    name: 'Дмитрий — Глубокий нарратор',
    gender: 'male',
    category: 'storytelling',
    description: 'Глубокий бархатный баритон для историй, документалок, подкастов и кинематографичных видео.',
    previewText: 'Всё началось в тот день, когда привычные правила перестали работать.',
  },
  {
    id: '7f950853517c46a6b579fb65392fa9fa',
    name: 'Анна — Эксперт и бизнес',
    gender: 'female',
    category: 'business_expert',
    description: 'Четкая дикция, уверенный презентабельный тон для рекламы, инфобизнеса и обучающих роликов.',
    previewText: 'Главная ошибка большинства предпринимателей — это отсутствие системного подхода.',
  },
  {
    id: '5b2a0c4f3e6940be874bc05658e4a9e1',
    name: 'Елена — Лайфстайл и бьюти',
    gender: 'female',
    category: 'lifestyle',
    description: 'Мягкий, доверительный голос для влогов, распаковок, моды и путешествий.',
    previewText: 'Привет! Сегодня делюсь своими любимыми находками, которые вы так просили.',
  },
  {
    id: '8c12b7a9f6d34e10b9a8451f0c4e7d32',
    name: 'Артём — Хайп и драйв',
    gender: 'male',
    category: 'hype_gaming',
    description: 'Экспрессивный, молодежный тембр для игр, челленджей и новостей.',
    previewText: 'Вы просто не поверите, что произошло дальше! Ставьте лайк и погнали!',
  },
];

export const DEFAULT_FISH_VOICE_ID = 'e04b4c73046f491c89366fbca39d48dd';

function createMockMp3Buffer(): Buffer {
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const framePayload = Buffer.alloc(413, 0);
  const singleFrame = Buffer.concat([frameHeader, framePayload]);
  const frames = [];
  for (let i = 0; i < 75; i++) {
    frames.push(singleFrame);
  }
  return Buffer.concat(frames);
}

export class FishAudioService {
  constructor(private storage: IStorageClient) {}

  listVoices(): FishAudioVoice[] {
    return FISH_AUDIO_VOICES;
  }

  async searchPublicVoices(opts?: { apiKey?: string; query?: string; language?: string }): Promise<FishAudioVoice[]> {
    const key = (opts?.apiKey || API_KEY || '').trim();
    if (!key || key.startsWith('mock_')) {
      return FISH_AUDIO_VOICES;
    }
    try {
      const params = new URLSearchParams();
      params.set('page_size', '20');
      if (opts?.language) params.set('language', opts.language);
      if (opts?.query) params.set('title', opts.query);

      const res = await axios.get(`${BASE_URL}/model?${params.toString()}`, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 15_000,
      });

      const items = res.data?.items || res.data || [];
      if (Array.isArray(items) && items.length > 0) {
        return items.map((m: any) => ({
          id: m._id || m.id,
          name: m.title || m.name || 'Без названия',
          gender: (m.gender === 'female' ? 'female' : 'male') as 'male' | 'female',
          category: 'viral_reels' as const,
          description: m.description || `Голос Fish Audio (${(m.languages || []).join(', ') || 'ru'})`,
          previewText: m.sample_text || 'Пример звучания голоса',
        }));
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'Failed to fetch public voices from Fish Audio, using fallback list');
    }
    return FISH_AUDIO_VOICES;
  }

  async ttsCreate(opts: {
    text: string;
    voiceId?: string;
    speed?: number;
    volume?: number;
    tenantId: string;
    destinationKey: string;
    apiKey?: string;
    allowMock?: boolean;
  }): Promise<{ storageKey: string; cost: number }> {
    const effectiveKey = (opts.apiKey || API_KEY || '').trim();
    const isMockKey = !effectiveKey || effectiveKey.startsWith('mock_');

    if (isMockKey) {
      if (opts.allowMock) {
        logger.warn(
          { textLength: opts.text.length },
          'FishAudio: Using mock audio generation as explicitly permitted.',
        );
        const audioBuffer = createMockMp3Buffer();
        const key = opts.destinationKey;
        await this.storage.uploadBuffer(key, audioBuffer, { contentType: 'audio/mpeg' });
        return { storageKey: key, cost: 0 };
      }
      throw new Error(
        'FISH_AUDIO_API_KEY_MISSING: API-ключ Fish Audio не указан. ' +
        'Получите бесплатный ключ на https://fish.audio/ и укажите его в настройках или окне озвучки.'
      );
    }

    const voiceId = opts.voiceId || DEFAULT_FISH_VOICE_ID;
    const speed = Math.max(0.5, Math.min(2.0, opts.speed ?? 1.0));
    const volume = Math.max(-20, Math.min(20, opts.volume ?? 0));

    const headers: Record<string, string> = {
      Authorization: `Bearer ${effectiveKey}`,
      'Content-Type': 'application/json',
      model: 's2.1-pro-free',
    };

    const payload: Record<string, any> = {
      text: opts.text,
      format: 'mp3',
      prosody: { speed, volume },
      normalize: true,
      latency: 'balanced',
    };

    if (voiceId && !voiceId.startsWith('mock_')) {
      payload.reference_id = voiceId;
    }

    let audioBuffer: Buffer;

    try {
      logger.info({ voiceId: payload.reference_id, textLen: opts.text.length }, 'FishAudio TTS: Sending request');
      let res;
      try {
        res = await axios.post(`${BASE_URL}/tts`, payload, {
          headers,
          responseType: 'arraybuffer',
          timeout: 120_000,
        });
      } catch (firstErr: unknown) {
        // Fallback 1: If 404/400 and custom voice was passed, retry with base default voice
        if (axios.isAxiosError(firstErr) && (firstErr.response?.status === 400 || firstErr.response?.status === 404) && payload.reference_id) {
          logger.warn(
            { voiceId: payload.reference_id, status: firstErr.response?.status },
            'FishAudio TTS: Voice ID failed or not found, retrying with default base voice',
          );
          delete payload.reference_id;
          try {
            res = await axios.post(`${BASE_URL}/tts`, payload, {
              headers,
              responseType: 'arraybuffer',
              timeout: 120_000,
            });
          } catch (retryVoiceErr) {
            // Fallback 2: retry with model 's2.1-pro'
            headers.model = 's2.1-pro';
            res = await axios.post(`${BASE_URL}/tts`, payload, {
              headers,
              responseType: 'arraybuffer',
              timeout: 120_000,
            });
          }
        } else if (axios.isAxiosError(firstErr) && (firstErr.response?.status === 400 || firstErr.response?.status === 404) && headers.model === 's2.1-pro-free') {
          // Fallback 2: Try standard model 's2.1-pro'
          logger.warn('FishAudio TTS: s2.1-pro-free header failed, retrying with s2.1-pro');
          headers.model = 's2.1-pro';
          res = await axios.post(`${BASE_URL}/tts`, payload, {
            headers,
            responseType: 'arraybuffer',
            timeout: 120_000,
          });
        } else {
          throw firstErr;
        }
      }

      audioBuffer = Buffer.from(res.data);
      if (audioBuffer.length < 500) {
        throw new Error(`FishAudio returned abnormally small audio payload (${audioBuffer.length} bytes)`);
      }
    } catch (err: unknown) {
      const errMsg = axios.isAxiosError(err)
        ? `HTTP ${err.response?.status}: ${Buffer.isBuffer(err.response?.data) ? err.response.data.toString() : JSON.stringify(err.response?.data ?? err.message)}`
        : err instanceof Error ? err.message : String(err);

      logger.error({ err: errMsg }, 'FishAudio TTS generation failed');
      throw new Error(`Ошибка Fish Audio: ${errMsg}`);
    }

    const key = opts.destinationKey;
    await this.storage.uploadBuffer(key, audioBuffer, { contentType: 'audio/mpeg' });
    logger.info({ key, bytes: audioBuffer.length }, 'FishAudio: Voiceover successfully generated and saved');
    return {
      storageKey: key,
      cost: 0,
    };
  }
}
