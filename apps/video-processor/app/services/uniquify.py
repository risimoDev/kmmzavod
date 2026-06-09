"""
FFmpeg-based video uniquification service.

Takes a source video and applies a set of randomized transforms to produce
a unique variant that appears original to social media platform algorithms.

Transforms applied:
  - Random crop (2-5%) with random offset
  - Horizontal flip (50% chance)
  - Speed change (0.95x–1.05x)
  - Hue/saturation/brightness/contrast shifts
  - Pitch shift on audio
  - BGM mixing
  - Subtitle burn-in (ASS format)
  - Trim start/end
  - Variable CRF encoding
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


# ── Transform parameters (mirrors VariantTransforms from @kmmzavod/queue) ────

@dataclass
class VariantTransforms:
    # Visual
    crop_percent: float = 0.02
    crop_offset_x: float = 0.5
    crop_offset_y: float = 0.5
    h_flip: bool = False
    speed: float = 1.0
    hue_shift: float = 0.0
    saturation_shift: float = 1.0
    brightness_shift: float = 0.0
    contrast_shift: float = 1.0
    crf: int = 21
    # Audio
    bgm_track_path: str | None = None
    bgm_volume: float = 0.10
    pitch_shift: float = 0.0
    # Subtitles
    subtitle_style: str = "none"
    subtitle_font_size: int = 24
    subtitle_color: str = "#FFFFFF"
    subtitle_position: str = "bottom"
    # TTS
    tts_audio_path: str | None = None
    tts_volume: float = 0.9
    # Trim
    trim_start_sec: float = 0.0
    trim_end_sec: float = 0.0

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "VariantTransforms":
        return cls(
            crop_percent=d.get("cropPercent", 0.02),
            crop_offset_x=d.get("cropOffsetX", 0.5),
            crop_offset_y=d.get("cropOffsetY", 0.5),
            h_flip=d.get("hFlip", False),
            speed=d.get("speed", 1.0),
            hue_shift=d.get("hueShift", 0.0),
            saturation_shift=d.get("saturationShift", 1.0),
            brightness_shift=d.get("brightnessShift", 0.0),
            contrast_shift=d.get("contrastShift", 1.0),
            crf=d.get("crf", 21),
            bgm_volume=d.get("bgmVolume", 0.10),
            pitch_shift=d.get("pitchShift", 0.0),
            subtitle_style=d.get("subtitleStyle", "none"),
            subtitle_font_size=d.get("subtitleFontSize", 24),
            subtitle_color=d.get("subtitleColor", "#FFFFFF"),
            subtitle_position=d.get("subtitlePosition", "bottom"),
            trim_start_sec=d.get("trimStartSec", 0.0),
            trim_end_sec=d.get("trimEndSec", 0.0),
        )


@dataclass
class AnalysisResult:
    """Result of analyzing a source video."""
    duration_sec: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 30.0
    scene_breaks: list[float] = field(default_factory=list)
    audio_profile: dict[str, Any] = field(default_factory=dict)


@dataclass
class RenderResult:
    """Result of rendering a unique variant."""
    output_path: str = ""
    thumbnail_path: str | None = None
    duration_sec: float = 0.0
    file_size_bytes: int = 0
    width: int = 0
    height: int = 0
    phash: str | None = None


def _compute_phash(image_path: str) -> str | None:
    """Fast average-hash via OpenCV (CPU-only, no extra deps)."""
    try:
        import cv2
        import numpy as np
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return None
        img = cv2.resize(img, (8, 8), interpolation=cv2.INTER_AREA)
        mean = img.mean()
        bits = (img >= mean).astype(np.uint8).flatten()
        hex_str = ''.join(f'{sum(b << (3 - j) for j, b in enumerate(bits[i:i+4])):x}' for i in range(0, 64, 4))
        return hex_str
    except Exception:
        return None


def _ffmpeg() -> str:
    d = settings.ffmpeg_bin_dir
    return os.path.join(d, "ffmpeg") if d else "ffmpeg"


def _ffprobe() -> str:
    d = settings.ffmpeg_bin_dir
    return os.path.join(d, "ffprobe") if d else "ffprobe"


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    logger.debug("CMD: %s", " ".join(cmd))
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=True)


# ── Random transform generator ───────────────────────────────────────────────

def generate_random_transforms(seed: int | None = None) -> dict[str, Any]:
    """Generate a random set of transforms for a single variant."""
    rng = random.Random(seed)

    subtitle_styles = ["tiktok", "cinematic", "minimal", "default"]
    subtitle_colors = [
        "#FFFFFF", "#FFD700", "#00FF7F", "#FF6B6B",
        "#87CEEB", "#DDA0DD", "#F0E68C", "#98FB98",
    ]
    subtitle_positions = ["bottom", "top", "center"]

    return {
        "cropPercent": round(rng.uniform(0.01, 0.05), 3),
        "cropOffsetX": round(rng.uniform(0.2, 0.8), 2),
        "cropOffsetY": round(rng.uniform(0.2, 0.8), 2),
        "hFlip": rng.random() < 0.5,
        "speed": round(rng.uniform(0.95, 1.05), 3),
        "hueShift": round(rng.uniform(-8, 8), 1),
        "saturationShift": round(rng.uniform(0.9, 1.1), 2),
        "brightnessShift": round(rng.uniform(-0.04, 0.04), 3),
        "contrastShift": round(rng.uniform(0.96, 1.04), 3),
        "crf": rng.randint(19, 24),
        "bgmVolume": round(rng.uniform(0.05, 0.18), 2),
        "pitchShift": round(rng.uniform(-1.5, 1.5), 1),
        "subtitleStyle": rng.choice(subtitle_styles),
        "subtitleFontSize": rng.randint(20, 32),
        "subtitleColor": rng.choice(subtitle_colors),
        "subtitlePosition": rng.choice(subtitle_positions),
        "trimStartSec": round(rng.uniform(0, 1.5), 2),
        "trimEndSec": round(rng.uniform(0, 1.5), 2),
    }


# ── Video analysis ────────────────────────────────────────────────────────────

async def analyze_video(source_path: str) -> AnalysisResult:
    """
    Analyze a source video: extract metadata, detect scene breaks, profile audio.
    """
    result = AnalysisResult()

    # 1. Probe video metadata
    probe_cmd = [
        _ffprobe(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,duration",
        "-show_entries", "format=duration",
        "-of", "json",
        source_path,
    ]
    proc = await asyncio.to_thread(_run, probe_cmd)
    import json
    probe = json.loads(proc.stdout)

    streams = probe.get("streams", [{}])
    fmt = probe.get("format", {})
    if streams:
        s = streams[0]
        result.width = int(s.get("width", 0))
        result.height = int(s.get("height", 0))
        rfr = s.get("r_frame_rate", "30/1")
        if "/" in rfr:
            num, den = rfr.split("/")
            result.fps = round(int(num) / max(int(den), 1), 2)
        stream_dur = s.get("duration")
        if stream_dur:
            result.duration_sec = round(float(stream_dur), 2)

    if not result.duration_sec and fmt.get("duration"):
        result.duration_sec = round(float(fmt["duration"]), 2)

    # 2. Scene detection via ffmpeg's scene filter (skip frames to reduce CPU)
    scene_cmd = [
        _ffmpeg(), "-threads", str(settings.ffmpeg_threads), "-i", source_path,
        "-vf", "fps=1,select='gt(scene,0.35)',showinfo",
        "-vsync", "vfr",
        "-f", "null", "-",
    ]
    try:
        scene_proc = await asyncio.to_thread(
            lambda: subprocess.run(scene_cmd, capture_output=True, text=True, timeout=120)
        )
        # Parse scene timestamps from stderr
        import re
        for line in scene_proc.stderr.split("\n"):
            m = re.search(r"pts_time:(\d+\.?\d*)", line)
            if m:
                result.scene_breaks.append(round(float(m.group(1)), 2))
    except Exception as e:
        logger.warning("Scene detection failed: %s", e)

    # 3. Audio loudness profile
    loud_cmd = [
        _ffmpeg(), "-threads", str(settings.ffmpeg_threads), "-i", source_path,
        "-af", "loudnorm=print_format=json",
        "-f", "null", "-",
    ]
    try:
        loud_proc = await asyncio.to_thread(
            lambda: subprocess.run(loud_cmd, capture_output=True, text=True, timeout=60)
        )
        # Extract loudnorm JSON from stderr
        stderr = loud_proc.stderr
        json_start = stderr.rfind("{")
        json_end = stderr.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            result.audio_profile = json.loads(stderr[json_start:json_end])
    except Exception as e:
        logger.warning("Audio analysis failed: %s", e)

    return result


# ── Subtitle generation ───────────────────────────────────────────────────────

def _generate_ass_subtitles(
    transcript: list[dict],
    style: str,
    font_size: int,
    color: str,
    position: str,
    video_width: int,
    video_height: int,
) -> str:
    """Generate ASS subtitle content from Whisper transcript segments."""
    # Position alignment: bottom=2, top=6, center=5
    alignment = {"bottom": 2, "top": 6, "center": 5}.get(position, 2)

    # Margin bottom/top based on position
    margin_v = 40 if position == "bottom" else (30 if position == "top" else 0)

    # Color: ASS uses &HBBGGRR& format
    hex_color = color.lstrip("#")
    if len(hex_color) == 6:
        r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
        ass_color = f"&H00{b}{g}{r}&"
    else:
        ass_color = "&H00FFFFFF&"

    # Font based on style
    font_name = {
        "tiktok": "Arial Black",
        "cinematic": "Georgia",
        "minimal": "Helvetica",
        "default": "Arial",
    }.get(style, "Arial")

    bold = 1 if style == "tiktok" else 0
    outline = 2.5 if style in ("tiktok", "default") else (1.5 if style == "cinematic" else 0.5)
    shadow = 1 if style != "minimal" else 0

    header = f"""[Script Info]
