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

import random
import re
from dataclasses import dataclass

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
                     target_seconds: float, seed: int | None = None,
                     exclude_ranges: list[list[tuple[float, float]]] | None = None) -> list[EdlClip]:
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

    # Variety: deprioritise already-used ranges and (with a seed) add mild
    # ranking noise so re-rolls surface different, still strong, moments.
    if exclude_ranges or seed is not None:
        rng = random.Random(seed or 0)
        adjusted = []
        for sc, idx, st, en in candidates:
            used = exclude_ranges[idx] if exclude_ranges and idx < len(exclude_ranges) else []
            ov = sum(max(0.0, min(en, e) - max(st, s)) for s, e in used)
            if en > st and ov / (en - st) > 0.3:
                sc *= 0.3
            if seed is not None:
                sc += rng.gauss(0.0, 0.04)
            adjusted.append((sc, idx, st, en))
        candidates = adjusted

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


def _beat_bounds(src: SourceAnalysis, min_beat: float) -> list[float]:
    """Natural cut grid for mix mode: the musical beat grid thinned to ≥min_beat
    spacing when beats exist, otherwise scene breaks (+ source edges)."""
    if src.beats:
        bounds = [0.0]
        for b in src.beats:
            if b - bounds[-1] >= min_beat and b < src.duration_sec:
                bounds.append(round(b, 2))
        bounds.append(src.duration_sec)
        return sorted(set(bounds))
    return sorted({0.0, src.duration_sec,
                   *(round(b, 2) for b in src.scene_breaks if 0 < b < src.duration_sec)})


# ── Mix engine v2 ─────────────────────────────────────────────────────────────
#
# One analysis → K distinct montages. Each montage is a greedy fill over scored
# chunks, but the ranking key is  quality × penalties + seeded noise, so:
#   • the same seed reproduces the same storyboard;
#   • a different seed (or a different variant k) gives a different but still
#     high-quality selection;
#   • chunks overlapping `exclude_ranges` (used by earlier montages) or chosen by
#     an earlier variant of this request are deprioritised, not banned — small
#     pools still produce full-length videos.

PACE_RANGES: dict[str, tuple[float, float]] = {
    "calm": (2.4, 5.0),
    "normal": (1.6, 3.6),
    "fast": (1.0, 2.4),
}
# Keep-audio chunks follow sentences; a sentence longer than this is split at
# the word gap nearest to its middle.
MAX_SPEECH_CHUNK = 9.0
NOISE_SIGMA = 0.16        # seeded ranking noise (scores are normalised 0..1)
EXCLUDE_PENALTY = 0.3     # multiplier for chunks overlapping already-used ranges
REUSE_PENALTY = 0.35      # multiplier for chunks used by an earlier variant


@dataclass
class _Chunk:
    src_idx: int
    start: float
    end: float
    score: float = 0.0

    @property
    def dur(self) -> float:
        return self.end - self.start

    def overlap(self, s: float, e: float) -> float:
        return max(0.0, min(self.end, e) - max(self.start, s))


def _visual_score(src: SourceAnalysis, start: float, end: float) -> float:
    """Voiceover projects discard the source audio → rank by what is SEEN."""
    w = (start, end)
    motion = _series_in(w, src.motion_series, default=src.motion_score)
    face = _series_in(w, src.face_series, default=src.face_ratio)
    scene = _scene_alignment(w, src.scene_breaks)
    energy = _series_in(w, src.audio_energy)  # weak proxy for "something happens"
    return 0.45 * motion + 0.30 * face + 0.15 * scene + 0.10 * energy


def _split_speech(words: list, start: float, end: float) -> list[tuple[float, float]]:
    """Split an over-long sentence at the word gap closest to its midpoint (recursively)."""
    if end - start <= MAX_SPEECH_CHUNK:
        return [(start, end)]
    inner = [w for w in words if start < w.start < end]
    if len(inner) < 2:
        return [(start, end)]
    mid = (start + end) / 2.0
    cut_word = min(inner[1:], key=lambda w: abs(w.start - mid))
    cut = round(cut_word.start - 0.03, 2)
    if cut - start < 1.0 or end - cut < 1.0:
        return [(start, end)]
    return _split_speech(words, start, cut) + _split_speech(words, cut, end)


