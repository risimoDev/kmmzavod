"""Moment selection → Edit Decision List (heuristic layer).

This is the cheap, local scorer that prunes the timeline into candidate clips.
Phase 2 layers the GPTunnel LLM/vision pass on top (re-rank + titles); this
heuristic already produces sensible clips on its own so the pipeline is usable
and verifiable without spending tokens.

Scoring of a window = weighted blend of audio energy, motion, face presence and
scene-boundary alignment, all normalised to 0..1.
"""

from __future__ import annotations

from app.models import EdlClip, EdlSegment, Geometry, SourceAnalysis

# Score weights (sum need not be 1; result is min-maxed later).
W_ENERGY = 0.45
W_MOTION = 0.25
W_FACE = 0.20
W_SCENE = 0.10


def _energy_in(window: tuple[float, float], energy: list[tuple[float, float]]) -> float:
    s, e = window
    vals = [lvl for (t, lvl) in energy if s <= t < e]
    return sum(vals) / len(vals) if vals else 0.0


def _scene_alignment(window: tuple[float, float], scene_breaks: list[float],
                     tol: float = 0.6) -> float:
    """1.0 if the window starts near a scene boundary, decaying otherwise."""
    if not scene_breaks:
        return 0.5
    s = window[0]
    nearest = min((abs(s - b) for b in scene_breaks), default=tol)
    return max(0.0, 1.0 - nearest / max(tol, 0.01))


def _transcript_snippet(src: SourceAnalysis, start: float, end: float, limit: int = 160) -> str:
    parts = [seg.text for seg in src.transcript if seg.end > start and seg.start < end]
    text = " ".join(p.strip() for p in parts if p.strip())
    return text[:limit].strip()


def _window_score(src: SourceAnalysis, start: float, end: float) -> float:
    energy = _energy_in((start, end), src.audio_energy)
    scene = _scene_alignment((start, end), src.scene_breaks)
    return round(
        W_ENERGY * energy
        + W_MOTION * src.motion_score
        + W_FACE * src.face_ratio
        + W_SCENE * scene,
        4,
    )


def build_highlights(sources: list[SourceAnalysis], *, target_count: int,
                     target_seconds: float) -> list[EdlClip]:
    """Slide a window over each source, score, take top non-overlapping windows."""
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
    for cand in candidates:
        _score, idx, start, end = cand
        overlap = any(
            i == idx and not (end <= s or start >= e)
            for (_sc, i, s, e) in chosen
        )
        if overlap:
            continue
        chosen.append(cand)
        if len(chosen) >= target_count:
            break

    clips: list[EdlClip] = []
    for order, (score, idx, start, end) in enumerate(chosen):
        clips.append(EdlClip(
            title=f"Highlight {order + 1}",
            order=order,
            segments=[EdlSegment(src_idx=idx, start=start, end=end, score=score)],
            transcript_snippet=_transcript_snippet(sources[idx], start, end),
        ))
    return clips


def build_mix(sources: list[SourceAnalysis], *, target_seconds: float,
              min_beat: float = 1.6, max_beat: float = 4.0) -> list[EdlClip]:
    """Assemble one clip from the best short beats across all sources."""
    beats: list[tuple[float, int, float, float]] = []  # (score, src_idx, start, end)
    for idx, src in enumerate(sources):
        bounds = [0.0] + [b for b in src.scene_breaks if 0 < b < src.duration_sec] + [src.duration_sec]
        bounds = sorted({round(b, 2) for b in bounds})
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
