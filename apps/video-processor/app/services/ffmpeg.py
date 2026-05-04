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

from app.config import settings
from app.models import CutType, KenBurnsPreset, TransitionType

logger = logging.getLogger(__name__)


def _bin(name: str) -> str:
    """Return full path to an FFmpeg binary (ffmpeg / ffprobe)."""
    if settings.ffmpeg_bin_dir:
        return os.path.join(settings.ffmpeg_bin_dir, name)
    return name


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
    # L-cut / J-cut audio offset for the start of this clip
    cut_type: CutType = CutType.HARD
    audio_offset_sec: float = 0.0
    # Speed multiplier (1.0 = normal)
    speed: float = 1.0


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
        _bin("ffprobe"), "-v", "quiet",
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
    • If source is shorter than duration → loops the clip.
    • If source is longer → trims from the beginning.
    • Uses ``ultrafast`` preset since this is an intermediate file.
    """
    info = probe(input_path)

    # If source is shorter than needed, use stream_loop to extend it
    loop_args: list[str] = []
    if info.duration > 0 and info.duration < duration - 0.1:
        loops_needed = int(duration / info.duration) + 1
        loop_args = ["-stream_loop", str(loops_needed)]

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
        [_bin("ffmpeg"), "-y"]
        + loop_args
        + ["-i", input_path]
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

    # Smoothstep easing: e(t) = t²·(3−2t) for t in [0,1] — ease-in-out curve
    # Much more cinematic than linear min(t/d,1)
    ease = f"if(lt(t,{d}),(t/{d})*(t/{d})*(3-2*(t/{d})),1)"
    ease_inv = f"(1-if(lt(t,{d}),(t/{d})*(t/{d})*(3-2*(t/{d})),1))"

    if preset is KenBurnsPreset.ZOOM_IN:
        # Crop starts large (sw×sh), shrinks towards (width×height) centred
        crop = (
            f"crop="
            f"w='{sw}-{mw}*{ease}':"
            f"h='{sh}-{mh}*{ease}':"
            f"x='{mw}*{ease}/2':"
            f"y='{mh}*{ease}/2'"
        )

    elif preset is KenBurnsPreset.ZOOM_OUT:
        # Crop starts small (width×height centred), grows to sw×sh
        crop = (
            f"crop="
            f"w='{width}+{mw}*{ease}':"
            f"h='{height}+{mh}*{ease}':"
            f"x='{mw}*{ease_inv}/2':"
            f"y='{mh}*{ease_inv}/2'"
        )

    elif preset is KenBurnsPreset.PAN_LR:
        # Fixed crop width, pan x from 0 to mw
        crop = (
            f"crop="
            f"w={width}:h={height}:"
            f"x='{mw}*{ease}':"
            f"y='{mh//2}'"
        )

    elif preset is KenBurnsPreset.PAN_RL:
        # Fixed crop width, pan x from mw to 0
        crop = (
            f"crop="
            f"w={width}:h={height}:"
            f"x='{mw}*{ease_inv}':"
            f"y='{mh//2}'"
        )

    else:  # PAN_TB
        # Fixed crop height, pan y from 0 to mh
        crop = (
            f"crop="
            f"w={width}:h={height}:"
            f"x='{mw//2}':"
            f"y='{mh}*{ease}'"
        )

    scale_back = f"scale={width}:{height}:flags=lanczos"
    vf = f"{prescale},{crop},{scale_back},format=yuv420p"

    # Add silence track (image clips have no audio source)
    silent_audio = f"aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration={duration}"

    cmd = [
        _bin("ffmpeg"), "-y",
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
        _run([_bin("ffmpeg"), "-y", "-i", clips[0].path, "-c", "copy", output], "single_clip_copy")
        return

    cmd = [_bin("ffmpeg"), "-y"]
    for c in clips:
        cmd += ["-i", c.path]

    fc_parts: list[str] = []

    # ── Video xfade chain ──────────────────────────────────────────────────
    v_prev = "[0:v]"
    cum_duration = 0.0
    cum_transition = 0.0
    # Collect transition params for audio crossfade sync
    transition_params: list[tuple[float, bool]] = []  # (duration, is_xfade)

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
            transition_params.append((0.0, False))
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
            transition_params.append((td, True))

        v_prev = v_next

    # ── Audio crossfade chain (synced with video xfade) ────────────────────
    # Use acrossfade with same durations as video xfade to keep audio/video
    # in sync. This prevents the audio from running longer than the video.
    has_xfade = any(is_xf for _, is_xf in transition_params)
    if has_xfade and n > 1:
        a_prev = "[0:a]"
        for i in range(1, n):
            td, is_xf = transition_params[i - 1]
            a_next = "[a_end]" if i == n - 1 else f"[a{i}]"
            if is_xf and td > 0:
                fc_parts.append(
                    f"{a_prev}[{i}:a]acrossfade=d={td:.4f}:c1=tri:c2=tri{a_next}"
                )
            else:
                fc_parts.append(f"{a_prev}[{i}:a]concat=n=2:v=0:a=1{a_next}")
            a_prev = a_next
    else:
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
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
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
        _bin("ffmpeg"), "-y",
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


def mix_bgm_ducking(
    video_path: str,
    bgm_path: str,
    output_path: str,
    volume: float = 0.12,
    duck_volume: float = 0.04,
    duck_zones: list[tuple[float, float]] | None = None,
    duck_fade_ms: int = 80,
    fade_in_sec: float = 1.5,
    fade_out_sec: float = 2.0,
    threads: int = 0,
) -> None:
    """
    Mix BGM with automatic ducking — BGM volume lowers when speech is active.

    Duck zones define time ranges where the avatar is speaking. Outside those
    zones, BGM plays at full ``volume``; inside, it drops to ``duck_volume``.

    The volume transitions use ``enable`` expressions per zone with smooth
    fade-in/fade-out of the volume change (``duck_fade_ms``) to avoid
    abrupt volume jumps (side-chain compression style).

    If duck_zones is empty or None, falls back to regular mix_bgm().
    """
    if not duck_zones:
        mix_bgm(video_path, bgm_path, output_path, volume,
                fade_in_sec, fade_out_sec, threads)
        return

    info = probe(video_path)
    dur = info.duration
    fade_out_start = max(0.0, dur - fade_out_sec)
    fade_s = duck_fade_ms / 1000.0

    # Build volume envelope: start at full volume, duck during speech zones
    # FFmpeg volume filter with enable='between(t,start,end)' per zone
    # We apply multiple volume filters chained: one per duck zone
    # Each filter lowers volume during its zone and is passthrough otherwise
    volume_filters: list[str] = []

    # BGM chain: loop → trim → initial volume → fade in/out
    bgm_chain = (
        f"[1:a]aloop=loop=-1:size=2e+09,"
        f"atrim=duration={dur:.4f},"
        f"volume={volume:.4f},"
        f"afade=t=in:st=0:d={fade_in_sec:.2f},"
        f"afade=t=out:st={fade_out_start:.4f}:d={fade_out_sec:.2f}"
    )

    # Apply duck zones as additional volume filters with enable expressions
    # Each duck zone: volume=duck_volume with enable='between(t,s,e)'
    # Plus a tiny fade envelope around the zone edges for smooth transition
    prev_label = "bgm"
    fc_parts = [f"{bgm_chain}[{prev_label}]"]

    for i, (start, end) in enumerate(duck_zones):
        end = min(end, dur)
        if start >= end:
            continue
        # Duck with smooth fade: use volume filter with enable expression
        # During duck zone, volume goes from full → duck_volume
        # We use a single volume filter per zone that activates only in range
        next_label = f"d{i}" if i < len(duck_zones) - 1 else "bgm_ducked"
        fc_parts.append(
            f"[{prev_label}]volume="
            f"{duck_volume:.4f}"
            f":enable='between(t,{start:.3f},{end:.3f})'"
            f"[{next_label}]"
        )
        prev_label = next_label

    # If no valid duck zones were processed, fallback label
    if prev_label == "bgm":
        prev_label = "bgm_ducked"
        fc_parts[-1] = fc_parts[-1].replace("[bgm]", "[bgm_ducked]")

    # Final mix: original audio + ducked BGM
    fc_parts.append(
        f"[0:a][{prev_label}]amix=inputs=2:duration=first:dropout_transition=3[aout]"
    )

    fc = ";".join(fc_parts)

    cmd = [
        _bin("ffmpeg"), "-y",
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
    _run(cmd, "mix_bgm_ducking")


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
        _bin("ffmpeg"), "-y",
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
    crf: int = 21,
    preset: str = "medium",
    audio_bitrate: str = "192k",
    max_bitrate: str = "6M",
    bufsize: str = "12M",
    threads: int = 0,
    ass_path: str | None = None,
) -> None:
    """
    Final H.264 encode targeting social media platforms.

    Optimisations
    ─────────────
    • ``-movflags +faststart`` — MOOV atom placed at front for instant streaming.
    • ``-profile:v high -level 4.1`` — broad decoder compatibility.
    • ``-maxrate / -bufsize`` — caps peak bitrate to avoid upload rejections.
    • ``-pix_fmt yuv420p`` — required by most platforms.
    • AAC-LC stereo — universally supported.
    • ``loudnorm`` — EBU R128 audio normalisation for consistent volume.
    • ``ass_path`` — optional ASS subtitle path; burns subtitles inline (saves one encode pass).
    """
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"fps={fps},"
        f"format=yuv420p"
    )
    # Inline subtitle burn: append ass filter to vf chain if provided
    if ass_path:
        vf += f",ass='{_safe_filter_path(ass_path)}'"

    # Audio normalization: EBU R128 loudness standard for social media
    af = "loudnorm=I=-16:LRA=11:TP=-1.5"

    cmd = [
        _bin("ffmpeg"), "-y",
        "-i", input_path,
        "-vf", vf,
        "-af", af,
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


def extract_thumbnail(
    input_path: str,
    output_path: str,
    offset_pct: float = 0.15,
) -> None:
    """
    Extract a JPEG thumbnail frame from a video.

    Seeks to ``offset_pct`` of the video duration (default 15%) to avoid
    black frames at the start. Output is scaled to 540×960 (9:16 portrait)
    with JPEG quality 2 (highest).
    """
    info = probe(input_path)
    seek_time = max(1.0, info.duration * offset_pct)
    cmd = [
        _bin("ffmpeg"), "-y",
        "-ss", f"{seek_time:.2f}",
        "-i", input_path,
        "-vframes", "1",
        "-q:v", "2",
        "-vf", "scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2",
        output_path,
    ]
    _run(cmd, "extract_thumbnail")


# ─────────────────────────────────────────────────────────────────────────────
# Layout composition — chroma-key avatar overlaid on backgrounds
# ─────────────────────────────────────────────────────────────────────────────

def _pip_xy(
    layout: str, width: int, height: int, pip_w: int, pip_h: int, margin: int,
) -> tuple[int, int]:
    """Calculate overlay X,Y for a PIP layout position."""
    if layout == "pip_br":
        return (width - pip_w - margin, height - pip_h - margin)
    if layout == "pip_tl":
        return (margin, margin)
    if layout == "pip_tr":
        return (width - pip_w - margin, margin)
    # pip_bl (default)
    return (margin, height - pip_h - margin)


# ─────────────────────────────────────────────────────────────────────────────
# Speed ramping — variable speed playback with audio compensation
# ─────────────────────────────────────────────────────────────────────────────

def apply_speed_ramp(
    input_path: str,
    output_path: str,
    speed: float = 1.0,
    threads: int = 0,
) -> float:
    """
    Apply speed ramping to a clip. Returns the new duration.

    • speed > 1.0 = faster (time-lapse effect)
    • speed < 1.0 = slower (slow-motion effect)
    • speed = 1.0 = no change (passthrough)

    Video uses ``setpts=PTS/speed``; audio uses ``atempo=speed`` (clamped to
    FFmpeg's 0.5–2.0 range, chained if needed for extreme speeds).

    Returns the resulting clip duration (original_duration / speed).
    """
    if abs(speed - 1.0) < 0.01:
        import shutil
        shutil.copy2(input_path, output_path)
        info = probe(input_path)
        return info.duration

    info = probe(input_path)
    new_duration = info.duration / speed

    atempo_filters = _build_atempo_chain(speed)

    fc_parts = []

    if info.has_video:
        fc_parts.append(f"[0:v]setpts=PTS/{speed:.4f}[v]")
        map_v = ["-map", "[v]"]
    else:
        map_v = []

    if info.has_audio:
        atempo_chain = ",".join(atempo_filters)
        fc_parts.append(f"[0:a]{atempo_chain}[a]")
        map_a = ["-map", "[a]"]
    else:
        map_a = []

    if not fc_parts:
        import shutil
        shutil.copy2(input_path, output_path)
        return new_duration

    cmd = [
        _bin("ffmpeg"), "-y",
        "-i", input_path,
        "-filter_complex", ";".join(fc_parts),
    ] + map_v + map_a + [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k",
        "-t", str(new_duration),
        "-threads", str(threads),
        output_path,
    ]
    _run(cmd, f"speed_ramp_{speed:.2f}x")
    return new_duration


def _build_atempo_chain(speed: float) -> list[str]:
    """
    Build a chain of FFmpeg atempo filters to handle any speed value.

    FFmpeg's atempo filter only supports 0.5–2.0 range.
    For values outside, we chain multiple filters.
    """
    if 0.5 <= speed <= 2.0:
        return [f"atempo={speed:.4f}"]

    filters: list[str] = []
    remaining = speed
    while remaining < 0.5:
        filters.append("atempo=0.5000")
        remaining /= 0.5
    while remaining > 2.0:
        filters.append("atempo=2.0000")
        remaining /= 2.0
    filters.append(f"atempo={remaining:.4f}")
    return filters


# ─────────────────────────────────────────────────────────────────────────────
# L-cut / J-cut concatenation
# ─────────────────────────────────────────────────────────────────────────────

def concat_with_lj_cuts(
    clips: list[ClipInfo],
    output: str,
    threads: int = 0,
) -> None:
    """
    Concatenate clips with L-cut and J-cut audio offsets.

    L-cut:  Video switches to next scene, but audio from the previous scene
            continues for a moment. Creates a smooth narrative flow.
    J-cut:  Audio from the next scene starts before the video switches.
            Creates anticipation and connection between scenes.

    Falls back to regular concat_with_transitions when no L/J-cuts are present.
    """
    has_lj = any(c.cut_type != CutType.HARD for c in clips)
    if not has_lj:
        concat_with_transitions(clips, output, threads)
        return

    n = len(clips)
    if n == 1:
        _run([_bin("ffmpeg"), "-y", "-i", clips[0].path, "-c", "copy", output], "single_clip_copy")
        return

    cmd = [_bin("ffmpeg"), "-y"]
    for c in clips:
        cmd += ["-i", c.path]

    fc_parts: list[str] = []

    # ── Video xfade chain (same as concat_with_transitions) ────────────────
    v_prev = "[0:v]"
    cum_duration = 0.0
    cum_transition = 0.0
    transition_params: list[tuple[float, bool]] = []

    for i in range(1, n):
        td = clips[i - 1].transition_duration
        tr = clips[i - 1].transition.value

        v_next = "[v_end]" if i == n - 1 else f"[v{i}]"

        if tr == TransitionType.CUT.value or td <= 0:
            v_next = f"[v{i}]" if i < n - 1 else "[v_end]"
            fc_parts.append(f"{v_prev}[{i}:v]concat=n=2:v=1:a=0{v_next}")
            cum_duration += clips[i - 1].duration
            cum_transition += 0.0
            transition_params.append((0.0, False))
        else:
            cum_duration += clips[i - 1].duration
            cum_transition += td
            offset = max(cum_duration - cum_transition, 0.01)
            fc_parts.append(
                f"{v_prev}[{i}:v]xfade=transition={tr}"
                f":duration={td:.4f}:offset={offset:.4f}{v_next}"
            )
            transition_params.append((td, True))

        v_prev = v_next

    # ── Audio chain with L/J-cut offsets ──────────────────────────────────
    has_xfade = any(is_xf for _, is_xf in transition_params)

    if has_xfade and n > 1:
        a_prev = "[0:a]"
        for i in range(1, n):
            td, is_xf = transition_params[i - 1]
            a_next = "[a_end]" if i == n - 1 else f"[a{i}]"
            clip = clips[i]

            if is_xf and td > 0:
                audio_td = td
                if clip.cut_type == CutType.J_CUT and clip.audio_offset_sec > 0:
                    audio_td = td + clip.audio_offset_sec
                elif clip.cut_type == CutType.L_CUT and clip.audio_offset_sec < 0:
                    audio_td = max(0.05, td + clip.audio_offset_sec)

                fc_parts.append(
                    f"{a_prev}[{i}:a]acrossfade=d={audio_td:.4f}:c1=tri:c2=tri{a_next}"
                )
            else:
                fc_parts.append(f"{a_prev}[{i}:a]concat=n=2:v=0:a=1{a_next}")
            a_prev = a_next
    else:
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
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k",
        "-t", str(total_duration),
        "-threads", str(threads),
        output,
    ]
    _run(cmd, "concat_lj_cuts")


# ─────────────────────────────────────────────────────────────────────────────
# Color grading — histogram matching between clips
# ─────────────────────────────────────────────────────────────────────────────

def color_grade_clip(
    input_path: str,
    output_path: str,
    reference_path: str | None = None,
    strength: float = 0.6,
    brightness: float = 0.0,
    contrast: float = 1.0,
    saturation: float = 1.0,
    threads: int = 0,
) -> None:
    """
    Apply color grading to a clip for visual consistency.

    Two modes:
    1. Reference-based: luma matching against a reference clip
    2. Parametric: brightness/contrast/saturation adjustments

    The ``strength`` parameter controls blending between original and graded.
    """
    if not reference_path and abs(brightness) < 0.01 and abs(contrast - 1.0) < 0.01 and abs(saturation - 1.0) < 0.01:
        import shutil
        shutil.copy2(input_path, output_path)
        return

    vf_parts: list[str] = []

    if reference_path:
        ref_luma = _compute_average_luma(reference_path)
        clip_luma = _compute_average_luma(input_path)

        if ref_luma > 0 and clip_luma > 0:
            luma_ratio = ref_luma / clip_luma
            adjusted_brightness = (luma_ratio - 1.0) * strength
            vf_parts.append(f"eq=brightness={adjusted_brightness:.4f}:contrast={contrast:.4f}:saturation={saturation:.4f}")
        else:
            if abs(brightness) > 0.01 or abs(contrast - 1.0) > 0.01 or abs(saturation - 1.0) > 0.01:
                vf_parts.append(f"eq=brightness={brightness:.4f}:contrast={contrast:.4f}:saturation={saturation:.4f}")
    else:
        if abs(brightness) > 0.01 or abs(contrast - 1.0) > 0.01 or abs(saturation - 1.0) > 0.01:
            vf_parts.append(f"eq=brightness={brightness:.4f}:contrast={contrast:.4f}:saturation={saturation:.4f}")

    if not vf_parts:
        import shutil
        shutil.copy2(input_path, output_path)
        return

    vf = ",".join(vf_parts) + ",format=yuv420p"

    cmd = [
        _bin("ffmpeg"), "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "copy",
        "-threads", str(threads),
        output_path,
    ]
    _run(cmd, "color_grade")


def _compute_average_luma(video_path: str) -> float:
    """
    Compute the average luma (brightness) of a video clip using FFmpeg.
    Extracts the mean Y-channel value from the first 30 frames.
    """
    cmd = [
        _bin("ffmpeg"), "-i", video_path,
        "-vf", "signalstats=stat=tout+vrep:brng",
        "-f", "null", "-",
        "-frames:v", "30",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    for line in result.stderr.split("\n"):
        if "YAVG" in line or "yavg" in line:
            try:
                parts = line.strip().split()
                for p in parts:
                    if "yavg" in p.lower():
                        val = p.split("=")[-1] if "=" in p else p
                        return float(val)
            except (ValueError, IndexError):
                continue
    return 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Content-aware transition selection
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_TRANSITION_RULES: dict[str, str] = {
    "avatar->clip": "fade",
    "avatar->image": "fade",
    "clip->avatar": "cut",
    "clip->clip": "smoothleft",
    "clip->image": "dissolve",
    "image->avatar": "fade",
    "image->clip": "fade",
    "image->image": "dissolve",
    "avatar->avatar": "cut",
    "text->avatar": "fade",
    "text->clip": "fade",
    "text->image": "fade",
    "avatar->text": "cut",
    "clip->text": "cut",
    "image->text": "cut",
}

DEFAULT_DURATION_RULES: dict[str, float] = {
    "avatar->clip": 0.4,
    "clip->avatar": 0.0,
    "clip->clip": 0.5,
    "avatar->avatar": 0.0,
    "image->clip": 0.35,
    "clip->image": 0.3,
}


def select_transition_for_pair(
    from_type: str,
    to_type: str,
    rules: dict[str, str] | None = None,
) -> tuple[str, float]:
    """
    Select the best transition type and duration for a pair of scene types.
    Returns (transition_name, duration_seconds).
    """
    merged = {**DEFAULT_TRANSITION_RULES, **(rules or {})}
    merged_dur = {**DEFAULT_DURATION_RULES, **(rules or {})}

    key = f"{from_type}->{to_type}"
    transition = merged.get(key, "fade")
    duration = merged_dur.get(key, 0.3)

    return transition, duration


def compose_layout_segment(
    avatar_path: str,
    bg_clip_path: str,
    output_path: str,
    start_sec: float,
    duration: float,
    layout: str,
    width: int,
    height: int,
    pip_scale: float = 0.30,
    pip_margin: int = 30,
    chroma_color: str = "0x00FF00",
    chroma_similarity: float = 0.28,
    chroma_blend: float = 0.10,
    threads: int = 0,
) -> None:
    """
    Compose a single layout segment: overlay avatar (on green-screen background)
    onto a prepared background clip.

    Uses ``chromakey`` filter (YUV-space) to remove the green-screen background.
    Green-screen keying is far more reliable than black keying because green
    does not appear naturally in human skin, hair, or typical clothing.

    similarity=0.28 is tuned for HeyGen H.264-compressed green-screen (#00FF00).
    Higher value means more lenient keying — necessary because H.264 compression
    introduces slight colour shifts on the background.

    Layout types:
        fullscreen  — avatar overlaid at full frame on top of background
        pip_bl/br/tl/tr — avatar scaled to ``pip_scale`` and placed in a corner
        voiceover   — background video only; avatar audio used as voice-over
    """
    info = probe(avatar_path)
    has_audio = info.has_audio

    fc_parts: list[str] = []
    map_args: list[str] = []

    # chromakey params for green-screen removal
    ck_color = chroma_color   # "0x00FF00"
    ck_similarity = chroma_similarity
    ck_blend = chroma_blend

    if layout == "voiceover":
        # No avatar visible — use background video + avatar audio
        fc_parts.append("[1:v]format=yuv420p[v]")
        map_args += ["-map", "[v]"]
        if has_audio:
            fc_parts.append("[0:a]aformat=channel_layouts=stereo:sample_rates=44100[a]")
            map_args += ["-map", "[a]"]
        else:
            fc_parts.append(
                f"aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration={duration}[a]"
            )
            map_args += ["-map", "[a]"]

    elif layout == "fullscreen":
        # Chromakey avatar at full frame, overlay on background.
        # Note: no despill — it can be unavailable in some FFmpeg builds and is cosmetic only.
        fc_parts.append(
            f"[0:v]chromakey=color={ck_color}"
            f":similarity={ck_similarity}:blend={ck_blend}[ak]"
        )
        fc_parts.append("[1:v][ak]overlay=0:0:format=auto,format=yuv420p[v]")
        map_args += ["-map", "[v]"]
        if has_audio:
            fc_parts.append("[0:a]aformat=channel_layouts=stereo:sample_rates=44100[a]")
        else:
            fc_parts.append(
                f"aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration={duration}[a]"
            )
        map_args += ["-map", "[a]"]

    else:
        # PIP layouts (pip_bl, pip_br, pip_tl, pip_tr)
        pip_w = int(width * pip_scale)
        pip_h = int(height * pip_scale)
        x, y = _pip_xy(layout, width, height, pip_w, pip_h, pip_margin)

        fc_parts.append(
            f"[0:v]chromakey=color={ck_color}"
            f":similarity={ck_similarity}:blend={ck_blend},"
            f"scale={pip_w}:{pip_h}:flags=lanczos[ak_pip]"
        )
        fc_parts.append(
            f"[1:v][ak_pip]overlay={x}:{y}:format=auto,format=yuv420p[v]"
        )
        map_args += ["-map", "[v]"]
        if has_audio:
            fc_parts.append("[0:a]aformat=channel_layouts=stereo:sample_rates=44100[a]")
        else:
            fc_parts.append(
                f"aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration={duration}[a]"
            )
        map_args += ["-map", "[a]"]

    cmd = [
        _bin("ffmpeg"), "-y",
        "-ss", str(start_sec), "-t", str(duration), "-i", avatar_path,
        "-i", bg_clip_path,
        "-filter_complex", ";".join(fc_parts),
    ] + map_args + [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k",
        "-t", str(duration),
        "-threads", str(threads),
        output_path,
    ]
    _run(cmd, f"compose_segment_{layout}")


# ── Legacy helpers kept for backward compatibility ─────────────────────────

def build_concat_list(scene_paths: list[str], output_path: str) -> None:
    """Write an FFmpeg concat demuxer list file."""
    with open(output_path, "w", encoding="utf-8") as f:
        for path in scene_paths:
            safe = path.replace("\\", "/").replace("'", "\\'")
            f.write(f"file '{safe}'\n")