def _speech_chunks(src: SourceAnalysis, idx: int, min_b: float) -> list[_Chunk]:
    """Sentence-aligned chunks for keep-audio mixes (never cut mid-phrase)."""
    words = [w for seg in src.transcript for w in seg.words if w.text.strip()]
    spans: list[tuple[float, float]] = []
    pending: tuple[float, float] | None = None
    for seg in src.transcript:
        s, e = max(0.0, seg.start - 0.05), min(src.duration_sec, seg.end + 0.08)
        if pending is not None:
            s = pending[0]
        if e - s < min_b:
            pending = (s, e)          # too short — merge with the next sentence
            continue
        pending = None
        spans.extend(_split_speech(words, s, e))
    if pending is not None and pending[1] - pending[0] >= min_b * 0.6:
        spans.append(pending)
    return [_Chunk(idx, round(s, 2), round(e, 2)) for s, e in spans if e - s >= 0.8]


def _visual_chunks(src: SourceAnalysis, idx: int, min_b: float, max_b: float,
                   gaps: list[tuple[float, float]] | None = None) -> list[_Chunk]:
    """Beat/scene-aligned chunks. Spans between bounds are subdivided into
    shot-sized pieces twice — on-grid and half-shot shifted — so different seeds
    can pick visibly different windows of the same footage."""
    regions = gaps if gaps is not None else [(0.0, src.duration_sec)]
    bounds = _beat_bounds(src, min_b)
    shot = (min_b + max_b) / 2.0
    out: list[_Chunk] = []
    for r0, r1 in regions:
        cuts = [b for b in bounds if r0 < b < r1]
        edges = [r0, *cuts, r1]
        for a, b in zip(edges, edges[1:]):
            for phase in (0.0, shot / 2.0):
                t = a + phase
                while b - t >= min_b:
                    e = min(t + shot, b)
                    if b - e < min_b * 0.5:   # don't leave a sliver — absorb it
                        e = min(b, t + max_b)
                    out.append(_Chunk(idx, round(t, 2), round(e, 2)))
                    t = e
    return out


def _source_chunks(src: SourceAnalysis, idx: int, *, keep_audio: bool,
                   min_b: float, max_b: float) -> list[_Chunk]:
    if keep_audio and src.transcript:
        speech = _speech_chunks(src, idx, min_b)
        # Silent stretches between sentences still yield visual chunks.
        gaps: list[tuple[float, float]] = []
        prev = 0.0
        for c in sorted(speech, key=lambda c: c.start):
            if c.start - prev >= min_b:
                gaps.append((prev, c.start))
            prev = max(prev, c.end)
        if src.duration_sec - prev >= min_b:
            gaps.append((prev, src.duration_sec))
        return speech + _visual_chunks(src, idx, min_b, max_b, gaps)
    return _visual_chunks(src, idx, min_b, max_b)


def _excluded_fraction(c: _Chunk, ranges: list[tuple[float, float]]) -> float:
    if not ranges or c.dur <= 0:
        return 0.0
    return min(1.0, sum(c.overlap(s, e) for s, e in ranges) / c.dur)


def _order_segments(chosen: list[_Chunk], *, keep_audio: bool, hook_first: bool,
                    rng: random.Random) -> list[_Chunk]:
    """keep → chronological per source (speech stays coherent);
    replace → sources interleaved (visual rhythm) with the best shot first."""
    if keep_audio:
        return sorted(chosen, key=lambda c: (c.src_idx, c.start))
    by_src: dict[int, list[_Chunk]] = {}
    for c in sorted(chosen, key=lambda c: c.start):
        by_src.setdefault(c.src_idx, []).append(c)
    order_src = list(by_src)
    rng.shuffle(order_src)
    seq: list[_Chunk] = []
    while any(by_src.values()):
        for s in order_src:
            if by_src[s]:
                seq.append(by_src[s].pop(0))
    if hook_first and len(seq) > 1:
        best = max(range(len(seq)), key=lambda i: seq[i].score)
        seq.insert(0, seq.pop(best))
    return seq


def _coverage(chunks: list[_Chunk]) -> float:
    """Seconds of distinct footage covered by the chunk pool (union per source)."""
    total = 0.0
    for idx in {c.src_idx for c in chunks}:
        spans = sorted((c.start, c.end) for c in chunks if c.src_idx == idx)
        cur_s, cur_e = spans[0]
        for s, e in spans[1:]:
            if s <= cur_e:
                cur_e = max(cur_e, e)
            else:
                total += cur_e - cur_s
                cur_s, cur_e = s, e
        total += cur_e - cur_s
    return total


