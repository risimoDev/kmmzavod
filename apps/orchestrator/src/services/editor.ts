/**
 * Client for the smart editor microservice (apps/editor).
 *
 * The editor is stateless like the publisher: the orchestrator owns the DB and
 * MinIO. It presigns each source (and any shared voiceover / BGM), sends them in,
 * and persists what the editor returns. Two phases:
 *   • analyze → per-source analysis + a proposed storyboard (EDL clips).
 *   • render  → final clip(s) for the user-confirmed, possibly-edited EDL.
 */
import axios from 'axios';
import { config } from '../config';

const BASE = config.EDITOR_URL.replace(/\/+$/, '');

export type EditGeometry = 'highlights' | 'mix';
export type EditMode = 'uniquify_source' | 'smart_montage';
export type EditAudioMode = 'keep' | 'replace';
export type EditAspect = '9:16' | '1:1' | '16:9' | '4:5';

export interface EdlSegment {
  src_idx: number;
  start: number;
  end: number;
  score: number;
}

export interface EdlClip {
  title: string;
  included: boolean;
  order: number;
  segments: EdlSegment[];
  transcript_snippet: string;
  thumb_b64?: string | null;
}

export interface SourceAnalysis {
  storage_key: string;
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  scene_breaks: number[];
  audio_energy: [number, number][];
  beats: number[];
  transcript: unknown[];
  face_ratio: number;
  motion_score: number;
}

export interface AnalyzeResult {
  projectId: string;
  sources: SourceAnalysis[];
  clips: EdlClip[];
}

export interface RenderedClip {
  title: string;
  output_key: string;
  thumbnail_key: string | null;
  duration_sec: number;
  width: number;
  height: number;
  file_size_bytes: number;
  phash: string | null;
  transcript: unknown[];
  scene_breaks: number[];
}

export interface RenderResult {
  projectId: string;
  clips: RenderedClip[];
}

/** Extract a precise message from an axios/other error (status + body). */
export function describeEditorError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { detail?: string } | string | undefined;
    const body = typeof data === 'string' ? data : data?.detail ?? err.message;
    return `HTTP ${status ?? '?'}: ${String(body).slice(0, 800)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export const editorService = {
  async analyze(opts: {
    projectId: string;
    tenantId: string;
    mode: EditMode;
    geometry: EditGeometry;
    sourceUrls: string[];
    useVision: boolean;
    targetClipCount: number;
    targetClipSeconds: number;
  }): Promise<AnalyzeResult> {
    const res = await axios.post(`${BASE}/analyze`, {
      project_id: opts.projectId,
      tenant_id: opts.tenantId,
      mode: opts.mode,
      geometry: opts.geometry,
      source_urls: opts.sourceUrls,
      use_vision: opts.useVision,
      target_clip_count: opts.targetClipCount,
      target_clip_seconds: opts.targetClipSeconds,
    }, { timeout: 1_800_000 }); // analysis (Whisper on long sources) can be slow
    return {
      projectId: res.data.project_id,
      sources: res.data.sources ?? [],
      clips: res.data.clips ?? [],
    };
  },

  async render(opts: {
    projectId: string;
    tenantId: string;
    mode: EditMode;
    outputKeyPrefix: string;
    sourceUrls: string[];
    clips: EdlClip[];
    aspect: EditAspect;
    fps: number;
    smartCrop: boolean;
    audioMode: EditAudioMode;
    subtitleStyle: string;
    voiceoverUrl?: string | null;
    bgmUrl?: string | null;
  }): Promise<RenderResult> {
    const res = await axios.post(`${BASE}/render`, {
      project_id: opts.projectId,
      tenant_id: opts.tenantId,
      mode: opts.mode,
      output_key_prefix: opts.outputKeyPrefix,
      source_urls: opts.sourceUrls,
      clips: opts.clips,
      aspect: opts.aspect,
      fps: opts.fps,
      smart_crop: opts.smartCrop,
      audio_mode: opts.audioMode,
      subtitle_style: opts.subtitleStyle,
      voiceover_url: opts.voiceoverUrl ?? null,
      bgm_url: opts.bgmUrl ?? null,
    }, { timeout: 3_600_000 }); // full render of multiple clips
    return {
      projectId: res.data.project_id,
      clips: res.data.clips ?? [],
    };
  },
};
