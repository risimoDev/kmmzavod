/**
 * Curated Fish Audio voice catalogue (Russian). `gender` drives grammatical
 * agreement in generated scripts («заказал» vs «заказала»).
 */

export type VoiceGender = 'male' | 'female' | 'unknown';

export interface VoiceInfo {
  id: string;
  name: string;
  gender: VoiceGender;
  category: string;
  description: string;
  previewText: string;
}

export const FISH_VOICES: VoiceInfo[] = [
  {
    id: 'e04b4c73046f491c89366fbca39d48dd',
    name: 'Алексей — Энергичный блогер',
    gender: 'male',
    category: 'viral_reels',
    description: 'Быстрый темп, драйвовая подача. Шортсы, динамичный монтаж, юмор.',
    previewText: 'Смотри, это изменит твой контент навсегда! Досмотри ролик до конца.',
  },
  {
    id: 'c163098e986f4a8393c0bc5ff817cb23',
    name: 'Дмитрий — Глубокий нарратор',
    gender: 'male',
    category: 'storytelling',
    description: 'Бархатный баритон для историй, подкастов и кинематографичных видео.',
    previewText: 'Всё началось в тот день, когда привычные правила перестали работать.',
  },
  {
    id: '7f950853517c46a6b579fb65392fa9fa',
    name: 'Анна — Эксперт и бизнес',
    gender: 'female',
    category: 'business_expert',
    description: 'Чёткая дикция, уверенный тон для рекламы и обучающих роликов.',
    previewText: 'Главная ошибка большинства — это отсутствие системного подхода.',
  },
  {
    id: '5b2a0c4f3e6940be874bc05658e4a9e1',
    name: 'Елена — Лайфстайл и бьюти',
    gender: 'female',
    category: 'lifestyle',
    description: 'Мягкий доверительный голос для влогов, распаковок, моды.',
    previewText: 'Привет! Сегодня делюсь находками, которые вы так просили.',
  },
  {
    id: '8c12b7a9f6d34e10b9a8451f0c4e7d32',
    name: 'Артём — Хайп и драйв',
    gender: 'male',
    category: 'hype_gaming',
    description: 'Экспрессивный молодёжный тембр для челленджей и новостей.',
    previewText: 'Вы просто не поверите, что произошло дальше! Погнали!',
  },
];

export const DEFAULT_VOICE_ID = FISH_VOICES[0].id;

export function voiceById(id: string | null | undefined): VoiceInfo | undefined {
  return id ? FISH_VOICES.find((v) => v.id === id) : undefined;
}

export function voiceGender(id: string | null | undefined): VoiceGender {
  return voiceById(id)?.gender ?? 'unknown';
}
