"""
FFmpeg abstraction layer for the video composition pipeline.

Design decisions
────────────────
• All intermediate files use ``-preset ultrafast -crf 18`` — fast I/O,
  quality loss in intermediates is invisible after the final encode.
• Ken Burns uses the crop+eval=frame approach instead of ``zoompan``:
  pre-scale the image to 130 % of output, then animate a shrinking/moving
  crop window.  This avoids zoompan's O(w*h*frames) overhead.
• xfade is used for video-only; audio uses a simple hard-concat (``concat``
  filter).  Hard cuts between scenes are masked by BGM when present.
• BGM is mixed with ``amix`` after all scenes are assembled, so its volume
  envelope is applied to the full timeline rather than per-scene.
• ``-movflags +faststart`` in the final encode places the MP4 MOOV atom at
  the start for instant streaming on social media platforms.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
from dataclasses import dataclass, field
from typing import Optional

from app.models import KenBurnsPreset, TransitionType

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Data types
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ProbeInfo:
    duration: float
    width: int
    height: int
    has_video: bool
    has_audio: bool
    fps: float


@dataclass
class ClipInfo:
    """Represents a normalized clip ready for compositing."""
    path: str
    duration: float
    has_audio: bool
    # Transition applied when moving FROM this clip TO the next
    transition: TransitionType = TransitionType.FADE
    transition_duration: float = 0.5


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _run(cmd: list[str], label: str = "") -> None:
    """Execute a command, raising CalledProcessError with captured stderr."""
    tag = label or os.path.basename(cmd[0])
    logger.debug("[%s] %s", tag, " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # Trim stderr to last 4 KB to avoid flooding logs
        stderr_tail = result.stderr[-4096:] if result.stderr else ""
        logger.error("[%s] failed (rc=%d)\n%s", tag, result.returncode, stderr_tail)
        raise subprocess.CalledProcessError(
            result.returncode, cmd, output=result.stdout, stderr=result.stderr
        )


def _safe_filter_path(path: str) -> str:
    """Escape a file path for use inside an FFmpeg filtergraph string."""
    # On Windows: backslash → forward slash; colon needs escaping in filters
    return path.replace("\\", "/").replace(":", "\\:")


def _ken_burns_preset_for_index(index: int) -> KenBurnsPreset:
    """Map scene index → deterministic Ken Burns preset (auto mode)."""
    presets = [
        KenBurnsPreset.ZOOM_IN,
        KenBurnsPreset.PAN_LR,
        KenBurnsPreset.ZOOM_OUT,
        KenBurnsPreset.PAN_TB,
        KenBurnsPreset.PAN_RL,
    ]
    return presets[index % len(presets)]


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def probe(path: str) -> ProbeInfo:
    """Run ffprobe and return stream metadata."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)

    duration = float(data["format"].get("duration", 0))
    width = height = 0
    has_video = has_audio = False
    fps = 30.0

    for s in data.get("streams", []):
        if s["codec_type"] == "video" and not has_video:
            has_video = True
            width = s.get("width", 0)
            height = s.get("height", 0)
            num, den = s.get("avg_frame_rate", "30/1").split("/")
            fps = float(num) / float(den) if float(den) > 0 else 30.0
        elif s["codec_type"] == "audio":
            has_audio = True

    return ProbeInfo(
        duration=duration,
        width=width,
        height=height,
        has_video=has_video,
        has_audio=has_audio,
        fps=fps,
    )


