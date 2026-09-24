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
    # First try word-level precision so we don't include text from outside the cut bounds
    words = [
        w.text.strip() for seg in src.transcript for w in seg.words
        if w.end > start and w.start < end and w.text.strip()
    ]
    if words:
        return " ".join(words)[:limit].strip()
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
    """Natural cut points: 0.0, end of video, sentence starts/ends, speech pauses >= 0.18s, scene breaks."""
    pauses: list[float] = [0.0]
    if src.duration_sec > 0:
        pauses.append(src.duration_sec)

    words = [w for seg in src.transcript for w in seg.words]
    if words:
        pauses.append(round(words[0].start, 2))
        for a, b in zip(words, words[1:]):
            if b.start - a.end >= 0.18:
                pauses.append(round((a.end + b.start) / 2.0, 2))
            else:
                pauses.append(round(b.start, 2))
        pauses.append(round(words[-1].end, 2))

    for seg in src.transcript:
        pauses.append(round(seg.start, 2))
        pauses.append(round(seg.end, 2))

    pauses.extend(src.scene_breaks)
    return sorted(set(p for p in pauses if 0.0 <= p <= src.duration_sec))


def snap_window(src: SourceAnalysis, start: float, end: float,
                tol: float = SNAP_TOL) -> tuple[float, float]:
    """Snap boundaries to natural pauses, and critically: NEVER cut across an active word."""
    words = [w for seg in src.transcript for w in seg.words if w.text.strip()]

    # 1. Guard against cutting inside any spoken word
    if words:
        for w in words:
            if w.start < start < w.end:
                start = max(0.0, w.start - 0.04)
            if w.start < end < w.end:
                end = min(src.duration_sec, w.end + 0.04)

    # 2. Snap to nearest natural pause/sentence boundary within tolerance
    pauses = speech_pauses(src)
    if pauses:
        def _snap(t: float, is_end: bool) -> float:
            candidates = [p for p in pauses if abs(p - t) <= tol]
            if candidates:
                return min(candidates, key=lambda p: abs(p - t))
            if words:
                nearest_word_edge = min(
                    [w.end if is_end else w.start for w in words],
                    key=lambda x: abs(x - t),
                    default=t,
                )
                if abs(nearest_word_edge - t) <= 1.5:
                    return nearest_word_edge
            return t

        s, e = _snap(start, is_end=False), _snap(end, is_end=True)
        if e - s >= 2.0:
            start, end = s, e

    start = max(0.0, min(start, src.duration_sec - 0.5))
    end = max(start + 0.5, min(end, src.duration_sec))
    return round(start, 2), round(end, 2)


