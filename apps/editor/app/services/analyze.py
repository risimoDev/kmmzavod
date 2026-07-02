"""Source analysis orchestration.

Runs the cheap, local analysis layer over each source video:
probe + scene breaks + audio energy envelope, and (when the ML stack is present)
Whisper transcript + beat detection + face/motion CV. Heavy imports are lazy and
optional so the service runs degraded (without ML) for quick checks.

Moment scoring / EDL construction is Phase 2 (services/select.py); this module
only produces the SourceAnalysis that scoring consumes.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile

from app.config import settings
from app.models import SourceAnalysis, TranscriptSegment, WordToken
from app.services import ffmpeg as fx

logger = logging.getLogger(__name__)


def _transcribe(path: str) -> list[TranscriptSegment]:
    """Whisper transcript with word timestamps (faster-whisper, RU). Optional."""
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        logger.warning("faster-whisper unavailable, skipping transcript: %s", e)
        return []
    try:
        model = WhisperModel(
            settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
        )
        segments, _info = model.transcribe(
            path, language=settings.whisper_language, word_timestamps=True,
        )
        out: list[TranscriptSegment] = []
        for seg in segments:
            words = [
                WordToken(start=w.start, end=w.end, text=w.word)
                for w in (seg.words or [])
            ]
            out.append(TranscriptSegment(
                start=seg.start, end=seg.end, text=seg.text.strip(), words=words,
            ))
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("Transcription failed for %s: %s", path, e)
        return []


def _detect_beats(path: str) -> list[float]:
    """Beat timestamps via librosa. Optional."""
    try:
        import librosa
    except Exception:  # noqa: BLE001
        return []
    try:
        y, sr = librosa.load(path, sr=22050, mono=True)
        _tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        return [round(float(t), 3) for t in librosa.frames_to_time(beat_frames, sr=sr)]
    except Exception as e:  # noqa: BLE001
        logger.warning("Beat detection failed for %s: %s", path, e)
        return []


def _face_and_motion(path: str, duration: float) -> tuple[float, float]:
    """Sampled face-presence ratio and average inter-frame motion (0..1). Optional."""
    try:
        import cv2
        import numpy as np
    except Exception:  # noqa: BLE001
        return 0.0, 0.0
    try:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            return 0.0, 0.0
        cascade_path = os.path.join(
            cv2.data.haarcascades, "haarcascade_frontalface_default.xml"
        )
        face_cascade = cv2.CascadeClassifier(cascade_path)
        step = max(0.5, 1.0 / max(settings.analysis_sample_fps, 0.5))
        t, frames, face_hits = 0.0, 0, 0
        prev = None
        motion_sum = 0.0
        while t < duration:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok:
                break
            frames += 1
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (160, 90))
            if prev is not None:
                motion_sum += float(np.mean(cv2.absdiff(small, prev))) / 255.0
            prev = small
            if not face_cascade.empty():
                faces = face_cascade.detectMultiScale(gray, 1.2, 5, minSize=(60, 60))
                if len(faces) > 0:
                    face_hits += 1
            t += step
        cap.release()
        if frames == 0:
            return 0.0, 0.0
        face_ratio = round(face_hits / frames, 3)
        motion = round(min(1.0, motion_sum / max(1, frames - 1)), 3)
        return face_ratio, motion
    except Exception as e:  # noqa: BLE001
        logger.warning("Face/motion analysis failed for %s: %s", path, e)
        return 0.0, 0.0


async def analyze_source(local_path: str, storage_key: str, *,
                         with_transcript: bool = True) -> SourceAnalysis:
    """Analyse one local source video into a SourceAnalysis."""
    info = await asyncio.to_thread(fx.probe, local_path)
    result = SourceAnalysis(
        storage_key=storage_key,
        duration_sec=round(info.duration, 2),
        width=info.width, height=info.height, fps=round(info.fps, 2),
    )

    scene_t = asyncio.to_thread(fx.detect_scene_breaks, local_path)
    energy_t = asyncio.to_thread(fx.audio_energy_envelope, local_path)
    motion_t = asyncio.to_thread(_face_and_motion, local_path, info.duration)
    transcript_t = (
        asyncio.to_thread(_transcribe, local_path) if with_transcript and info.has_audio
        else asyncio.sleep(0, result=[])
    )
    beats_t = (
        asyncio.to_thread(_detect_beats, local_path) if info.has_audio
        else asyncio.sleep(0, result=[])
    )

    scenes, energy, (face_ratio, motion), transcript, beats = await asyncio.gather(
        scene_t, energy_t, motion_t, transcript_t, beats_t,
    )
    result.scene_breaks = scenes
    result.audio_energy = energy
    result.face_ratio = face_ratio
    result.motion_score = motion
    result.transcript = transcript
    result.beats = beats
    return result
