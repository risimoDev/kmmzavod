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


class Pace(str, Enum):
    """Cut rhythm of a mix montage (on-screen chunk length range)."""
    CALM = "calm"                         # 2.4–5.0 s per shot
    NORMAL = "normal"                     # 1.6–3.6 s
    FAST = "fast"                         # 1.0–2.4 s


# Bump when SourceAnalysis semantics change: cached analyses with an older
# version are recomputed instead of reused.
ANALYSIS_VERSION = 2


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
    MRBEAST = "mrbeast"
    NEON_GLOW = "neon_glow"
    FIRE_HYPE = "fire_hype"
    SINGLE_WORD = "single_word"


# ── Analysis data types ───────────────────────────────────────────────────────

class WordToken(BaseModel):
    start: float = 0.0
    end: float = 0.0
    text: str = ""


class TranscriptSegment(BaseModel):
    start: float = 0.0
    end: float = 0.0
    text: str = ""
    words: list[WordToken] = Field(default_factory=list)


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
    # Why the transcript is empty (Whisper broken / no audio / no speech) —
    # surfaced to the UI so missing subtitles are explainable, not silent.
    transcript_error: str | None = None
    # Fraction of sampled frames containing a detectable face (0..1).
    face_ratio: float = 0.0
    # Average inter-frame motion score (0..1), higher = more dynamic.
    motion_score: float = 0.0
    # Time-series counterparts sampled at analysis_sample_fps: [(t_sec, v_0_1)].
    # These let the scorer discriminate moments WITHIN a source; the scalars
    # above stay as whole-source aggregates (and as fallback for old analyses).
    motion_series: list[tuple[float, float]] = []
    face_series: list[tuple[float, float]] = []
    # Cache bookkeeping: analyses are reused across projects by storage key.
    analysis_version: int = ANALYSIS_VERSION
    # False when Whisper was deliberately skipped (voiceover projects don't need
    # source speech) — a later keep-audio project must re-run the transcript.
    transcribed: bool = False


# ── Edit Decision List ────────────────────────────────────────────────────────

class EdlSegment(BaseModel):
    """One on-screen segment taken from a source."""
    src_idx: int = Field(ge=0)
    start: float = Field(ge=0)            # in-point in the source (seconds)
    end: float = Field(gt=0)             # out-point in the source (seconds)
    # Composite salience score for ranking / preview ordering (0..1).
    score: float = 0.0


class SubtitleWord(BaseModel):
    start: float = 0.0
    end: float = 0.0
    text: str = ""


class SubtitleLine(BaseModel):
    """One subtitle line on the OUTPUT timeline of a clip. Proposed at analyze
    time from the source transcript; user-editable in the storyboard; consumed
    verbatim by the render (no re-transcription when present)."""
    start: float = 0.0
    end: float = 0.0
    text: str = ""
    words: list[SubtitleWord] | None = Field(default_factory=list)


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
    # Join segments with xfade transitions (mix with replaced audio) or hard cuts
    # (speech-preserving). Persisted in the EDL so the render never has to guess
    # from the title. None = legacy EDL → render infers.
    transitions: bool | None = None
    # Human-readable caveat shown in the storyboard (e.g. not enough footage).
    warning: str = ""
    # Per-clip AI voiceover (AI studio «озвучка на клип»). Overrides the project
    # voiceover; the clip then renders with replaced audio. The script text makes
    # subtitles spell exactly what was written (timings still from Whisper).
    voiceover_url: str | None = None
    voiceover_text: str = ""


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
    # Audio plan of the project: with `replace` the source speech is discarded,
    # so selection scores visuals and Whisper over sources is skipped.
    audio_mode: AudioMode = AudioMode.KEEP
    # Variety controls. Same seed + same sources ⇒ same storyboard; a new seed
    # gives a genuinely different montage of comparable quality.
    seed: int | None = None
    # Mix geometry: how many distinct montages to propose from the same sources.
    variant_count: int = Field(default=1, ge=1, le=10)
    pace: Pace = Pace.NORMAL
    # Mix + replace: open with the strongest shot (retention hook).
    hook_first: bool = True
    # Per source (aligned to source_urls): [start, end] ranges already used by
    # earlier montages — deprioritised (not banned) so new montages look new.
    exclude_ranges: list[list[tuple[float, float]]] = Field(default_factory=list)
    # Per source: a previously computed SourceAnalysis to reuse (None = analyse).
    cached_analyses: list[SourceAnalysis | None] = Field(default_factory=list)
    # Force/skip Whisper over sources. None = auto (only when audio is kept).
    need_transcript: bool | None = None


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
    subtitle_style: SubtitleStyle | str = SubtitleStyle.TIKTOK
    # Optional shared voiceover + BGM keys for audio_mode=replace.
    voiceover_url: str | None = None
    bgm_url: str | None = None
    geometry: Geometry | None = None
    seed: int = 0
    # Script of the project-level voiceover (subtitle spelling).
    voiceover_text: str = ""


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
