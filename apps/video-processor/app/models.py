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
    CUT = "cut"              # Hard cut (no transition)


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


# ── Subtitles ─────────────────────────────────────────────────────────────────

class SubtitleEntry(BaseModel):
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=500)


# ── Audio ─────────────────────────────────────────────────────────────────────

class AudioTrack(BaseModel):
    """Optional background music track mixed at low volume under scene audio."""
    storage_key: str
    volume: float = Field(default=0.12, ge=0.0, le=1.0)
    fade_in_sec: float = Field(default=1.5, ge=0.0)
    fade_out_sec: float = Field(default=2.0, ge=0.0)


# ── Composition settings ──────────────────────────────────────────────────────

class CompositionSettings(BaseModel):
    width: int = 1080
    height: int = 1920
    fps: int = Field(default=30, ge=15, le=60)
    crf: int = Field(default=23, ge=16, le=35)
    preset: str = "fast"
    audio_bitrate: str = "128k"
    max_bitrate: str = "4M"
    bufsize: str = "8M"
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


class ComposeResponse(BaseModel):
    output_key: str
    duration_sec: float
    file_size_bytes: int
    width: int
    height: int
    scene_count: int
