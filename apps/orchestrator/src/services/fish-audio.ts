/**
 * Fish Audio TTS Service (s2.1-pro-free).
 * Official Docs: https://docs.fish.audio/overview/capabilities
 * Free Model: s2.1-pro-free (83+ languages, ~70ms TTFA, unlimited under Fair Use).
 */

import axios from 'axios';
import { config } from '../config';
import type { MinioStorageClient } from '@kmmzavod/storage';
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

/** Minimal valid silent MP3 frame sequence for mock/stub mode (~2 seconds). */
function createMockMp3Buffer(): Buffer {
  // A minimal valid MPEG-1 Layer III sync frame repeated to form ~2s of silence
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x64]); // 128kbps, 44.1kHz, Stereo
  const framePayload = Buffer.alloc(413, 0); // 417 bytes frame size total
  const singleFrame = Buffer.concat([frameHeader, framePayload]);
  const frames = [];
  for (let i = 0; i < 75; i++) {
    frames.push(singleFrame);
  }
  return Buffer.concat(frames);
}

export class FishAudioService {
  constructor(private storage: MinioStorageClient) {}

  /** List available curated voices. */
  listVoices(): FishAudioVoice[] {
    return FISH_AUDIO_VOICES;
  }

  /**
   * Synthesize text to speech using Fish Audio s2.1-pro-free model
   * and upload the resulting MP3 to MinIO storage.
   */
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
    const isMock = !effectiveKey || effectiveKey.startsWith('mock_');
    const voiceId = opts.voiceId || DEFAULT_FISH_VOICE_ID;
    const speed = Math.max(0.5, Math.min(2.0, opts.speed ?? 1.0));
    const volume = Math.max(-20, Math.min(20, opts.volume ?? 0));

    let audioBuffer: Buffer;

    if (isMock) {
      if (opts.allowMock) {
        logger.warn(
          { voiceId, textLength: opts.text.length },
          'FishAudio: Key not configured, generating placeholder audio in mock mode.',
        );
        audioBuffer = createMockMp3Buffer();
      } else {
        throw new Error(
          'FISH_AUDIO_API_KEY_MISSING: FISH_AUDIO_API_KEY is not configured on the server.',
        );
      }
    } else {
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

      try {
        logger.info(
          { voiceId: payload.reference_id, speed, volume, textLen: opts.text.length },
          'FishAudio: Requesting TTS via s2.1-pro-free',
        );

        let res;
        try {
          res = await axios.post(`${BASE_URL}/tts`, payload, {
            headers,
            responseType: 'arraybuffer',
            timeout: 120_000,
          });
        } catch (firstErr: unknown) {
          if (axios.isAxiosError(firstErr) && (firstErr.response?.status === 400 || firstErr.response?.status === 404) && payload.reference_id) {
            logger.warn({ voiceId: payload.reference_id }, 'FishAudio TTS: Voice not found, retrying with base default voice');
            delete payload.reference_id;
            try {
              res = await axios.post(`${BASE_URL}/tts`, payload, {
                headers,
                responseType: 'arraybuffer',
                timeout: 120_000,
              });
            } catch (retryVoiceErr) {
              headers.model = 's2.1-pro';
              res = await axios.post(`${BASE_URL}/tts`, payload, {
                headers,
                responseType: 'arraybuffer',
                timeout: 120_000,
              });
            }
          } else if (axios.isAxiosError(firstErr) && (firstErr.response?.status === 400 || firstErr.response?.status === 404) && headers.model === 's2.1-pro-free') {
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
      } catch (err: unknown) {
        const errMsg = axios.isAxiosError(err)
          ? `HTTP ${err.response?.status}: ${Buffer.isBuffer(err.response?.data) ? err.response.data.toString() : JSON.stringify(err.response?.data ?? err.message)}`
          : err instanceof Error ? err.message : String(err);

        logger.error({ err: errMsg }, 'FishAudio TTS failed');
        throw new Error(`Fish Audio TTS failed: ${errMsg}`);
      }
    }

    const key = opts.destinationKey;
    await this.storage.uploadBuffer(key, audioBuffer, { contentType: 'audio/mpeg' });
    logger.info({ key, bytes: audioBuffer.length }, 'FishAudio: Voiceover uploaded to MinIO');

    return {
      storageKey: key,
      cost: 0, // s2.1-pro-free is free
    };
  }
}
