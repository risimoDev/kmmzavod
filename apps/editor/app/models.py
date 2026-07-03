"""Pydantic models for the editor service (smart cutting / montage).

Two products share one engine:
  • ``uniquify_source`` — cut/splice raw footage into SourceVideo material for the
    existing uniquification pipeline (subtitles off by default, original audio).
  • ``smart_montage``   — finished beautiful video: Whisper subtitles, LLM moment
    selection, smart-crop, transitions, music.

The API is two-phase:
  1. /analyze → probe + analyse sources → scored timeline + proposed EDL (storyboard).
  2. /render  → take a (possibly user-edited) EDL → render final clip(s) to MinIO.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


# ── Enums ─────────────────────────────────────────────────────────────────────

class EditMode(str, Enum):
    UNIQUIFY_SOURCE = "uniquify_source"   # raw material for the uniquify pipeline
    SMART_MONTAGE = "smart_montage"       # finished, subtitled, beautiful video


class Geometry(str, Enum):
    HIGHLIGHTS = "highlights"             # 1 long source → K non-overlapping clips
    MIX = "mix"                           # N sources → one assembled timeline


class AudioMode(str, Enum):
    KEEP = "keep"                         # keep original source audio (+ optional BGM)
    REPLACE = "replace"                   # replace with shared TTS voiceover + BGM


class AspectRatio(str, Enum):
    VERTICAL = "9:16"
    SQUARE = "1:1"
    LANDSCAPE = "16:9"
    PORTRAIT_4_5 = "4:5"

    def dimensions(self, base: int = 1080) -> tuple[int, int]:
        """Return (width, height) for this aspect at the given short-edge base."""
        mapping = {
            AspectRatio.VERTICAL: (1080, 1920),
            AspectRatio.SQUARE: (1080, 1080),
            AspectRatio.LANDSCAPE: (1920, 1080),
            AspectRatio.PORTRAIT_4_5: (1080, 1350),
        }
        return mapping[self]


class SubtitleStyle(str, Enum):
    NONE = "none"
    DEFAULT = "default"
    TIKTOK = "tiktok"
    CINEMATIC = "cinematic"
    MINIMAL = "minimal"


# ── Analysis data types ───────────────────────────────────────────────────────

class WordToken(BaseModel):
    start: float
    end: float
    text: str


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str
    words: list[WordToken] = []


class SourceAnalysis(BaseModel):
    """Per-source analysis output (also persisted to SourceVideo.* JSON fields)."""
    storage_key: str
    duration_sec: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 30.0
    scene_breaks: list[float] = []
    # RMS loudness envelope sampled over time: [(t_sec, level_0_1), ...]
    audio_energy: list[tuple[float, float]] = []
    # Beat timestamps (librosa), for rhythm-aware cutting.
    beats: list[float] = []
    transcript: list[TranscriptSegment] = []
    # Fraction of sampled frames containing a detectable face (0..1).
    face_ratio: float = 0.0
    # Average inter-frame motion score (0..1), higher = more dynamic.
    motion_score: float = 0.0
    # Time-series counterparts sampled at analysis_sample_fps: [(t_sec, v_0_1)].
    # These let the scorer discriminate moments WITHIN a source; the scalars
    # above stay as whole-source aggregates (and as fallback for old analyses).
    motion_series: list[tuple[float, float]] = []
    face_series: list[tuple[float, float]] = []


# ── Edit Decision List ────────────────────────────────────────────────────────

class EdlSegment(BaseModel):
    """One on-screen segment taken from a source."""
    src_idx: int = Field(ge=0)
    start: float = Field(ge=0)            # in-point in the source (seconds)
    end: float = Field(gt=0)             # out-point in the source (seconds)
    # Composite salience score for ranking / preview ordering (0..1).
    score: float = 0.0


class SubtitleWord(BaseModel):
    start: float
    end: float
    text: str


class SubtitleLine(BaseModel):
    """One subtitle line on the OUTPUT timeline of a clip. Proposed at analyze
    time from the source transcript; user-editable in the storyboard; consumed
    verbatim by the render (no re-transcription when present)."""
    start: float
    end: float
    text: str
    words: list[SubtitleWord] = []


class EdlClip(BaseModel):
    """A proposed/edited output clip = ordered list of segments + its own metadata."""
    title: str = ""
    included: bool = True
    order: int = 0
    segments: list[EdlSegment] = Field(min_length=1)
    # Transcript snippet shown in the storyboard preview (no proxy render).
    transcript_snippet: str = ""
    thumb_b64: str | None = None
    # Output-timeline subtitles (editable in the storyboard).
    subtitles: list[SubtitleLine] | None = None


# ── Requests / Responses ──────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    project_id: str
    tenant_id: str
    mode: EditMode = EditMode.SMART_MONTAGE
    geometry: Geometry = Geometry.HIGHLIGHTS
    # MinIO keys (orchestrator sends presigned URLs in production).
    source_urls: list[str] = Field(min_length=1)
    # Vision is opt-in (gpt-4o on top-candidate frames).
    use_vision: bool = False
    # Target number of clips for highlights mode.
    target_clip_count: int = Field(default=5, ge=1, le=30)
    # Target length of each output clip (seconds).
    target_clip_seconds: float = Field(default=30.0, gt=2, le=180)


class AnalyzeResponse(BaseModel):
    project_id: str
    sources: list[SourceAnalysis]
    clips: list[EdlClip]


class RenderRequest(BaseModel):
    project_id: str
    tenant_id: str
    mode: EditMode = EditMode.SMART_MONTAGE
    output_key_prefix: str               # e.g. tenants/<t>/editor/<project>/
    source_urls: list[str] = Field(min_length=1)
    clips: list[EdlClip] = Field(min_length=1)
    aspect: AspectRatio = AspectRatio.VERTICAL
    fps: int = Field(default=30, ge=15, le=60)
    smart_crop: bool = True
    audio_mode: AudioMode = AudioMode.KEEP
    subtitle_style: SubtitleStyle = SubtitleStyle.TIKTOK
    # Optional shared voiceover + BGM keys for audio_mode=replace.
    voiceover_url: str | None = None
    bgm_url: str | None = None


class RenderedClip(BaseModel):
    title: str
    output_key: str
    thumbnail_key: str | None = None
    duration_sec: float
    width: int
    height: int
    file_size_bytes: int
    phash: str | None = None
    quality_ok: bool = True
    quality_reason: str = ""
    transcript: list[TranscriptSegment] = []
    scene_breaks: list[float] = []


class RenderResponse(BaseModel):
    project_id: str
    clips: list[RenderedClip]
