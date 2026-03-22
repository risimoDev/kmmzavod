// Compose preset templates — define editing styles for multi-variant video output.
// Each preset controls transitions, subtitle rendering, and audio mixing.

export interface ComposePreset {
  name: string;
  label: string;
  transition_type: 'fade' | 'smoothleft' | 'dissolve' | 'cut';
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
  dynamic: {
    name: 'dynamic',
    label: 'Динамичный',
    transition_type: 'fade',
    transition_duration: 0.3,
    subtitle_style: {
      font_color: '#FFFFFF',
      font_size: 48,
      outline_width: 3,
      style: 'tiktok',
    },
    audio_preset: {
      bgm_volume: 0.18,
      fade_in_sec: 0.5,
      fade_out_sec: 1.0,
    },
  },

  smooth: {
    name: 'smooth',
    label: 'Плавный',
    transition_type: 'dissolve',
    transition_duration: 0.5,
    subtitle_style: {
      font_color: '#F0F0F0',
      font_size: 42,
      outline_width: 2,
      style: 'cinematic',
    },
    audio_preset: {
      bgm_volume: 0.12,
      fade_in_sec: 1.5,
      fade_out_sec: 2.0,
    },
  },

  minimal: {
    name: 'minimal',
    label: 'Минимальный',
    transition_type: 'cut',
    transition_duration: 0,
    subtitle_style: {
      font_color: '#E0E0E0',
      font_size: 36,
      outline_width: 0,
      style: 'minimal',
    },
    audio_preset: {
      bgm_volume: 0.08,
      fade_in_sec: 1.0,
      fade_out_sec: 1.5,
    },
  },
} as const;

export const DEFAULT_VARIANT_PRESETS = ['dynamic', 'smooth', 'minimal'] as const;

export type PresetName = keyof typeof COMPOSE_PRESETS;