Title: Uniquified Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font_name},{font_size},{ass_color},&H000000FF&,&H00000000&,&H80000000&,{bold},0,0,0,100,100,0,0,1,{outline},{shadow},{alignment},20,20,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    def _ts(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = sec % 60
        return f"{h}:{m:02d}:{s:05.2f}"

    lines = []
    for seg in transcript:
        start = seg.get("start", seg.get("start_sec", 0))
        end = seg.get("end", seg.get("end_sec", 0))
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},Default,,0,0,0,,{text}")

    return header + "\n".join(lines) + "\n"


# ── Main render function ─────────────────────────────────────────────────────

async def render_unique_variant(
    source_path: str,
    output_path: str,
    transforms: VariantTransforms,
    transcript: list[dict] | None = None,
    work_dir: str | None = None,
) -> RenderResult:
    """
    Apply uniquification transforms to source video and produce a unique variant.
    """
    if work_dir is None:
        work_dir = tempfile.mkdtemp(prefix="uniquify_")

    t = transforms

    # Probe source dimensions
    probe_cmd = [
        _ffprobe(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,duration",
        "-show_entries", "format=duration",
        "-of", "json",
        source_path,
    ]
    import json
    probe_proc = await asyncio.to_thread(_run, probe_cmd)
    probe = json.loads(probe_proc.stdout)

    streams = probe.get("streams", [{}])
    fmt = probe.get("format", {})
    src_w = int(streams[0].get("width", 1080)) if streams else 1080
    src_h = int(streams[0].get("height", 1920)) if streams else 1920
    src_dur = float(streams[0].get("duration", 0)) if streams else 0
    if not src_dur and fmt.get("duration"):
        src_dur = float(fmt["duration"])

    # ── Build FFmpeg filter graph ─────────────────────────────────────

    vfilters: list[str] = []

    # 1. Trim
    effective_start = min(t.trim_start_sec, src_dur * 0.1)
    effective_end = min(t.trim_end_sec, src_dur * 0.1)
    trim_end_time = max(src_dur - effective_end, effective_start + 1)

    # 2. Crop (random area, slightly smaller than original)
    crop_w = int(src_w * (1 - t.crop_percent))
    crop_h = int(src_h * (1 - t.crop_percent))
    max_offset_x = src_w - crop_w
    max_offset_y = src_h - crop_h
    crop_x = int(max_offset_x * t.crop_offset_x)
    crop_y = int(max_offset_y * t.crop_offset_y)
    # Ensure even dimensions
    crop_w = crop_w - (crop_w % 2)
    crop_h = crop_h - (crop_h % 2)
    vfilters.append(f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}")

    # Scale back to original dimensions for consistent output
    out_w = src_w - (src_w % 2)
    out_h = src_h - (src_h % 2)
    vfilters.append(f"scale={out_w}:{out_h}:flags=lanczos")

    # 3. Horizontal flip
    if t.h_flip:
        vfilters.append("hflip")

    # 4. Color adjustments (hue, saturation, brightness, contrast)
    # hue filter: h=hue_shift (degrees), s=saturation multiplier
    if abs(t.hue_shift) > 0.5 or abs(t.saturation_shift - 1.0) > 0.01:
        vfilters.append(f"hue=h={t.hue_shift}:s={t.saturation_shift}")

    # brightness & contrast via eq filter
    if abs(t.brightness_shift) > 0.005 or abs(t.contrast_shift - 1.0) > 0.005:
        vfilters.append(f"eq=brightness={t.brightness_shift}:contrast={t.contrast_shift}")

    # 5. Speed change via setpts + atempo
    if abs(t.speed - 1.0) > 0.001:
        pts_factor = round(1.0 / t.speed, 4)
        vfilters.append(f"setpts={pts_factor}*PTS")

    # Build audio filters
    afilters: list[str] = []

    # Speed change for audio
    if abs(t.speed - 1.0) > 0.001:
        afilters.append(f"atempo={t.speed}")

    # Pitch shift using rubberband or asetrate+aresample
    if abs(t.pitch_shift) > 0.1:
        # Convert semitones to rate multiplier: rate = 2^(semitones/12)
        rate_mult = 2 ** (t.pitch_shift / 12)
        # asetrate changes pitch without changing speed when combined with aresample
        afilters.append(f"asetrate=44100*{rate_mult:.4f},aresample=44100")

    # ── Build FFmpeg command ──────────────────────────────────────────

    cmd: list[str] = [_ffmpeg(), "-y"]

    # Input with trim
    if effective_start > 0:
        cmd += ["-ss", f"{effective_start:.2f}"]
    cmd += ["-i", source_path]
    if trim_end_time < src_dur:
        cmd += ["-t", f"{trim_end_time - effective_start:.2f}"]

    # BGM input (if provided)
    bgm_input_idx = None
    if t.bgm_track_path and os.path.exists(t.bgm_track_path):
        cmd += ["-i", t.bgm_track_path]
        bgm_input_idx = 1

    # TTS input (if provided)
    tts_input_idx = None
    if t.tts_audio_path and os.path.exists(t.tts_audio_path):
        tts_input_idx = (bgm_input_idx or 0) + 1
        cmd += ["-i", t.tts_audio_path]

    # Subtitle file (if transcript provided and style != none)
    sub_path = None
    if transcript and t.subtitle_style != "none":
        sub_path = os.path.join(work_dir, "subs.ass")
        ass_content = _generate_ass_subtitles(
            transcript=transcript,
            style=t.subtitle_style,
            font_size=t.subtitle_font_size,
            color=t.subtitle_color,
            position=t.subtitle_position,
            video_width=out_w,
            video_height=out_h,
        )
        with open(sub_path, "w", encoding="utf-8") as f:
            f.write(ass_content)
        # Subtitle burn-in is done via video filter
        escaped = sub_path.replace("\\", "/").replace(":", "\\:")
        vfilters.append(f"ass='{escaped}'")

    # Compose filter_complex for audio mixing
    filter_complex_parts: list[str] = []
    final_audio = "[0:a]"

    # Apply audio filters to main audio
    if afilters:
        af_chain = ",".join(afilters)
        filter_complex_parts.append(f"[0:a]{af_chain}[amain]")
        final_audio = "[amain]"

    # Mix BGM
    if bgm_input_idx is not None:
        bgm_label = f"[{bgm_input_idx}:a]"
        bgm_out = "[bgm_adj]"
        filter_complex_parts.append(f"{bgm_label}volume={t.bgm_volume}{bgm_out}")
        mix_in1 = final_audio
        filter_complex_parts.append(
            f"{mix_in1}{bgm_out}amix=inputs=2:duration=first:dropout_transition=2[amixed]"
        )
        final_audio = "[amixed]"

    # Mix TTS over original audio (duck original)
    if tts_input_idx is not None:
        tts_label = f"[{tts_input_idx}:a]"
        duck_label = "[ducked]"
        # Duck the current audio
        current = final_audio
        filter_complex_parts.append(f"{current}volume=0.15{duck_label}")
        tts_adj = "[tts_adj]"
        filter_complex_parts.append(f"{tts_label}volume={t.tts_volume}{tts_adj}")
        filter_complex_parts.append(
            f"{duck_label}{tts_adj}amix=inputs=2:duration=first:dropout_transition=1[afinal]"
        )
        final_audio = "[afinal]"

    # Video filter chain
    vf_chain = ",".join(vfilters) if vfilters else "null"

    if filter_complex_parts:
        # Use filter_complex
        filter_complex_parts.insert(0, f"[0:v]{vf_chain}[vout]")
        cmd += ["-filter_complex", ";".join(filter_complex_parts)]
        cmd += ["-map", "[vout]", "-map", final_audio]
    else:
        # Simple case: only video filters
        if vfilters:
            cmd += ["-vf", vf_chain]
        if afilters:
            cmd += ["-af", ",".join(afilters)]

    # Output encoding (CPU-optimized: threads, veryfast preset)
    cmd += [
        "-threads", str(settings.ffmpeg_threads),
        "-c:v", "libx264",
        "-preset", settings.ffmpeg_final_preset,
        "-crf", str(t.crf),
        "-maxrate", settings.ffmpeg_max_bitrate,
        "-bufsize", settings.ffmpeg_bufsize,
        "-c:a", "aac",
        "-b:a", settings.ffmpeg_audio_bitrate,
        "-movflags", "+faststart",
        "-pix_fmt", "yuv420p",
        output_path,
    ]

    logger.info("Rendering variant: %d filters, crf=%d, speed=%.3f", len(vfilters), t.crf, t.speed)
    await asyncio.to_thread(_run, cmd, timeout=600)

    # Generate thumbnail
    thumbnail_path = output_path.rsplit(".", 1)[0] + "_thumb.jpg"
    thumb_cmd = [
        _ffmpeg(), "-y",
        "-i", output_path,
        "-ss", "1",
        "-vframes", "1",
        "-q:v", "3",
        thumbnail_path,
    ]
    try:
        await asyncio.to_thread(_run, thumb_cmd, timeout=30)
    except Exception:
        thumbnail_path = None

    # Compute perceptual hash from thumbnail (CPU-only duplicate detection)
    phash = _compute_phash(thumbnail_path) if thumbnail_path else None

    # Get output file info
    stat = os.stat(output_path)

    # Probe output duration
    out_dur = 0.0
    try:
        dur_cmd = [
            _ffprobe(), "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json",
            output_path,
        ]
        dur_proc = await asyncio.to_thread(_run, dur_cmd)
        dur_data = json.loads(dur_proc.stdout)
        out_dur = round(float(dur_data.get("format", {}).get("duration", 0)), 2)
    except Exception:
        pass

    return RenderResult(
        output_path=output_path,
        thumbnail_path=thumbnail_path,
        duration_sec=out_dur,
        file_size_bytes=stat.st_size,
        width=out_w,
        height=out_h,
        phash=phash,
    )
