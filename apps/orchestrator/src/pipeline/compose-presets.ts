// Compose preset templates — platform-specific editing styles for multi-variant video output.
// Each preset optimises transitions, subtitle rendering, and audio mixing for a target platform.

export interface ComposePreset {
  name: string;
  label: string;
  platform: 'tiktok' | 'instagram' | 'youtube' | 'vk';
  transition_type: 'fade' | 'smoothleft' | 'smoothright' | 'cut';
  transition_duration: number;
  subtitle_style: {
    font_color: string;
    font_size: number;
    outline_width: number;
    style: 'tiktok' | 'cinematic' | 'minimal' | 'default';
  };
  audio_preset: {
    bgm_volume: number;
    fade_in_sec: number;
    fade_out_sec: number;
  };
}

export const COMPOSE_PRESETS: Record<string, ComposePreset> = {
  tiktok: {
    name: 'tiktok',
    label: 'TikTok',
    platform: 'tiktok',
    transition_type: 'fade',
    transition_duration: 0.25,
    subtitle_style: {
      font_color: '#FFFFFF',
      font_size: 48,
      outline_width: 3,
      style: 'tiktok',
    },
    audio_preset: {
      bgm_volume: 0.20,
      fade_in_sec: 0.3,
      fade_out_sec: 0.8,
    },
  },

  instagram: {
    name: 'instagram',
    label: 'Instagram Reels',
    platform: 'instagram',
    transition_type: 'smoothleft',
    transition_duration: 0.5,
    subtitle_style: {
      font_color: '#F0F0F0',
      font_size: 42,
      outline_width: 2,
      style: 'cinematic',
    },
    audio_preset: {
      bgm_volume: 0.14,
      fade_in_sec: 1.0,
      fade_out_sec: 1.5,
    },
  },

  youtube: {
    name: 'youtube',
    label: 'YouTube Shorts',
    platform: 'youtube',
    transition_type: 'fade',
    transition_duration: 0.4,
    subtitle_style: {
      font_color: '#FFFFFF',
      font_size: 40,
      outline_width: 2,
      style: 'default',
    },
    audio_preset: {
      bgm_volume: 0.10,
      fade_in_sec: 1.0,
      fade_out_sec: 2.0,
    },
  },

  vk: {
    name: 'vk',
    label: 'VK Клипы',
    platform: 'vk',
    transition_type: 'cut',
    transition_duration: 0.15,
    subtitle_style: {
      font_color: '#FFFFFF',
      font_size: 44,
      outline_width: 3,
      style: 'tiktok',
    },
    audio_preset: {
      bgm_volume: 0.16,
      fade_in_sec: 0.5,
      fade_out_sec: 1.0,
    },
  },
} as const;

export const DEFAULT_VARIANT_PRESETS = ['tiktok', 'instagram', 'youtube', 'vk'] as const;

export type PresetName = keyof typeof COMPOSE_PRESETS;
