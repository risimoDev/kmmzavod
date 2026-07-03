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
    """Slide a window over each source, score, take top non-overlapping windows,
    snap boundaries to speech pauses / scene breaks."""
    candidates: list[tuple[float, int, float, float]] = []  # (score, src_idx, start, end)
    for idx, src in enumerate(sources):
        if src.duration_sec <= target_seconds:
            # Source not longer than one clip → use it whole (avoids the dead zone
            # 0.5·T…T where neither branch produced any candidate).
            candidates.append((_window_score(src, 0, src.duration_sec), idx, 0.0, src.duration_sec))
            continue
        step = max(2.0, target_seconds / 2)
        t = 0.0
        while t + target_seconds <= src.duration_sec + 0.01:
            end = min(t + target_seconds, src.duration_sec)
            candidates.append((_window_score(src, t, end), idx, round(t, 2), round(end, 2)))
            t += step

    candidates.sort(key=lambda c: c[0], reverse=True)

    # Top non-overlapping windows. Adjacent (touching) windows are fine — they
    # are different content; snapping below separates the cut points naturally.
    chosen: list[tuple[float, int, float, float]] = []
    for score, idx, start, end in candidates:
        overlap = any(
            i == idx and not (end <= s or start >= e)
            for (_sc, i, s, e) in chosen
        )
        if overlap:
            continue
        chosen.append((score, idx, start, end))
        if len(chosen) >= target_count:
            break

    # Snap to pauses, then clamp so clips of one source never overlap after the move.
    taken: dict[int, list[tuple[float, float]]] = {}
    clips: list[EdlClip] = []
    for order, (score, idx, start, end) in enumerate(chosen):
        start, end = snap_window(sources[idx], start, end)
        for (s, e) in taken.get(idx, []):
            if start < e and end > s:  # overlap introduced by snapping
                if start >= s:
                    start = min(e, end - 0.5)
                else:
                    end = max(s, start + 0.5)
        if end - start < 2.0:
            continue
        taken.setdefault(idx, []).append((start, end))
        clips.append(EdlClip(
            title=f"Highlight {order + 1}",
            order=order,
            segments=[EdlSegment(src_idx=idx, start=round(start, 2), end=round(end, 2), score=score)],
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
    """Assemble ONE montage of ~target_seconds from short chunks across all
    sources. Long spans between beat/scene bounds are SUBDIVIDED into
    beat-sized chunks — a single-scene talking-head video still yields enough
    material to fill the target (раньше давало один 4-сек кусок и всё)."""
    candidates: list[tuple[float, int, float, float]] = []  # (score, src_idx, start, end)
    for idx, src in enumerate(sources):
        bounds = _beat_bounds(src, min_beat, max_beat)
        for i in range(len(bounds) - 1):
            t, e = bounds[i], bounds[i + 1]
            while e - t >= min_beat:
                c_end = min(t + max_beat, e)
                candidates.append((_window_score(src, t, c_end), idx, round(t, 2), round(c_end, 2)))
                t = c_end

    candidates.sort(key=lambda b: b[0], reverse=True)

    # Greedy top-score, non-overlapping, until the montage is long enough.
    chosen: list[tuple[float, int, float, float]] = []
    total = 0.0
    for score, idx, s, e in candidates:
        if total >= target_seconds:
            break
        if any(i == idx and not (e <= cs or s >= ce) for (_x, i, cs, ce) in chosen):
            continue
        chosen.append((score, idx, s, e))
        total += e - s

    # Chronological order keeps the narrative watchable (не рваный шаффл).
    chosen.sort(key=lambda c: (c[1], c[2]))
    segments = [EdlSegment(src_idx=idx, start=s, end=e, score=score)
                for score, idx, s, e in chosen]

    if not segments and sources:
        segments = [EdlSegment(src_idx=0, start=0.0,
                               end=min(target_seconds, sources[0].duration_sec), score=0.0)]

    snippet = ""
    if segments:
        src0 = sources[segments[0].src_idx]
        snippet = _transcript_snippet(src0, segments[0].start, segments[0].end)
    return [EdlClip(title="Mix", order=0, segments=segments, transcript_snippet=snippet)]


def build_clips(sources: list[SourceAnalysis], geometry: Geometry, *,
                target_count: int, target_seconds: float) -> list[EdlClip]:
    if geometry == Geometry.MIX:
        return build_mix(sources, target_seconds=target_seconds)
    return build_highlights(sources, target_count=target_count, target_seconds=target_seconds)


# ── Subtitle mapping: source transcript → clip output timeline ────────────────

# xfade transition consumed between consecutive segments (mirrors render._concat).
TRANSITION_SEC = 0.35


def map_clip_subtitles(clip: EdlClip, sources: list[SourceAnalysis]):
    """Project the source transcripts onto the clip's OUTPUT timeline (per-word),
    compensating for the xfade overlap between segments. The result is stored on
    the clip, shown/edited in the storyboard, and burned verbatim at render."""
    from app.models import SubtitleLine, SubtitleWord  # local: avoid import cycle

    lines: list[SubtitleLine] = []
    offset = 0.0
    for k, seg in enumerate(clip.segments):
        if k > 0:
            offset -= TRANSITION_SEC
        if seg.src_idx >= len(sources):
            offset += seg.end - seg.start
            continue
        src = sources[seg.src_idx]
        for ts in src.transcript:
            if ts.end <= seg.start or ts.start >= seg.end:
                continue
            words = [
                SubtitleWord(
                    start=round(offset + max(w.start, seg.start) - seg.start, 2),
                    end=round(offset + min(w.end, seg.end) - seg.start, 2),
                    text=w.text.strip(),
                )
                for w in ts.words
                if w.end > seg.start and w.start < seg.end and w.text.strip()
            ]
            text = " ".join(w.text for w in words) if words else ts.text.strip()
            if not text:
                continue
            lines.append(SubtitleLine(
                start=round(offset + max(ts.start, seg.start) - seg.start, 2),
                end=round(offset + min(ts.end, seg.end) - seg.start, 2),
                text=text,
                words=words,
            ))
        offset += seg.end - seg.start
    return lines
