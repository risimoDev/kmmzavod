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

  async ttsCreate(opts: {
    text: string;
    voiceId?: string;
    speed?: number;
    volume?: number;
    tenantId: string;
    destinationKey: string;
  }): Promise<{ storageKey: string; cost: number }> {
    const isMock = !API_KEY || API_KEY.startsWith('mock_') || API_KEY.trim() === '';
    const voiceId = opts.voiceId || DEFAULT_FISH_VOICE_ID;
    const speed = Math.max(0.5, Math.min(2.0, opts.speed ?? 1.0));
    const volume = Math.max(-20, Math.min(20, opts.volume ?? 0));

    let audioBuffer: Buffer;

    if (isMock) {
      logger.warn(
        { voiceId, textLength: opts.text.length },
        'FishAudio (api): Key not set or mock mode. Generating placeholder audio.',
      );
      audioBuffer = createMockMp3Buffer();
    } else {
      try {
        const res = await axios.post(
          `${BASE_URL}/tts`,
          {
            text: opts.text,
            reference_id: voiceId,
            format: 'mp3',
            prosody: { speed, volume },
          },
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              'Content-Type': 'application/json',
              model: 's2.1-pro-free',
            },
            responseType: 'arraybuffer',
            timeout: 120_000,
          },
        );
        audioBuffer = Buffer.from(res.data);
      } catch (err: unknown) {
        const errMsg = axios.isAxiosError(err)
          ? `HTTP ${err.response?.status}: ${Buffer.isBuffer(err.response?.data) ? err.response.data.toString() : JSON.stringify(err.response?.data ?? err.message)}`
          : err instanceof Error ? err.message : String(err);

        logger.error({ err: errMsg }, 'FishAudio TTS failed, falling back to mock placeholder');
        audioBuffer = createMockMp3Buffer();
      }
    }

    const key = opts.destinationKey;
    await this.storage.uploadBuffer(key, audioBuffer, { contentType: 'audio/mpeg' });
    return {
      storageKey: key,
      cost: 0,
    };
  }
}