def build_mix_variants(
    sources: list[SourceAnalysis], *, target_seconds: float, variant_count: int = 1,
    seed: int | None = None, pace: str = "normal", keep_audio: bool = True,
    hook_first: bool = True, exclude_ranges: list[list[tuple[float, float]]] | None = None,
) -> list[EdlClip]:
    """K distinct montages of ~target_seconds from all sources (see notes above)."""
    min_b, max_b = PACE_RANGES.get(str(getattr(pace, "value", pace)), PACE_RANGES["normal"])
    transitions = not keep_audio
    td = TRANSITION_SEC if transitions else 0.0
    excl = exclude_ranges or []

    pool: list[_Chunk] = []
    for idx, src in enumerate(sources):
        if src.duration_sec <= 0:
            continue
        for c in _source_chunks(src, idx, keep_audio=keep_audio, min_b=min_b, max_b=max_b):
            c.score = (_window_score(src, c.start, c.end) if keep_audio
                       else _visual_score(src, c.start, c.end))
            pool.append(c)
    if not pool:
        if not sources:
            return []
        end = min(target_seconds, max(1.0, sources[0].duration_sec))
        return [EdlClip(title="Монтаж", order=0, transitions=transitions,
                        segments=[EdlSegment(src_idx=0, start=0.0, end=round(end, 2))])]

    lo, hi = min(c.score for c in pool), max(c.score for c in pool)
    for c in pool:
        c.score = round((c.score - lo) / (hi - lo), 4) if hi > lo else 0.5

    n_src = len({c.src_idx for c in pool})
    # One source may fill at most this share of a multi-source montage.
    src_cap = target_seconds * (1.0 if n_src == 1 else max(0.5, 2.0 / n_src))
    material = _coverage(pool)
    base_seed = seed if seed is not None else 0

    used_before: list[_Chunk] = []
    clips: list[EdlClip] = []
    for k in range(max(1, variant_count)):
        rng = random.Random(base_seed * 7919 + k * 104729 + 17)
        keys: dict[int, float] = {}
        for i, c in enumerate(pool):
            q = c.score
            frac = _excluded_fraction(c, excl[c.src_idx] if c.src_idx < len(excl) else [])
            if frac > 0.3:
                q *= EXCLUDE_PENALTY
            if any(u.src_idx == c.src_idx and c.overlap(u.start, u.end) > 0.5 * c.dur
                   for u in used_before):
                q *= REUSE_PENALTY
            keys[i] = q + rng.gauss(0.0, NOISE_SIGMA)
        ranked = [pool[i] for i in sorted(keys, key=keys.get, reverse=True)]

        chosen: list[_Chunk] = []
        per_src: dict[int, float] = {}

        def out_len() -> float:
            return sum(c.dur for c in chosen) - td * max(0, len(chosen) - 1)

        def fits(c: _Chunk, cap: bool) -> bool:
            if any(x.src_idx == c.src_idx and c.overlap(x.start, x.end) > 0.05 for x in chosen):
                return False
            return not cap or per_src.get(c.src_idx, 0.0) + c.dur <= src_cap + 0.5

        def take(c: _Chunk) -> None:
            chosen.append(_Chunk(c.src_idx, c.start, c.end, c.score))  # copy: _grow mutates
            per_src[c.src_idx] = per_src.get(c.src_idx, 0.0) + c.dur

        # «Из нескольких видео» — every source contributes its best keyed chunk.
        if n_src > 1:
            firsts: dict[int, _Chunk] = {}
            for c in ranked:
                firsts.setdefault(c.src_idx, c)
            for c in firsts.values():
                if out_len() < target_seconds:
                    take(c)
        for cap in (True, False):            # second pass lifts the per-source cap
            for i, c in enumerate(ranked):
                if out_len() >= target_seconds:
                    break
                if not fits(c, cap):
                    continue
                remaining = target_seconds - out_len() + (td if chosen else 0.0)
                if remaining < c.dur and remaining < max_b * 2:
                    # Closing shot: among the next good candidates take the one
                    # that lands closest to the target (no big overshoot).
                    near = [x for x in ranked[i:i + 12] if fits(x, cap)]
                    c = min(near, key=lambda x: abs(x.dur - remaining))
                take(c)

        # Greedy picks leave sub-shot gaps between chunks: grow chosen chunks
        # into adjacent free footage before declaring a shortage.
        if not keep_audio and out_len() < target_seconds:
            _grow(chosen, sources, need=target_seconds - out_len(), max_len=max_b * 1.6)

        warning = ""
        short = target_seconds - out_len()
        if short > 0.5:
            if short > target_seconds * 0.2 and chosen:
                # Not enough distinct footage: reuse the best chunks rather than
                # leave the voiceover running past the picture.
                recycled = sorted(chosen, key=lambda c: c.score, reverse=True)
                i = 0
                while out_len() < target_seconds and i < len(recycled) * 4:
                    r = recycled[i % len(recycled)]
                    chosen.append(_Chunk(r.src_idx, r.start, r.end, r.score))
                    i += 1
                warning = (f"Мало исходного материала (~{material:.0f}с на {target_seconds:.0f}с ролика) — "
                           "часть кадров повторяется. Добавьте исходников.")
            else:
                warning = (f"Материала чуть меньше цели ({out_len():.1f}с из {target_seconds:.0f}с) — "
                           "при рендере видео будет слегка замедлено.")

        seq = _order_segments(chosen, keep_audio=keep_audio, hook_first=hook_first, rng=rng)
        # Trim the tail so the montage lands on the target length — only for
        # voiceover montages; with original speech a trim could cut a word.
        excess = sum(c.dur for c in seq) - td * max(0, len(seq) - 1) - target_seconds
        if not keep_audio and excess > 0.05 and seq:
            # Spread the trim over the last shots (each keeps ≥ 0.8·min shot).
            for i in range(len(seq) - 1, -1, -1):
                if excess <= 0.05:
                    break
                c = seq[i]
                cut = min(excess, c.dur - min_b * 0.8)
                if cut > 0.05:
                    seq[i] = _Chunk(c.src_idx, c.start, round(c.end - cut, 2), c.score)
                    excess -= cut

        used_before.extend(seq)
        snippet = ""
        if keep_audio and seq:
            snippet = _transcript_snippet(sources[seq[0].src_idx], seq[0].start, seq[0].end)
        clips.append(EdlClip(
            title=f"Монтаж {k + 1}" if variant_count > 1 else "Монтаж",
            order=k,
            transitions=transitions,
            warning=warning,
            segments=[EdlSegment(src_idx=c.src_idx, start=c.start, end=c.end, score=c.score)
                      for c in seq],
            transcript_snippet=snippet,
        ))
    return clips


