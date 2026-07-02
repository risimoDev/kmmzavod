"""Moment selection → Edit Decision List (heuristic layer).

This is the cheap, local scorer that prunes the timeline into candidate clips.
Phase 2 layers the GPTunnel LLM pass on top (full-transcript range proposal +
re-rank + titles); this heuristic already produces sensible clips on its own so
the pipeline is usable and verifiable without spending tokens.

Window score = weighted blend of audio energy, motion, face presence, SPEECH
salience and scene alignment. Motion/face use per-sample time series when the
analysis provides them (so different moments of one video score differently)
and fall back to the whole-source scalars for old analyses.

Clip boundaries are snapped to natural pauses in speech (word-timestamp gaps)
and scene breaks, so cuts never land mid-word.
"""

from __future__ import annotations

import re

from app.models import EdlClip, EdlSegment, Geometry, SourceAnalysis

# Score weights (sum need not be 1; result is min-maxed later).
W_ENERGY = 0.30
W_MOTION = 0.15
W_FACE = 0.15
W_SPEECH = 0.30
W_SCENE = 0.10

# Words that mark a hook / high-retention speech moment (RU-centric).
_HOOK_RE = re.compile(
    r"\?|\d|секрет|ошибк|никогда|важн|главн|бесплатн|лайфхак|способ|почему|"
    r"как\s|топ|деньг|внимани|шок|правд|запомни|смотри", re.IGNORECASE)
# A gap between words this long (sec) counts as a natural pause to cut on.
PAUSE_GAP = 0.35
# How far (sec) a boundary may move while snapping to a pause / scene break.
SNAP_TOL = 1.2
# Minimum silence gap (sec) between two chosen highlights of the same source.
MIN_CLIP_GAP = 2.0


def _series_in(window: tuple[float, float], series: list[tuple[float, float]],
               default: float = 0.0) -> float:
    """Mean of a (t, value) series inside the window; ``default`` if no samples."""
    s, e = window
    vals = [v for (t, v) in series if s <= t < e]
    return sum(vals) / len(vals) if vals else default


def _scene_alignment(window: tuple[float, float], scene_breaks: list[float],
                     tol: float = 0.6) -> float:
    """1.0 if the window starts near a scene boundary, decaying otherwise."""
    if not scene_breaks:
        return 0.5
    s = window[0]
    nearest = min((abs(s - b) for b in scene_breaks), default=tol)
    return max(0.0, 1.0 - nearest / max(tol, 0.01))


def _speech_salience(src: SourceAnalysis, start: float, end: float) -> float:
    """Speech coverage of the window (0..1) + a hook-marker boost."""
    if not src.transcript:
        return 0.0
    span = max(0.1, end - start)
    covered = 0.0
    hook = 0.0
    for seg in src.transcript:
        ov = min(end, seg.end) - max(start, seg.start)
        if ov <= 0:
            continue
        covered += ov
        if _HOOK_RE.search(seg.text):
            hook = 0.3
    return min(1.0, covered / span * 0.8 + hook)


def _transcript_snippet(src: SourceAnalysis, start: float, end: float, limit: int = 160) -> str:
    parts = [seg.text for seg in src.transcript if seg.end > start and seg.start < end]
    text = " ".join(p.strip() for p in parts if p.strip())
    return text[:limit].strip()


def _window_score(src: SourceAnalysis, start: float, end: float) -> float:
    w = (start, end)
    energy = _series_in(w, src.audio_energy)
    motion = _series_in(w, src.motion_series, default=src.motion_score)
    face = _series_in(w, src.face_series, default=src.face_ratio)
    speech = _speech_salience(src, start, end)
    scene = _scene_alignment(w, src.scene_breaks)
    return round(
        W_ENERGY * energy + W_MOTION * motion + W_FACE * face
        + W_SPEECH * speech + W_SCENE * scene, 4)


def speech_pauses(src: SourceAnalysis) -> list[float]:
    """Natural cut points: silence gaps between words (or segments) + scene breaks."""
    pauses: list[float] = []
    words = [w for seg in src.transcript for w in seg.words]
    if words:
        for a, b in zip(words, words[1:]):
            if b.start - a.end >= PAUSE_GAP:
                pauses.append(round((a.end + b.start) / 2.0, 2))
        pauses.append(round(words[-1].end, 2))
    else:
        for seg in src.transcript:
            pauses.append(round(seg.end, 2))
    pauses.extend(src.scene_breaks)
    return sorted(set(pauses))


