"""
Source-video analysis for the uniquification pipeline.

This module probes an uploaded clip: metadata (duration/resolution/fps), scene
cut detection, and an audio loudness profile. The actual montage/render lives in
`app.services.montage`; the old random-micro-transform renderer was removed
because it produced "uniqueness" that humans couldn't see and platforms could
still fingerprint (identical audio across variants).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class AnalysisResult:
    """Result of analyzing a source video."""
    duration_sec: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 30.0
    scene_breaks: list[float] = field(default_factory=list)
    audio_profile: dict[str, Any] = field(default_factory=dict)


def _ffmpeg() -> str:
    d = settings.ffmpeg_bin_dir
    return os.path.join(d, "ffmpeg") if d else "ffmpeg"


def _ffprobe() -> str:
    d = settings.ffmpeg_bin_dir
    return os.path.join(d, "ffprobe") if d else "ffprobe"


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    logger.debug("CMD: %s", " ".join(cmd))
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=True)


async def analyze_video(source_path: str) -> AnalysisResult:
    """Analyze a source video: metadata, scene breaks, audio loudness profile."""
    result = AnalysisResult()

    # 1. Probe video metadata.
    probe_cmd = [
        _ffprobe(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,duration",
        "-show_entries", "format=duration",
        "-of", "json",
        source_path,
    ]
    proc = await asyncio.to_thread(_run, probe_cmd)
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

    # 2. Scene detection (1 fps sampling to keep CPU low).
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
        for line in scene_proc.stderr.split("\n"):
            m = re.search(r"pts_time:(\d+\.?\d*)", line)
            if m:
                result.scene_breaks.append(round(float(m.group(1)), 2))
    except Exception as e:
        logger.warning("Scene detection failed: %s", e)

    # 3. Audio loudness profile.
    loud_cmd = [
        _ffmpeg(), "-threads", str(settings.ffmpeg_threads), "-i", source_path,
        "-af", "loudnorm=print_format=json",
        "-f", "null", "-",
    ]
    try:
        loud_proc = await asyncio.to_thread(
            lambda: subprocess.run(loud_cmd, capture_output=True, text=True, timeout=60)
        )
        stderr = loud_proc.stderr
        json_start = stderr.rfind("{")
        json_end = stderr.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            result.audio_profile = json.loads(stderr[json_start:json_end])
    except Exception as e:
        logger.warning("Audio analysis failed: %s", e)

    return result