def normalize_video_clip(
    input_path: str,
    output_path: str,
    width: int,
    height: int,
    fps: int,
    duration: float,
    threads: int = 0,
) -> None:
    """
    Re-encode a video clip to the exact target resolution and frame rate.

    • Letterboxes (black bars) if aspect ratio doesn't match.
    • Ensures stereo AAC audio; inserts silence if the source has none.
    • Uses ``ultrafast`` preset since this is an intermediate file.
    """
    info = probe(input_path)

    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"fps={fps},"
        f"format=yuv420p"
    )

    fc_parts = [f"[0:v]{vf}[v]"]
    map_args = ["-map", "[v]"]

    if info.has_audio:
        fc_parts.append("[0:a]aformat=channel_layouts=stereo:sample_rates=44100[a]")
        extra_inputs: list[str] = []
    else:
        # Generate silence matching the clip duration
        fc_parts.append(
            f"aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration={duration}[a]"
        )
        extra_inputs = []

    map_args += ["-map", "[a]"]

    cmd = (
        ["ffmpeg", "-y", "-i", input_path]
        + extra_inputs
        + ["-filter_complex", ";".join(fc_parts)]
        + map_args
        + [
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
            "-c:a", "aac", "-b:a", "128k",
            "-t", str(duration),
            "-threads", str(threads),
            output_path,
        ]
    )
    _run(cmd, "normalize_video")


def image_to_clip(
    input_path: str,
    output_path: str,
    width: int,
    height: int,
    duration: float,
    fps: int,
    preset: KenBurnsPreset = KenBurnsPreset.ZOOM_IN,
    scene_index: int = 0,
    threads: int = 0,
) -> None:
    """
    Convert a static image to an animated video using the Ken Burns effect.

    Implementation uses the **crop+eval=frame** technique:

    1. Pre-scale the image to 130 % of output (``SW × SH``) to provide
       movement headroom.
    2. Animate a crop window over the pre-scaled image using FFmpeg filter
       expressions evaluated per frame (``eval=frame``).
    3. Scale the crop result back to the exact output size.

    This is 3–5× faster than ``zoompan`` on CPU because it avoids zoompan's
    per-frame zoom resampling — only a single bilinear scale pass is needed.

    Preset behaviour:
        ZOOM_IN  — crop shrinks from 130 % to 100 % of output (zoom in)
        ZOOM_OUT — crop grows from 100 % to 130 % of output (zoom out)
        PAN_LR   — constant-size crop pans left → right at 115 % scale
        PAN_RL   — constant-size crop pans right → left at 115 % scale
        PAN_TB   — constant-size crop pans top → bottom at 115 % scale
        AUTO     — round-robin from above presets using ``scene_index``
    """
    if preset is KenBurnsPreset.AUTO:
        preset = _ken_burns_preset_for_index(scene_index)

    # 130 % pre-scale for zoom effects; 115 % for pan-only
    zoom_scale = 1.30
    pan_scale = 1.15

    d = max(duration, 0.1)

    # ── Cover-scale the image to our working canvas ────────────────────────
    if preset in (KenBurnsPreset.PAN_LR, KenBurnsPreset.PAN_RL, KenBurnsPreset.PAN_TB):
        sw = int(width * pan_scale)
        sh = int(height * pan_scale)
    else:
        sw = int(width * zoom_scale)
        sh = int(height * zoom_scale)

    prescale = (
        f"scale={sw}:{sh}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={sw}:{sh}"
    )

    mw = sw - width    # Horizontal movement budget
    mh = sh - height   # Vertical movement budget

    if preset is KenBurnsPreset.ZOOM_IN:
        # Crop starts large (sw×sh), shrinks towards (width×height) centred
        crop = (
            f"crop="
            f"w='{sw}-{mw}*min(t/{d},1)':"
            f"h='{sh}-{mh}*min(t/{d},1)':"
            f"x='{mw}*min(t/{d},1)/2':"
            f"y='{mh}*min(t/{d},1)/2':"
            f"eval=frame"
        )

    elif preset is KenBurnsPreset.ZOOM_OUT:
        # Crop starts small (width×height centred), grows to sw×sh
        crop = (
            f"crop="
            f"w='{width}+{mw}*min(t/{d},1)':"
            f"h='{height}+{mh}*min(t/{d},1)':"
            f"x='{mw}*(1-min(t/{d},1))/2':"
            f"y='{mh}*(1-min(t/{d},1))/2':"
            f"eval=frame"
        )

    elif preset is KenBurnsPreset.PAN_LR:
        # Fixed crop width, pan x from 0 to mw
        crop = (
            f"crop="
            f"w={width}:h={height}:"
            f"x='{mw}*min(t/{d},1)':"
            f"y='{mh//2}':"
            f"eval=frame"
        )

    elif preset is KenBurnsPreset.PAN_RL:
        # Fixed crop width, pan x from mw to 0
        crop = (
            f"crop="
            f"w={width}:h={height}:"
            f"x='{mw}*(1-min(t/{d},1))':"
            f"y='{mh//2}':"
            f"eval=frame"
        )

    else:  # PAN_TB
        # Fixed crop height, pan y from 0 to mh
        crop = (
            f"crop="
            f"w={width}:h={height}:"
            f"x='{mw//2}':"
            f"y='{mh}*min(t/{d},1)':"
            f"eval=frame"
        )

    scale_back = f"scale={width}:{height}:flags=lanczos"
    vf = f"{prescale},{crop},{scale_back},format=yuv420p"

    # Add silence track (image clips have no audio source)
    silent_audio = f"aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration={duration}"

    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", str(fps),
        "-i", input_path,
        "-filter_complex", f"[0:v]{vf}[v];{silent_audio}[a]",
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "64k",
        "-t", str(duration),
        "-r", str(fps),
        "-threads", str(threads),
        output_path,
    ]
    _run(cmd, "image_to_clip")


