"""Shared Pydantic models for the video-processor service."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


# ── Enums ─────────────────────────────────────────────────────────────────────

class KenBurnsPreset(str, Enum):
    ZOOM_IN = "zoom_in"      # Slowly zoom into center
    ZOOM_OUT = "zoom_out"    # Start zoomed, slowly pull back
    PAN_LR = "pan_lr"        # Pan left → right with slight zoom
    PAN_RL = "pan_rl"        # Pan right → left with slight zoom
    PAN_TB = "pan_tb"        # Pan top → bottom with slight zoom
    AUTO = "auto"            # Deterministic choice based on scene index


class TransitionType(str, Enum):
    FADE = "fade"
    SMOOTH_LEFT = "smoothleft"
    SMOOTH_RIGHT = "smoothright"
    WIPE_LEFT = "wipeleft"
    WIPE_RIGHT = "wiperight"
    CIRCLE_OPEN = "circleopen"
    DISSOLVE = "dissolve"
    SLIDE_UP = "slideup"
    SLIDE_DOWN = "slidedown"
    WHIPTL = "whiptl"
    WHIPTR = "whiptr"
    CUT = "cut"              # Hard cut (no transition)


class CutType(str, Enum):
    """L-cut / J-cut type for audio-video offset at scene boundaries."""
    HARD = "hard"    # Video and audio switch at the same time (default)
    L_CUT = "l_cut"  # Video switches first, audio from previous scene continues briefly
    J_CUT = "j_cut"  # Audio from next scene starts before video switches


class SubtitleStyle(str, Enum):
    DEFAULT = "default"      # White Arial, black outline, bottom-center
    TIKTOK = "tiktok"        # Bold, large, word-wrapped, yellow highlight
    CINEMATIC = "cinematic"  # Smaller italic font, semi-transparent box
    MINIMAL = "minimal"      # Small, no outline, upper-center


# ── Scene ─────────────────────────────────────────────────────────────────────

class SceneItem(BaseModel):
    scene_id: str
    type: Literal["avatar", "clip", "image", "text"]

    # Object key in MinIO/S3
    storage_key: str

    # Display duration. For video clips < actual duration, the clip is trimmed.
    # For images this is the full animation duration.
    duration_sec: float = Field(gt=0, le=300)

    # Transition FROM this scene TO the next scene
    transition: TransitionType = TransitionType.FADE
    transition_duration: float = Field(default=0.5, ge=0.0, le=2.0)

    # Ken Burns preset (only applies to image scenes)
    ken_burns: KenBurnsPreset = KenBurnsPreset.AUTO

    # Optional static text overlay (top third of frame, white)
    text_overlay: str | None = None

    # L-cut / J-cut: audio-video offset at the start of this scene
    cut_type: CutType = CutType.HARD
    # How many seconds audio leads (J-cut) or lags (L-cut) the video.
    # Positive = audio from this scene starts EARLIER than video (J-cut).
    # Negative = audio from previous scene continues after video switch (L-cut).
    audio_offset_sec: float = Field(default=0.0, ge=-1.0, le=1.0)

    # Speed ramping: playback speed multiplier for this scene
    # 1.0 = normal, 0.5 = half speed (slow-mo), 2.0 = double speed
    speed: float = Field(default=1.0, gt=0.0, le=4.0)


# ── Subtitles ─────────────────────────────────────────────────────────────────

class SubtitleEntry(BaseModel):
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=500)


# ── Audio ─────────────────────────────────────────────────────────────────────

class AudioDuckZone(BaseModel):
    """Time range where BGM should be ducked (lowered) because speech is active."""
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    duck_volume: float = Field(default=0.04, ge=0.0, le=0.5, description="BGM volume during duck")


class AudioTrack(BaseModel):
    """Optional background music track mixed at low volume under scene audio."""
    storage_key: str
    volume: float = Field(default=0.12, ge=0.0, le=1.0)
    fade_in_sec: float = Field(default=1.5, ge=0.0)
    fade_out_sec: float = Field(default=2.0, ge=0.0)
    duck_zones: list[AudioDuckZone] = Field(default=[], description="Auto ducking during speech")
    duck_fade_ms: int = Field(default=80, ge=10, le=500, description="Fade speed for duck transitions")


class BeatSyncConfig(BaseModel):
    """Configuration for beat-synchronised transitions."""
    enabled: bool = True
    tolerance_sec: float = Field(default=0.5, ge=0.1, le=2.0, description="Max snap distance to a beat")
    use_onsets: bool = Field(default=False, description="Use onsets instead of beats for finer sync")


class ContentAwareTransitionConfig(BaseModel):
    """Configuration for AI-driven transition selection."""
    enabled: bool = True
    # Rules mapping scene type pairs to preferred transitions
    # Key format: "type1->type2" e.g. "avatar->clip"
    rules: dict[str, str] = Field(default={}, description="Override transition per scene-type pair")


class ColorGradingConfig(BaseModel):
    """Configuration for automatic color grading between segments."""
    enabled: bool = True
    method: Literal["histogram", "average", "none"] = "histogram"
    strength: float = Field(default=0.6, ge=0.0, le=1.0, description="Blending strength: 0=no change, 1=full match")


class QualityIssue(BaseModel):
    """A single quality issue detected in a clip."""
    scene_index: int
    issue_type: Literal["blur", "black_frame", "too_dark", "too_bright", "no_motion"]
    severity: Literal["warning", "critical"]
    score: float = Field(ge=0.0, le=1.0, description="0=worst, 1=perfect")
    message: str


class QualityReport(BaseModel):
    """Quality gate report for all clips in a composition."""
    passed: bool
    issues: list[QualityIssue] = []
    overall_score: float = Field(ge=0.0, le=1.0)


# ── Composition settings ──────────────────────────────────────────────────────

class CompositionSettings(BaseModel):
    width: int = 1080
    height: int = 1920
    fps: int = Field(default=30, ge=15, le=60)
    crf: int = Field(default=21, ge=16, le=35)
    preset: str = "medium"
    audio_bitrate: str = "192k"
    max_bitrate: str = "6M"
    bufsize: str = "12M"
    subtitle_style: SubtitleStyle = SubtitleStyle.TIKTOK


# ── Request / Response ────────────────────────────────────────────────────────

class ComposeRequest(BaseModel):
    job_id: str
    tenant_id: str
    output_key: str
    scenes: list[SceneItem] = Field(min_length=1)
    subtitles: list[SubtitleEntry] = []
    audio_track: AudioTrack | None = None
    settings: CompositionSettings = CompositionSettings()
    beat_sync: BeatSyncConfig | None = None
    content_aware_transitions: ContentAwareTransitionConfig | None = None
    color_grading: ColorGradingConfig | None = None
    skip_quality_gate: bool = False


class ComposeResponse(BaseModel):
    output_key: str
    duration_sec: float
    file_size_bytes: int
    width: int
    height: int
    scene_count: int


# ── Layout composition ────────────────────────────────────────────────────────

class LayoutType(str, Enum):
    FULLSCREEN = "fullscreen"   # Avatar full frame on background (chroma-keyed)
    PIP_BL = "pip_bl"           # Avatar PIP bottom-left
    PIP_BR = "pip_br"           # Avatar PIP bottom-right
    PIP_TL = "pip_tl"           # Avatar PIP top-left
    PIP_TR = "pip_tr"           # Avatar PIP top-right
    VOICEOVER = "voiceover"     # No avatar visible, only voice over product footage


class LayoutSegment(BaseModel):
    layout: LayoutType
    bg_index: int = Field(ge=0, description="Index into backgrounds array")
    weight: float = Field(gt=0, le=1.0, description="Relative duration (fraction of total)")


class BackgroundAsset(BaseModel):
    storage_key: str
    type: Literal["image", "video"]


class LayoutComposeRequest(BaseModel):
    job_id: str
    tenant_id: str
    output_key: str

    avatar_storage_key: str
    backgrounds: list[BackgroundAsset] = Field(min_length=1)
    segments: list[LayoutSegment] = Field(min_length=2)

    subtitles: list[SubtitleEntry] = []
    audio_track: AudioTrack | None = None
    settings: CompositionSettings = CompositionSettings()

    chroma_color: str = "#00FF00"
    pip_scale: float = Field(default=0.30, ge=0.15, le=0.60)
    pip_margin: int = Field(default=30, ge=0, le=100)
    transition: TransitionType = TransitionType.FADE
    transition_duration: float = Field(default=0.3, ge=0.0, le=1.0)

    beat_sync: BeatSyncConfig | None = None
    content_aware_transitions: ContentAwareTransitionConfig | None = None
    color_grading: ColorGradingConfig | None = None
    word_timestamps: list[dict] = Field(default=[], description="Whisper word-level timestamps for ducking")
    skip_quality_gate: bool = False