def build_highlights(sources: list[SourceAnalysis], *, target_count: int,
                     target_seconds: float) -> list[EdlClip]:
    """Extract top highlights across sources.
    Uses thought-based grouping (sentence clusters) when transcripts exist,
    combined with fine-grained sliding windows, ensuring the entire video is covered
    and no mid-word cuts occur."""
    candidates: list[tuple[float, int, float, float]] = []  # (score, src_idx, start, end)

    min_dur = max(4.0, target_seconds * 0.5)
    max_dur = min(180.0, target_seconds * 1.5)

    for idx, src in enumerate(sources):
        dur = src.duration_sec
        if dur <= target_seconds * 1.1:
            candidates.append((_window_score(src, 0, dur), idx, 0.0, dur))
            continue

        # Strategy A: Thought / Sentence-based clusters from Whisper
        if src.transcript:
            segs = src.transcript
            for i in range(len(segs)):
                t_start = segs[i].start
                for j in range(i, len(segs)):
                    t_end = segs[j].end
                    cluster_dur = t_end - t_start
                    if min_dur <= cluster_dur <= max_dur:
                        score = _window_score(src, t_start, t_end)
                        dur_penalty = abs(cluster_dur - target_seconds) / target_seconds * 0.1
                        candidates.append((score - dur_penalty, idx, round(t_start, 2), round(t_end, 2)))
                    elif cluster_dur > max_dur:
                        break

        # Strategy B: Sliding window over the source with small step (target_seconds / 3)
        step = max(3.0, target_seconds / 3.0)
        t = 0.0
        while t + min_dur <= dur:
            w_end = min(t + target_seconds, dur)
            candidates.append((_window_score(src, t, w_end), idx, round(t, 2), round(w_end, 2)))
            t += step

        # Tail window of the source so the ending is never ignored
        tail_start = max(0.0, dur - target_seconds)
        candidates.append((_window_score(src, tail_start, dur), idx, round(tail_start, 2), round(dur, 2)))

    # Sort all candidates by score descending
    candidates.sort(key=lambda c: c[0], reverse=True)

    # If multiple sources exist, balance candidate pool across sources
    candidates_by_src: dict[int, list[tuple[float, int, float, float]]] = {}
    for c in candidates:
        candidates_by_src.setdefault(c[1], []).append(c)

    effective_target = max(target_count, len(sources))
    balanced_candidates: list[tuple[float, int, float, float]] = []
    if len(sources) > 1:
        # Guarantee: Candidate #0 from EVERY source comes first so all sources get represented
        for s_idx in range(len(sources)):
            s_list = candidates_by_src.get(s_idx, [])
            if s_list:
                balanced_candidates.append(s_list[0])
        # Then round-robin the remaining candidates across sources
        max_len = max((len(lst) for lst in candidates_by_src.values()), default=0)
        for i in range(1, max_len):
            for s_idx in range(len(sources)):
                s_list = candidates_by_src.get(s_idx, [])
                if i < len(s_list):
                    balanced_candidates.append(s_list[i])
    else:
        balanced_candidates = candidates

    # Greedily pick top candidates allowing minimal overlap (< 35% of clip duration)
    chosen: list[tuple[float, int, float, float]] = []
    surplus_limit = max(effective_target * 2, effective_target + 4)

    for score, idx, start, end in balanced_candidates:
        dur_cand = end - start
        if dur_cand < 3.0:
            continue
        overlap = False
        for (_sc, i, s, e) in chosen:
            if i == idx:
                ov = max(0.0, min(end, e) - max(start, s))
                if ov > 0.35 * min(dur_cand, e - s):
                    overlap = True
                    break
        if overlap:
            continue
        chosen.append((score, idx, start, end))
        if len(chosen) >= surplus_limit:
            break

    # Snap boundaries to natural breath pauses, ensuring clips don't collide
    clips: list[EdlClip] = []
    taken: dict[int, list[tuple[float, float]]] = {}

    for score, idx, start, end in chosen:
        start, end = snap_window(sources[idx], start, end)
        if end - start < 3.0:
            continue

        conflict = False
        for s, e in taken.get(idx, []):
            ov = max(0.0, min(end, e) - max(start, s))
            if ov > 0.25 * (end - start):
                conflict = True
                break
        if conflict:
            continue

        taken.setdefault(idx, []).append((start, end))
        order = len(clips)
        clips.append(EdlClip(
            title=f"Highlight {order + 1}",
            order=order,
            segments=[EdlSegment(src_idx=idx, start=round(start, 2), end=round(end, 2), score=score)],
            transcript_snippet=_transcript_snippet(sources[idx], start, end),
        ))
        if len(clips) >= surplus_limit:
            break

    # Fallback guarantee: if any source has no clip in clips yet, add its top candidate!
    represented_sources = {c.segments[0].src_idx for c in clips if c.segments}
    for s_idx in range(len(sources)):
        if s_idx not in represented_sources:
            s_list = candidates_by_src.get(s_idx, [])
            if s_list:
                sc, idx, st, en = s_list[0]
                st, en = snap_window(sources[idx], st, en)
                order = len(clips)
                clips.append(EdlClip(
                    title=f"Highlight {order + 1}",
                    order=order,
                    segments=[EdlSegment(src_idx=idx, start=round(st, 2), end=round(en, 2), score=sc)],
                    transcript_snippet=_transcript_snippet(sources[idx], st, en),
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


def build_clips(sources: list[SourceAnalysis], geometry: Geometry | str, *,
                target_count: int, target_seconds: float) -> list[EdlClip]:
    if geometry in (Geometry.MIX, "mix"):
        return build_mix(sources, target_seconds=target_seconds)
    return build_highlights(sources, target_count=target_count, target_seconds=target_seconds)


# ── Subtitle mapping: source transcript → clip output timeline ────────────────

# xfade transition consumed between consecutive segments (mirrors render._concat).
TRANSITION_SEC = 0.35


def map_clip_subtitles(clip: EdlClip, sources: list[SourceAnalysis], transition_sec: float = 0.0):
    """Project the source transcripts onto the clip's OUTPUT timeline (per-word).
    For clean hard cuts (default in Highlights and speech clips), transition_sec is 0.0.
    For mix montages with crossfades, transition_sec compensates for the crossfade overlap."""
    from app.models import SubtitleLine, SubtitleWord  # local: avoid import cycle

    lines: list[SubtitleLine] = []
    offset = 0.0
    for k, seg in enumerate(clip.segments):
        if k > 0 and transition_sec > 0:
            offset -= transition_sec
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
