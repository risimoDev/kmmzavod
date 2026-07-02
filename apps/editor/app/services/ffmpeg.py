"""FFmpeg analysis primitives for the editor service.

These are the *analysis-focused* wrappers the cutting/montage brain needs:
probe, scene-break detection, an audio-loudness envelope, frame extraction and a
perceptual hash. The heavy render-side montage primitives live in video-processor
and will be consolidated into a shared ``media-core`` package at the render phase
(see docs/SMART_EDITOR_PLAN.md). Kept dependency-light: cv2/numpy imported lazily
so the service and CLI import cleanly without the full ML stack installed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass

from app.config import settings

logger = logging.getLogger(__name__)


def _bin(name: str) -> str:
    if settings.ffmpeg_bin_dir:
        return os.path.join(settings.ffmpeg_bin_dir, name)
    return name


def _safe_filter_path(path: str) -> str:
    """Escape a file path for use inside an FFmpeg filtergraph string."""
    return path.replace("\\", "/").replace(":", "\\:")


@dataclass
class ProbeInfo:
    duration: float
    width: int
    height: int
    has_video: bool
    has_audio: bool
    fps: float


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

    duration = float(data["format"].get("duration", 0) or 0)
    width = height = 0
    has_video = has_audio = False
    fps = 30.0

    for s in data.get("streams", []):
        if s["codec_type"] == "video" and not has_video:
            has_video = True
            width = s.get("width", 0)
            height = s.get("height", 0)
            num, den = (s.get("avg_frame_rate", "30/1") or "30/1").split("/")
            fps = float(num) / float(den) if float(den) > 0 else 30.0
        elif s["codec_type"] == "audio":
            has_audio = True

    return ProbeInfo(duration, width, height, has_video, has_audio, fps)


def detect_scene_breaks(path: str, threshold: float | None = None,
                        sample_fps: float | None = None, timeout: int = 300) -> list[float]:
    """Detect scene-cut timestamps via ffmpeg ``select='gt(scene,T)'``.

    Samples at a low fps to keep CPU bounded on long footage.
    """
    thr = threshold if threshold is not None else settings.scene_threshold
    sfps = sample_fps if sample_fps is not None else settings.analysis_sample_fps
    cmd = [
        _bin("ffmpeg"), "-threads", str(settings.ffmpeg_threads), "-i", path,
        "-vf", f"fps={sfps},select='gt(scene,{thr})',showinfo",
        "-vsync", "vfr", "-f", "null", "-",
    ]
    breaks: list[float] = []
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        for line in proc.stderr.split("\n"):
            m = re.search(r"pts_time:(\d+\.?\d*)", line)
            if m:
                breaks.append(round(float(m.group(1)), 2))
    except Exception as e:  # noqa: BLE001 — analysis is best-effort
        logger.warning("Scene detection failed for %s: %s", path, e)
    return breaks


def audio_energy_envelope(path: str, hop_sec: float = 0.5, timeout: int = 180) -> list[tuple[float, float]]:
    """Sample an RMS loudness envelope over the audio, normalised to 0..1.

    Uses ffmpeg ``astats`` with metadata injection so we don't need librosa for
    the cheap energy curve. Returns ``[(t_sec, level), ...]`` or ``[]`` if no audio.
    """
    info = probe(path)
    if not info.has_audio:
        return []
    win = max(0.1, hop_sec)
    cmd = [
        _bin("ffmpeg"), "-i", path,
        "-af", f"asetnsamples=n={int(44100 * win)},astats=metadata=1:reset=1,"
               f"ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-f", "null", "-",
    ]
    samples: list[tuple[float, float]] = []
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        t = 0.0
        for line in proc.stderr.split("\n"):
            m = re.search(r"RMS_level=(-?\d+\.?\d*)", line)
            if m:
                db = float(m.group(1))
                # Map dBFS (-60..0) → 0..1.
                level = max(0.0, min(1.0, (db + 60.0) / 60.0))
                samples.append((round(t, 2), round(level, 3)))
                t += win
    except Exception as e:  # noqa: BLE001
        logger.warning("Audio energy analysis failed for %s: %s", path, e)
    return samples


def extract_frame(path: str, t_sec: float, out_path: str, width: int = 480) -> None:
    """Extract a single JPEG frame at ``t_sec`` (for thumbnails / vision / phash)."""
    cmd = [
        _bin("ffmpeg"), "-y", "-ss", f"{max(0.0, t_sec):.3f}", "-i", path,
        "-vframes", "1", "-q:v", "3",
        "-vf", f"scale={width}:-2:force_original_aspect_ratio=decrease",
        out_path,
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)


def check_quality(path: str, duration: float, timeout: int = 120) -> dict:
    """Detect degenerate output (mostly-black or frozen) via ffmpeg filters.

    Returns ``{"ok": bool, "black_ratio": float, "frozen": bool, "reason": str}``.
    Best-effort: on any failure returns ok=True (never blocks a render on the gate).
    """
    result = {"ok": True, "black_ratio": 0.0, "frozen": False, "reason": ""}
    if duration <= 0:
        return result
    cmd = [
        _bin("ffmpeg"), "-i", path,
        "-vf", "blackdetect=d=0.4:pic_th=0.98,freezedetect=n=0.003:d=0.5",
        "-an", "-f", "null", "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        black_total = 0.0
        for m in re.finditer(r"black_start:(\d+\.?\d*) black_end:(\d+\.?\d*)", proc.stderr):
            black_total += float(m.group(2)) - float(m.group(1))
        frozen = "freeze_start" in proc.stderr
        black_ratio = round(min(1.0, black_total / duration), 3)
        reasons = []
        if black_ratio > 0.6:
            reasons.append(f"black {int(black_ratio * 100)}%")
        if frozen:
            reasons.append("frozen")
        result.update(
            ok=not reasons, black_ratio=black_ratio, frozen=frozen, reason=", ".join(reasons),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Quality check failed for %s: %s", path, e)
    return result


def average_hash(image_path: str) -> str | None:
    """8x8 average perceptual hash of a frame (CPU-only duplicate detection)."""
    try:
        import cv2
        import numpy as np
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return None
        img = cv2.resize(img, (8, 8), interpolation=cv2.INTER_AREA)
        bits = (img >= img.mean()).astype(np.uint8).flatten()
        return "".join(
            f"{sum(b << (3 - j) for j, b in enumerate(bits[i:i + 4])):x}"
            for i in range(0, 64, 4)
        )
    except Exception:  # noqa: BLE001
        return None
