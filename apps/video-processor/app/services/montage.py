"""
Montage engine for video uniquification.

Unlike the old `uniquify.py` (which applied imperceptible anti-dedup micro-tweaks
to a single clip), this module performs a *real* edit:

  • Cuts the source footage (one clip or a pool of clips) into short beats.
  • Reorders / reselects / re-times those beats deterministically per variant
    `seed`, so every account gets a genuinely different montage.
  • Reframes to the target aspect ratio (cover-crop, not letterbox) with a
    light static punch-in for a "native" social-media look.
  • Joins beats with xfade transitions, optionally snapped to the music beat.
  • Replaces the original audio entirely with a SHARED AI voiceover plus a
    PER-VARIANT background-music track (side-chain ducked under the voice),
    so the audio fingerprint differs across variants while the voice stays one.
  • Burns word-synced subtitles (generated from the voiceover transcript) in
    the variant's chosen style.

The voiceover + subtitle transcript are generated ONCE per job by the
orchestrator and passed in here unchanged for every variant — the uniqueness
lives in the montage + music, never in re-generating the voice. That keeps
GPT/TTS spend flat regardless of how many variants are produced.

This module reuses the proven helpers in `app.services.ffmpeg` (probe,
extract_thumbnail, escaping) and `app.services.subtitle` (ASS karaoke styles).
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import subprocess
from dataclasses import dataclass, field
from typing import Any

from app.config import settings
from app.models import SubtitleEntry, SubtitleStyle
from app.services import ffmpeg as fx
from app.services.subtitle import generate_ass_file

logger = logging.getLogger(__name__)


# ── Tunables ──────────────────────────────────────────────────────────────────

MIN_BEAT_SEC = 1.6          # shortest on-screen segment
MAX_BEAT_SEC = 4.0          # longest on-screen segment
OVERSHOOT_SEC = 0.6         # build montage slightly longer than the voiceover, then trim
ZOOM_LEVELS = [1.0, 1.05, 1.10, 1.14]
SPEED_LEVELS = [0.92, 1.0, 1.0, 1.08, 1.15]
TRANSITIONS = ["fade", "dissolve", "smoothleft", "smoothright", "slideup", "wipeleft", "circleopen"]
TRANSITION_DUR_RANGE = (0.25, 0.5)


# ── Data types ────────────────────────────────────────────────────────────────

@dataclass
class SourceInfo:
    path: str
    duration: float
    width: int
    height: int
    scene_breaks: list[float] = field(default_factory=list)


def _scene_spans(src: SourceInfo) -> list[tuple[float, float]]:
    """
    Turn a source's scene-break timestamps into (start, duration) spans so cuts
    land on natural scene boundaries instead of arbitrary mid-action points.
    Falls back to one whole-clip span when no scene breaks were detected.
    """
    bounds = [0.0] + [b for b in src.scene_breaks if 0.0 < b < src.duration] + [src.duration]
    bounds = sorted({round(b, 3) for b in bounds})
    spans: list[tuple[float, float]] = []
    for i in range(len(bounds) - 1):
        start, dur = bounds[i], bounds[i + 1] - bounds[i]
        if dur >= 0.8:
            spans.append((start, dur))
    return spans or [(0.0, max(0.8, src.duration))]


@dataclass
class Segment:
    src_idx: int
    start: float            # in-point in the source (seconds)
    span: float             # source seconds to read (before speed change)
    speed: float            # playback speed (on-screen dur = span / speed)
    zoom: float             # static punch-in factor (>= 1.0)
    crop_bias_x: float      # 0..1 horizontal crop position
    crop_bias_y: float      # 0..1 vertical crop position
    transition: str         # transition INTO this segment ("cut" for the first)
    transition_dur: float

    @property
    def screen_dur(self) -> float:
        return self.span / self.speed


@dataclass
class VariantStyle:
    flip: bool = False
    brightness: float = 0.0
    contrast: float = 1.0
    saturation: float = 1.0


@dataclass
class MontagePlan:
    segments: list[Segment]
    style: VariantStyle


@dataclass
class MontageResult:
    output_path: str
    thumbnail_path: str | None
    duration_sec: float
    file_size_bytes: int
    width: int
    height: int
    phash: str | None
    segment_count: int


# ── Plan generation (deterministic per seed) ──────────────────────────────────

def build_plan(
    sources: list[SourceInfo],
    target_duration: float,
    seed: int,
    beats: list[float] | None = None,
) -> MontagePlan:
    """
    Build a deterministic edit-decision-list that fills ``target_duration``.

    The same seed always yields the same montage; different seeds yield visibly
    different cut rhythms, segment selection, ordering, framing and grade — which
    is exactly the per-account uniqueness we want.
    """
    rng = random.Random(seed)

    # Consistent per-variant colour grade + mirror (applied to every segment so
    # the whole video looks intentionally graded rather than randomly flickering).
    style = VariantStyle(
        flip=rng.random() < 0.5,
        brightness=round(rng.uniform(-0.04, 0.04), 3),
        contrast=round(rng.uniform(0.95, 1.06), 3),
        saturation=round(rng.uniform(0.92, 1.12), 3),
    )

    # Pre-compute scene spans per source so cuts align to real scene boundaries.
    scene_spans = [_scene_spans(s) for s in sources]

    goal = target_duration + OVERSHOOT_SEC
    segments: list[Segment] = []
    accumulated = 0.0          # on-screen seconds minus transition overlaps
    last_pick: tuple[int, int] | None = None  # (src_idx, span_idx) to avoid repeats
    guard = 0

    while accumulated < goal and guard < 2000:
        guard += 1
        src_idx = rng.randrange(len(sources))
        src = sources[src_idx]
        if src.duration < 0.6:
            continue

        # Pick a scene span, avoiding an immediate repeat of the same one.
        spans = scene_spans[src_idx]
        choices = list(range(len(spans)))
        if last_pick and last_pick[0] == src_idx and len(choices) > 1:
            choices.remove(last_pick[1])
        span_idx = rng.choice(choices)
        scene_start, scene_dur = spans[span_idx]
        last_pick = (src_idx, span_idx)

        speed = rng.choice(SPEED_LEVELS)
        if not segments:
            # First segment is the hook: longer and from the start of its scene.
            desired_screen = min(MAX_BEAT_SEC, max(2.2, scene_dur * 0.8))
        else:
            desired_screen = rng.uniform(MIN_BEAT_SEC, max(MIN_BEAT_SEC, min(MAX_BEAT_SEC, scene_dur)))
        span = min(desired_screen * speed, scene_dur, src.duration)
        # Avoid sub-second crumbs that look like glitches.
        if span < 0.6:
            span = min(0.8, scene_dur, src.duration)
        # In-point: at (or just after) the scene start for a clean cut-in.
        room = max(0.0, scene_dur - span)
        start = scene_start + rng.uniform(0.0, room * 0.5)

        if segments:
            transition = rng.choice(TRANSITIONS)
            tdur = round(rng.uniform(*TRANSITION_DUR_RANGE), 3)
            # A transition cannot be longer than the clips it bridges.
            tdur = min(tdur, segments[-1].screen_dur * 0.5, (span / speed) * 0.5)
            tdur = max(0.1, round(tdur, 3))
        else:
            transition, tdur = "cut", 0.0

        seg = Segment(
            src_idx=src_idx,
            start=round(start, 3),
            span=round(span, 3),
            speed=speed,
            zoom=rng.choice(ZOOM_LEVELS),
            crop_bias_x=round(rng.uniform(0.3, 0.7), 3),
            crop_bias_y=round(rng.uniform(0.3, 0.7), 3),
            transition=transition,
            transition_dur=tdur,
        )
        segments.append(seg)
        accumulated += seg.screen_dur - tdur

    # Optionally snap cut points to the music beat for a rhythmic feel.
    if beats:
        _snap_plan_to_beats(segments, beats)

    return MontagePlan(segments=segments, style=style)


def _snap_plan_to_beats(segments: list[Segment], beats: list[float]) -> None:
    """Stretch/shrink segment spans so cumulative cut times land on beats."""
    from app.services.beat_detect import snap_to_beat

    cum = 0.0
    for seg in segments:
        cut_point = cum + seg.screen_dur
        snapped = snap_to_beat(cut_point, beats, tolerance_sec=0.35)
        new_screen = max(MIN_BEAT_SEC * 0.6, snapped - cum)
        seg.span = round(new_screen * seg.speed, 3)
        cum += seg.screen_dur


# ── Per-segment preparation (single ffmpeg pass each) ─────────────────────────

def _prepare_segment(
    seg: Segment,
    src: SourceInfo,
    out_path: str,
    width: int,
    height: int,
    fps: int,
    style: VariantStyle,
    threads: int,
) -> None:
    """
    Cut, reframe, grade and speed-adjust one segment in a single encode pass.

    Reframing uses cover-crop (fill + crop) rather than letterbox so vertical
    output of horizontal footage looks native, and the static punch-in (zoom)
    + crop bias change the framing enough to break perceptual-hash matching.
    Audio is dropped entirely (-an); the voiceover is muxed later.
    """
    z = max(1.0, seg.zoom)
    sw = _even(int(round(width * z)))
    sh = _even(int(round(height * z)))

    vf_parts = [
        f"scale={sw}:{sh}:force_original_aspect_ratio=increase:flags=lanczos",
        f"crop={width}:{height}:(in_w-{width})*{seg.crop_bias_x:.3f}:(in_h-{height})*{seg.crop_bias_y:.3f}",
    ]
    if style.flip:
        vf_parts.append("hflip")
    if (abs(style.brightness) > 0.005 or abs(style.contrast - 1.0) > 0.005
            or abs(style.saturation - 1.0) > 0.005):
        vf_parts.append(
            f"eq=brightness={style.brightness:.4f}:contrast={style.contrast:.4f}"
            f":saturation={style.saturation:.4f}"
        )
    vf_parts.append(f"fps={fps}")
    if abs(seg.speed - 1.0) > 0.001:
        vf_parts.append(f"setpts={(1.0 / seg.speed):.5f}*PTS")
    vf_parts.append("format=yuv420p")

    out_dur = seg.span / seg.speed

    cmd = [
        fx._bin("ffmpeg"), "-y",
        "-ss", f"{seg.start:.3f}",
        "-t", f"{seg.span:.3f}",
        "-i", src.path,
        "-an",
        "-vf", ",".join(vf_parts),
        "-t", f"{out_dur:.3f}",
        "-c:v", "libx264", "-preset", settings.ffmpeg_interim_preset, "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-threads", str(threads),
        out_path,
    ]
    fx._run(cmd, f"montage_segment_{seg.src_idx}")


def _even(n: int) -> int:
    return n - (n % 2)


# ── Video-only xfade concat ───────────────────────────────────────────────────

def _concat_video(clip_paths: list[str], plan_segments: list[Segment], output: str, threads: int) -> float:
    """
    Concatenate prepared (video-only) segments with xfade transitions.

    Returns the total output duration. xfade offset accumulates as
    ``Σ screen_dur[0..i] − Σ transition_dur[1..i]``.
    """
    n = len(clip_paths)
    if n == 1:
        fx._run([fx._bin("ffmpeg"), "-y", "-i", clip_paths[0], "-c", "copy", output], "single_seg_copy")
        return plan_segments[0].screen_dur

    cmd = [fx._bin("ffmpeg"), "-y"]
    for p in clip_paths:
        cmd += ["-i", p]

    fc_parts: list[str] = []
    v_prev = "[0:v]"
    cum_dur = plan_segments[0].screen_dur
    cum_trans = 0.0

    for i in range(1, n):
        seg = plan_segments[i]
        tr = seg.transition
        # Clamp the transition so it never exceeds either neighbouring clip
        # (beat-snapping can shrink a segment after the plan was built).
        td = min(
            seg.transition_dur,
            plan_segments[i - 1].screen_dur * 0.5,
            seg.screen_dur * 0.5,
        )
        v_next = "[vout]" if i == n - 1 else f"[v{i}]"

        if tr == "cut" or td <= 0.05:
            fc_parts.append(f"{v_prev}[{i}:v]concat=n=2:v=1:a=0{v_next}")
            cum_dur += seg.screen_dur
        else:
            cum_trans += td
            offset = max(cum_dur - cum_trans, 0.05)
            fc_parts.append(
                f"{v_prev}[{i}:v]xfade=transition={tr}:duration={td:.4f}:offset={offset:.4f}{v_next}"
            )
            cum_dur += seg.screen_dur
        v_prev = v_next

    total = cum_dur - cum_trans

    cmd += [
        "-filter_complex", ";".join(fc_parts),
        "-map", "[vout]",
        "-an",
        "-c:v", "libx264", "-preset", settings.ffmpeg_interim_preset, "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-t", f"{total:.3f}",
        "-threads", str(threads),
        output,
    ]
    fx._run(cmd, "montage_concat")
    return total


# ── Final mux: voiceover + ducked BGM + burned subtitles ──────────────────────

def _final_mux(
    montage_video: str,
    voiceover_path: str,
    bgm_path: str | None,
    ass_path: str | None,
    output_path: str,
    duration: float,
    width: int,
    height: int,
    fps: int,
    bgm_volume: float,
    voiceover_volume: float,
    crf: int,
    threads: int,
) -> None:
    """
    Single final pass: burn subtitles + build the audio bed.

    Audio bed = AI voiceover (primary) + background music side-chain-ducked under
    the voice. `sidechaincompress` lowers the music automatically whenever the
    voiceover is speaking — cleaner than fixed-zone ducking and robust to any
    voiceover. Output is loudness-normalised (EBU R128) for consistent volume.
    """
    inputs = ["-i", montage_video, "-i", voiceover_path]
    if bgm_path:
        inputs += ["-i", bgm_path]

    # ── Video chain (+ optional subtitle burn) ───────────────────────────────
    vf = f"scale={width}:{height},fps={fps},format=yuv420p"
    if ass_path:
        vf += f",ass='{fx._safe_filter_path(ass_path)}'"
    fc_parts = [f"[0:v]{vf}[vout]"]

    # ── Audio chain ──────────────────────────────────────────────────────────
    fc_parts.append(
        f"[1:a]aformat=sample_rates=44100:channel_layouts=stereo,"
        f"volume={voiceover_volume:.3f},asplit=2[vo_mix][vo_sc]"
    )

    if bgm_path:
        fade_out_start = max(0.0, duration - 2.0)
        fc_parts.append(
            f"[2:a]aloop=loop=-1:size=2147483647,"
            f"aformat=sample_rates=44100:channel_layouts=stereo,"
            f"atrim=duration={duration:.3f},"
            f"volume={bgm_volume:.3f},"
            f"afade=t=in:st=0:d=1.2,"
            f"afade=t=out:st={fade_out_start:.3f}:d=2.0[bg]"
        )
        # Duck music under the voice (sidechain = voiceover copy).
        fc_parts.append(
            "[bg][vo_sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[bgduck]"
        )
        fc_parts.append(
            "[vo_mix][bgduck]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,"
            "loudnorm=I=-16:LRA=11:TP=-1.5[aout]"
        )
    else:
        fc_parts.append("[vo_mix]loudnorm=I=-16:LRA=11:TP=-1.5[aout]")

    cmd = [
        fx._bin("ffmpeg"), "-y",
        *inputs,
        "-filter_complex", ";".join(fc_parts),
        "-map", "[vout]", "-map", "[aout]",
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", settings.ffmpeg_final_preset, "-crf", str(crf),
        "-profile:v", "high", "-level:v", "4.1",
        "-maxrate", settings.ffmpeg_max_bitrate, "-bufsize", settings.ffmpeg_bufsize,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", settings.ffmpeg_audio_bitrate, "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        "-threads", str(threads),
        output_path,
    ]
    fx._run(cmd, "montage_final_mux")


# ── Public entry point ────────────────────────────────────────────────────────

async def render_montage(
    source_paths: list[str],
    voiceover_path: str,
    output_path: str,
    work_dir: str,
    *,
    seed: int,
    width: int,
    height: int,
    fps: int,
    subtitles: list[dict] | None = None,
    subtitle_style: str = "tiktok",
    bgm_path: str | None = None,
    bgm_volume: float = 0.16,
    voiceover_volume: float = 1.0,
    crf: int | None = None,
    threads: int | None = None,
    beat_sync: bool = True,
    scene_breaks_by_source: list[list[float]] | None = None,
) -> MontageResult:
    """
    Render one unique montage variant.

    The montage length is locked to the voiceover length: the voiceover is the
    spine, the footage is cut to fit it, the music fills the bed under the voice,
    and subtitles (already timed to the voiceover) are burned on top.
    """
    threads = threads if threads is not None else settings.ffmpeg_threads
    crf = crf if crf is not None else settings.ffmpeg_crf
    width, height = _even(width), _even(height)

    # 1. Probe inputs.
    sources: list[SourceInfo] = []
    for i, p in enumerate(source_paths):
        info = fx.probe(p)
        breaks = (scene_breaks_by_source[i]
                  if scene_breaks_by_source and i < len(scene_breaks_by_source) else [])
        sources.append(SourceInfo(
            path=p, duration=info.duration, width=info.width, height=info.height,
            scene_breaks=breaks,
        ))
    if not sources:
        raise ValueError("render_montage: no source clips provided")

    vo_info = fx.probe(voiceover_path)
    target_duration = round(vo_info.duration, 3)
    if target_duration < 0.5:
        raise ValueError(f"render_montage: voiceover too short ({target_duration}s)")

    # 2. Beat detection on this variant's music (for rhythmic cuts).
    beats: list[float] | None = None
    if bgm_path and beat_sync:
        try:
            from app.services.beat_detect import detect_beats
            beats = (await asyncio.to_thread(detect_beats, bgm_path)).timestamps
        except Exception as e:  # librosa missing / decode error → fall back to free timing
            logger.warning("Beat detection failed, using free timing: %s", e)

    # 3. Deterministic edit-decision-list.
    plan = build_plan(sources, target_duration, seed, beats=beats)
    logger.info(
        "Montage seed=%d: %d segments, target=%.1fs, sources=%d, flip=%s",
        seed, len(plan.segments), target_duration, len(sources), plan.style.flip,
    )

    # 4. Prepare each segment (parallel, capped to keep CPU sane).
    seg_paths: list[str] = []
    sem = asyncio.Semaphore(max(1, threads))

    async def _prep(i: int, seg: Segment) -> str:
        out = os.path.join(work_dir, f"seg_{i:03d}.mp4")
        async with sem:
            await asyncio.to_thread(
                _prepare_segment, seg, sources[seg.src_idx], out,
                width, height, fps, plan.style, 1,
            )
        return out

    seg_paths = await asyncio.gather(*[_prep(i, s) for i, s in enumerate(plan.segments)])
    seg_paths = list(seg_paths)

    # 5. Concatenate with transitions (video only).
    concat_path = os.path.join(work_dir, "montage_video.mp4")
    await asyncio.to_thread(_concat_video, seg_paths, plan.segments, concat_path, threads)

    # 6. Build ASS subtitles (timed to the shared voiceover).
    ass_path: str | None = None
    if subtitles and subtitle_style and subtitle_style != "none":
        ass_path = os.path.join(work_dir, "subs.ass")
        entries = [
            SubtitleEntry(
                start_sec=float(s.get("start_sec", s.get("start", 0))),
                end_sec=float(s.get("end_sec", s.get("end", 0))),
                text=str(s.get("text", "")).strip(),
            )
            for s in subtitles
            if str(s.get("text", "")).strip() and float(s.get("end_sec", s.get("end", 0))) > 0
        ]
        try:
            style_enum = SubtitleStyle(subtitle_style)
        except ValueError:
            style_enum = SubtitleStyle.TIKTOK
        await asyncio.to_thread(generate_ass_file, entries, ass_path, width, height, style_enum)

    # 7. Final mux: subtitles + voiceover + ducked music, trimmed to voiceover length.
    await asyncio.to_thread(
        _final_mux,
        concat_path, voiceover_path, bgm_path, ass_path, output_path,
        target_duration, width, height, fps, bgm_volume, voiceover_volume, crf, threads,
    )

    # 8. Thumbnail + perceptual hash.
    thumb_path = output_path.rsplit(".", 1)[0] + "_thumb.jpg"
    try:
        await asyncio.to_thread(fx.extract_thumbnail, output_path, thumb_path, 0.2)
    except Exception:
        thumb_path = None
    phash = _compute_phash(thumb_path) if thumb_path else None

    stat = os.stat(output_path)
    out_probe = fx.probe(output_path)

    return MontageResult(
        output_path=output_path,
        thumbnail_path=thumb_path,
        duration_sec=round(out_probe.duration, 2),
        file_size_bytes=stat.st_size,
        width=width,
        height=height,
        phash=phash,
        segment_count=len(plan.segments),
    )


def _compute_phash(image_path: str) -> str | None:
    """Average-hash of a frame (CPU-only duplicate detection)."""
    try:
        import cv2
        import numpy as np
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return None
        img = cv2.resize(img, (8, 8), interpolation=cv2.INTER_AREA)
        bits = (img >= img.mean()).astype(np.uint8).flatten()
        return "".join(
            f"{sum(b << (3 - j) for j, b in enumerate(bits[i:i+4])):x}"
            for i in range(0, 64, 4)
        )
    except Exception:
        return None