def snap_window(src: SourceAnalysis, start: float, end: float,
                tol: float = SNAP_TOL) -> tuple[float, float]:
    """Snap both boundaries to the nearest pause/scene break within ``tol`` so
    cuts land on silence, never mid-word. Keeps the window valid and in-range."""
    pauses = speech_pauses(src)
    if pauses:
        def _snap(t: float) -> float:
            best = min(pauses, key=lambda p: abs(p - t))
            return best if abs(best - t) <= tol else t
        s, e = _snap(start), _snap(end)
        if e - s >= 2.0:
            start, end = s, e
    start = max(0.0, min(start, src.duration_sec - 0.5))
    end = max(start + 0.5, min(end, src.duration_sec))
    return round(start, 2), round(end, 2)


def build_highlights(sources: list[SourceAnalysis], *, target_count: int,
                     target_seconds: float) -> list[EdlClip]:
    """Slide a window over each source, score, take top non-overlapping windows
    (with a minimum gap between picks of the same source), snap to pauses."""
    candidates: list[tuple[float, int, float, float]] = []  # (score, src_idx, start, end)
    for idx, src in enumerate(sources):
        if src.duration_sec < target_seconds * 0.5:
            # Source shorter than a clip → use it whole.
            candidates.append((_window_score(src, 0, src.duration_sec), idx, 0.0, src.duration_sec))
            continue
        step = max(2.0, target_seconds / 2)
        t = 0.0
        while t + target_seconds <= src.duration_sec + 0.01:
            end = min(t + target_seconds, src.duration_sec)
            candidates.append((_window_score(src, t, end), idx, round(t, 2), round(end, 2)))
            t += step

    candidates.sort(key=lambda c: c[0], reverse=True)

    chosen: list[tuple[float, int, float, float]] = []
    for score, idx, start, end in candidates:
        clash = any(
            i == idx and not (end + MIN_CLIP_GAP <= s or start >= e + MIN_CLIP_GAP)
            for (_sc, i, s, e) in chosen
        )
        if clash:
            continue
        chosen.append((score, idx, start, end))
        if len(chosen) >= target_count:
            break

    clips: list[EdlClip] = []
    for order, (score, idx, start, end) in enumerate(chosen):
        start, end = snap_window(sources[idx], start, end)
        clips.append(EdlClip(
            title=f"Highlight {order + 1}",
            order=order,
            segments=[EdlSegment(src_idx=idx, start=start, end=end, score=score)],
            transcript_snippet=_transcript_snippet(sources[idx], start, end),
        ))
    return clips


def _beat_bounds(src: SourceAnalysis, min_beat: float, max_beat: float) -> list[float]:
    """Cut bounds for mix mode: the musical beat grid thinned to ≥min_beat
    spacing when beats exist, otherwise scene breaks."""
    if src.beats:
        bounds = [0.0]
        for b in src.beats:
            if b - bounds[-1] >= min_beat and b < src.duration_sec:
                bounds.append(round(b, 2))
        bounds.append(src.duration_sec)
        return sorted(set(bounds))
    return sorted({0.0, src.duration_sec,
                   *(round(b, 2) for b in src.scene_breaks if 0 < b < src.duration_sec)})


def build_mix(sources: list[SourceAnalysis], *, target_seconds: float,
              min_beat: float = 1.6, max_beat: float = 4.0) -> list[EdlClip]:
    """Assemble one clip from the best short beats across all sources. Segment
    bounds ride the musical beat grid when available (beat-synced montage)."""
    beats: list[tuple[float, int, float, float]] = []  # (score, src_idx, start, end)
    for idx, src in enumerate(sources):
        bounds = _beat_bounds(src, min_beat, max_beat)
        for i in range(len(bounds) - 1):
            s, e = bounds[i], bounds[i + 1]
            span = e - s
            if span < min_beat:
                continue
            e = s + min(span, max_beat)
            beats.append((_window_score(src, s, e), idx, round(s, 2), round(e, 2)))

    beats.sort(key=lambda b: b[0], reverse=True)

    segments: list[EdlSegment] = []
    total = 0.0
    for score, idx, s, e in beats:
        if total >= target_seconds:
            break
        segments.append(EdlSegment(src_idx=idx, start=s, end=e, score=score))
        total += e - s

    if not segments and sources:
        segments = [EdlSegment(src_idx=0, start=0.0,
                               end=min(target_seconds, sources[0].duration_sec), score=0.0)]

    return [EdlClip(title="Mix", order=0, segments=segments)]


def build_clips(sources: list[SourceAnalysis], geometry: Geometry, *,
                target_count: int, target_seconds: float) -> list[EdlClip]:
    if geometry == Geometry.MIX:
        return build_mix(sources, target_seconds=target_seconds)
    return build_highlights(sources, target_count=target_count, target_seconds=target_seconds)