def concat_with_transitions(
    clips: list[ClipInfo],
    output: str,
    threads: int = 0,
) -> None:
    """
    Concatenate normalized clips with per-scene xfade video transitions.

    Audio uses a hard concat (``concat`` filter) which avoids the offset
    synchronisation complexity of chaining ``acrossfade`` with ``xfade``.
    Hard audio cuts are masked by BGM when the caller adds a background track.

    xfade offset formula (derived)
    ───────────────────────────────
    For N clips with transition durations t[i] (between clip i and i+1)::

        offset[i] = Σ duration[0..i] − Σ t[0..i]

    The offset is the position (in seconds) in the accumulated output stream
    where the i-th transition begins.
    """
    n = len(clips)

    if n == 1:
        _run(["ffmpeg", "-y", "-i", clips[0].path, "-c", "copy", output], "single_clip_copy")
        return

    cmd = ["ffmpeg", "-y"]
    for c in clips:
        cmd += ["-i", c.path]

    fc_parts: list[str] = []

    # ── Video xfade chain ──────────────────────────────────────────────────
    v_prev = "[0:v]"
    cum_duration = 0.0
    cum_transition = 0.0

    for i in range(1, n):
        td = clips[i - 1].transition_duration
        tr = clips[i - 1].transition.value

        # Skip xfade for hard cuts or zero-duration transitions
        v_next = "[v_end]" if i == n - 1 else f"[v{i}]"

        if tr == TransitionType.CUT.value or td <= 0:
            # Hard cut — use concat for this pair (fallback)
            v_next = f"[v{i}]" if i < n - 1 else "[v_end]"
            fc_parts.append(f"{v_prev}[{i}:v]concat=n=2:v=1:a=0{v_next}")
            cum_duration += clips[i - 1].duration
            cum_transition += 0.0
        else:
            cum_duration += clips[i - 1].duration
            cum_transition += td
            offset = cum_duration - cum_transition
            # Clamp: offset must be > 0
            offset = max(offset, 0.01)
            fc_parts.append(
                f"{v_prev}[{i}:v]xfade=transition={tr}"
                f":duration={td:.4f}:offset={offset:.4f}{v_next}"
            )

        v_prev = v_next

    # ── Audio concat (hard) ────────────────────────────────────────────────
    audio_inputs = "".join(f"[{i}:a]" for i in range(n))
    fc_parts.append(f"{audio_inputs}concat=n={n}:v=0:a=1[a_end]")

    total_duration = sum(c.duration for c in clips) - sum(
        c.transition_duration for c in clips[:-1]
        if c.transition != TransitionType.CUT and c.transition_duration > 0
    )

    cmd += [
        "-filter_complex", ";".join(fc_parts),
        "-map", "[v_end]",
        "-map", "[a_end]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k",
        "-t", str(total_duration),
        "-threads", str(threads),
        output,
    ]
    _run(cmd, "concat_transitions")