def _grow(chosen: list[_Chunk], sources: list[SourceAnalysis], *, need: float,
          max_len: float) -> None:
    """Extend chosen chunks into free adjacent footage (end first, then start),
    best chunks first, until ``need`` seconds are added or nothing can grow."""
    for c in sorted(chosen, key=lambda c: c.score, reverse=True):
        if need <= 0.05:
            return
        dur_src = sources[c.src_idx].duration_sec
        others = [x for x in chosen if x is not c and x.src_idx == c.src_idx]
        room_end = min([x.start for x in others if x.start >= c.end - 0.01] + [dur_src]) - c.end
        add = max(0.0, min(room_end - 0.05, max_len - c.dur, need))
        if add > 0.1:
            c.end = round(c.end + add, 2)
            need -= add
        room_start = c.start - max([x.end for x in others if x.end <= c.start + 0.01] + [0.0])
        add = max(0.0, min(room_start - 0.05, max_len - c.dur, need))
        if add > 0.1:
            c.start = round(c.start - add, 2)
            need -= add


def build_mix(sources: list[SourceAnalysis], *, target_seconds: float) -> list[EdlClip]:
    """Back-compat single montage (keep audio, deterministic)."""
    return build_mix_variants(sources, target_seconds=target_seconds, variant_count=1,
                              seed=0, keep_audio=True, hook_first=False)


def build_clips(sources: list[SourceAnalysis], geometry: Geometry | str, *,
                target_count: int, target_seconds: float, variant_count: int = 1,
                seed: int | None = None, pace: str = "normal", keep_audio: bool = True,
                hook_first: bool = True,
                exclude_ranges: list[list[tuple[float, float]]] | None = None) -> list[EdlClip]:
    if geometry in (Geometry.MIX, "mix"):
        return build_mix_variants(
            sources, target_seconds=target_seconds, variant_count=variant_count, seed=seed,
            pace=pace, keep_audio=keep_audio, hook_first=hook_first, exclude_ranges=exclude_ranges)
    return build_highlights(sources, target_count=target_count, target_seconds=target_seconds,
                            seed=seed, exclude_ranges=exclude_ranges)


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
