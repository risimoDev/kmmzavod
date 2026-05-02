"""
Beat detection service using librosa for music-synchronised video editing.

Analyzes a music file and returns beat/onset timestamps that can be used
to synchronise scene transitions with the musical rhythm, creating a
more engaging and professional editing result.

Two analysis modes:
• beat — stable rhythmic pulses (kick drum, bass)
• onset — all transient events (percussion, note attacks, drops)

Onsets are denser and capture musical structure beyond just the beat.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BeatInfo:
    timestamps: list[float]
    bpm: float
    onset_timestamps: list[float]


def detect_beats(audio_path: str) -> BeatInfo:
    """
    Analyze a music file and return beat + onset timestamps.

    Uses librosa's beat_track for BPM and beat positions, and onset_detect
    for finer-grained musical events.

    Returns both beat timestamps (sparse, rhythmic) and onset timestamps
    (dense, structural) so callers can choose the granularity they need.
    """
    import librosa

    y, sr = librosa.load(audio_path, sr=22050, mono=True)

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='frames')
    bpm = float(tempo) if isinstance(tempo, (int, float)) else float(tempo[0])

    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units='frames')
    onset_times = librosa.frames_to_time(onset_frames, sr=sr).tolist()

    logger.info(
        "Beat detection: %.1f BPM, %d beats, %d onsets (%.1fs audio)",
        bpm, len(beat_times), len(onset_times),
        len(y) / sr,
    )

    return BeatInfo(
        timestamps=[round(t, 3) for t in beat_times],
        bpm=round(bpm, 1),
        onset_timestamps=[round(t, 3) for t in onset_times],
    )


def snap_to_beat(
    target_time: float,
    beats: list[float],
    tolerance_sec: float = 0.5,
) -> float:
    """
    Snap a target transition time to the nearest beat if within tolerance.

    If no beat is within tolerance, returns the original target_time unchanged.
    This allows natural timing when beats are sparse while still catching
    nearby beats for rhythmic alignment.
    """
    if not beats:
        return target_time

    best_delta = tolerance_sec + 1.0
    best_beat = target_time

    for b in beats:
        delta = abs(b - target_time)
        if delta < best_delta:
            best_delta = delta
            best_beat = b

    if best_delta <= tolerance_sec:
        return best_beat
    return target_time


def snap_transitions_to_beats(
    transition_times: list[float],
    beats: list[float],
    tolerance_sec: float = 0.5,
) -> list[float]:
    """
    Snap a list of transition times to the nearest beats.

    Each transition is independently snapped. If a beat is within tolerance,
    the transition aligns to it; otherwise the original timing is preserved.
    """
    return [snap_to_beat(t, beats, tolerance_sec) for t in transition_times]


def compute_beat_aligned_segment_weights(
    total_duration: float,
    num_segments: int,
    beats: list[float],
    min_segment_sec: float = 2.0,
    max_segment_sec: float = 12.0,
) -> list[float]:
    """
    Compute segment weights so that segment boundaries align with beats.

    Instead of equal-weight segments, this distributes duration across segments
    so that each boundary lands on (or near) a musical beat. This creates
    a more rhythmic, engaging edit.

    Returns a list of weights (fractions of total_duration) for each segment.
    The weights sum to 1.0.
    """
    if not beats or num_segments <= 1:
        equal_weight = 1.0 / num_segments
        return [equal_weight] * num_segments

    relevant_beats = [b for b in beats if min_segment_sec <= b <= total_duration - min_segment_sec]

    if len(relevant_beats) < num_segments - 1:
        equal_weight = 1.0 / num_segments
        return [equal_weight] * num_segments

    step = max(1, len(relevant_beats) // (num_segments - 1))
    boundary_beats = [0.0]
    for i in range(num_segments - 1):
        idx = min(i * step, len(relevant_beats) - 1)
        boundary_beats.append(relevant_beats[idx])
    boundary_beats.append(total_duration)

    weights: list[float] = []
    for i in range(num_segments):
        dur = boundary_beats[i + 1] - boundary_beats[i]
        dur = max(min_segment_sec, min(max_segment_sec, dur))
        weights.append(dur)

    total_weight = sum(weights)
    return [w / total_weight for w in weights]