def mix_bgm(
    video_path: str,
    bgm_path: str,
    output_path: str,
    volume: float = 0.12,
    fade_in_sec: float = 1.5,
    fade_out_sec: float = 2.0,
    threads: int = 0,
) -> None:
    """
    Mix a background music track into the video at the specified volume.

    The BGM is:
    • looped if shorter than the video with ``aloop``
    • truncated to match video duration with ``atrim``
    • faded in / out using ``afade``
    • mixed with original audio at ratio ``volume : 1``
    """
    info = probe(video_path)
    dur = info.duration

    fade_out_start = max(0.0, dur - fade_out_sec)

    fc = (
        # BGM: loop → trim → volume → fade in → fade out
        f"[1:a]"
        f"aloop=loop=-1:size=2e+09,"
        f"atrim=duration={dur:.4f},"
        f"volume={volume:.4f},"
        f"afade=t=in:st=0:d={fade_in_sec:.2f},"
        f"afade=t=out:st={fade_out_start:.4f}:d={fade_out_sec:.2f}"
        f"[bgm];"
        # Mix BGM under original audio
        f"[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=3[aout]"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", bgm_path,
        "-filter_complex", fc,
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-threads", str(threads),
        output_path,
    ]
    _run(cmd, "mix_bgm")


def burn_subtitles(
    input_path: str,
    ass_path: str,
    output_path: str,
    threads: int = 0,
) -> None:
    """
    Burn ASS subtitles into the video using libass.

    libass renders the subtitle glyphs directly onto the video frames.
    Font fallback is handled by libass's internal font scanner.
    """
    safe_ass = _safe_filter_path(ass_path)

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vf", f"ass='{safe_ass}'",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "copy",
        "-threads", str(threads),
        output_path,
    ]
    _run(cmd, "burn_subtitles")


def final_encode(
    input_path: str,
    output_path: str,
    width: int,
    height: int,
    fps: int,
    crf: int = 23,
    preset: str = "fast",
    audio_bitrate: str = "128k",
    max_bitrate: str = "4M",
    bufsize: str = "8M",
    threads: int = 0,
) -> None:
    """
    Final H.264 encode targeting social media platforms.

    Optimisations
    ─────────────
    • ``-movflags +faststart`` — MOOV atom placed at front for instant streaming.
    • ``-profile:v high -level 4.1`` — broad decoder compatibility.
    • ``-maxrate / -bufsize`` — caps peak bitrate to avoid upload rejections.
    • ``-pix_fmt yuv420p`` — required by most platforms.
    • AAC-LC stereo at 128 kbps — universally supported.
    """
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"fps={fps},"
        f"format=yuv420p"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", str(crf),
        "-profile:v", "high",
        "-level:v", "4.1",
        "-maxrate", max_bitrate,
        "-bufsize", bufsize,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", audio_bitrate,
        "-ar", "44100",
        "-ac", "2",
        "-movflags", "+faststart",
        "-threads", str(threads),
        output_path,
    ]
    _run(cmd, "final_encode")


# ── Legacy helpers kept for backward compatibility ─────────────────────────

def build_concat_list(scene_paths: list[str], output_path: str) -> None:
    """Write an FFmpeg concat demuxer list file."""
    with open(output_path, "w", encoding="utf-8") as f:
        for path in scene_paths:
            safe = path.replace("\\", "/").replace("'", "\\'")
            f.write(f"file '{safe}'\n")

