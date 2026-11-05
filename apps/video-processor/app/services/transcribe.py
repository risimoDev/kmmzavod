"""
Speech-to-text transcription using faster-whisper for subtitle synchronisation.

Extracts audio from avatar video, runs Whisper on the audio track, and returns
word-level timestamps that can be grouped into subtitle entries.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from dataclasses import dataclass
from typing import Sequence

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WordTimestamp:
    word: str
    start: float  # seconds
    end: float    # seconds


@dataclass(frozen=True)
class SubtitleChunk:
    text: str
    start_sec: float
    end_sec: float


def _bin(name: str) -> str:
    if settings.ffmpeg_bin_dir:
        return os.path.join(settings.ffmpeg_bin_dir, name)
    return name


def extract_audio(video_path: str, audio_path: str) -> None:
    """Extract mono 16kHz WAV audio from video (Whisper input format)."""
    cmd = [
        _bin("ffmpeg"), "-y",
        "-i", video_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr[:500]}")


_model = None
_model_key: tuple[str, str] | None = None
_model_lock = threading.Lock()


def _get_model():
    """Load the Whisper model once per process (lazy, thread-safe)."""
    global _model, _model_key
    from faster_whisper import WhisperModel

    model_size = os.environ.get("WHISPER_MODEL_SIZE", "base")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    key = (model_size, device)
    with _model_lock:
        if _model is None or _model_key != key:
            compute_type = "int8" if device == "cpu" else "float16"
            # Prefer the model baked into the image (see Dockerfile / download_model.py).
            source = model_size
            try:
                from download_model import is_ready, model_dir
                if is_ready(model_size):
                    source = model_dir(model_size)
            except Exception:  # noqa: BLE001 — helper is optional, fall back to HF download
                pass
            logger.info("Loading Whisper model=%s device=%s compute=%s", source, device, compute_type)
            _model = WhisperModel(source, device=device, compute_type=compute_type)
            _model_key = key
        return _model


def transcribe_audio(audio_path: str, language: str = "ru") -> list[WordTimestamp]:
    """
    Run faster-whisper on a WAV file and return word-level timestamps.

    Uses the 'base' model for speed (~150 MB download, fast on CPU). The model
    is cached for the process lifetime.
    """
    model = _get_model()

    segments, info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    words: list[WordTimestamp] = []
    for segment in segments:
        if segment.words:
            for w in segment.words:
                words.append(WordTimestamp(
                    word=w.word.strip(),
                    start=round(w.start, 3),
                    end=round(w.end, 3),
                ))

    logger.info("Transcribed %d words, language=%s (prob=%.2f)", len(words), info.language, info.language_probability)
    return words


def group_words_into_subtitles(
    words: Sequence[WordTimestamp],
    max_words_per_chunk: int = 12,
    max_chunk_duration: float = 4.0,
    min_pause_for_split: float = 0.4,
) -> list[SubtitleChunk]:
    """
    Group word timestamps into subtitle chunks, splitting on natural pauses
    and respecting max word count / duration limits.
    """
    if not words:
        return []

    chunks: list[SubtitleChunk] = []
    current_words: list[WordTimestamp] = []

    for w in words:
        if not w.word:
            continue

        # Check if we should start a new chunk
        should_split = False

        if current_words:
            # Split if max words reached
            if len(current_words) >= max_words_per_chunk:
                should_split = True
            # Split if max duration exceeded
            elif w.end - current_words[0].start > max_chunk_duration:
                should_split = True
            # Split on natural pauses (>400ms gap between words)
            elif w.start - current_words[-1].end > min_pause_for_split:
                should_split = True

        if should_split and current_words:
            chunks.append(SubtitleChunk(
                text=" ".join(cw.word for cw in current_words),
                start_sec=round(current_words[0].start, 2),
                end_sec=round(current_words[-1].end, 2),
            ))
            current_words = []

        current_words.append(w)

    # Flush remaining words
    if current_words:
        chunks.append(SubtitleChunk(
            text=" ".join(cw.word for cw in current_words),
            start_sec=round(current_words[0].start, 2),
            end_sec=round(current_words[-1].end, 2),
        ))

    return chunks
