"""
Transcription HTTP endpoint for subtitle synchronisation.

POST /transcribe — Extract speech timestamps from a stored video.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.services.storage import StorageClient
from app.services.transcribe import (
    extract_audio,
    group_words_into_subtitles,
    transcribe_audio,
)

logger = logging.getLogger(__name__)


class TranscribeRequest(BaseModel):
    storage_key: str = Field(min_length=1, description="MinIO key of the video to transcribe")
    language: str = Field(default="ru", min_length=2, max_length=5)
    max_words_per_chunk: int = Field(default=12, ge=3, le=30)


class SubtitleItem(BaseModel):
    start_sec: float
    end_sec: float
    text: str


class TranscribeResponse(BaseModel):
    subtitles: list[SubtitleItem]
    word_count: int
    duration_sec: float


_storage: StorageClient | None = None


def _get_storage() -> StorageClient:
    global _storage
    if _storage is None:
        _storage = StorageClient()
    return _storage


def create_router() -> APIRouter:
    router = APIRouter(tags=["transcribe"])

    @router.post(
        "/transcribe",
        response_model=TranscribeResponse,
        summary="Transcribe video audio for subtitle sync",
    )
    async def transcribe_video(req: TranscribeRequest) -> TranscribeResponse:
        """
        Download a video from MinIO, extract audio, run Whisper to get
        word-level timestamps, and return subtitle chunks.
        """
        work_dir: str | None = None
        try:
            storage = _get_storage()

            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"transcribe_{os.urandom(4).hex()}")
            os.makedirs(work_dir, exist_ok=True)

            video_path = os.path.join(work_dir, "input.mp4")
            audio_path = os.path.join(work_dir, "audio.wav")

            logger.info("Transcribing %s (lang=%s)", req.storage_key, req.language)

            await storage.download(req.storage_key, video_path)
            extract_audio(video_path, audio_path)
            words = transcribe_audio(audio_path, language=req.language)

            if not words:
                return TranscribeResponse(subtitles=[], word_count=0, duration_sec=0)

            chunks = group_words_into_subtitles(
                words,
                max_words_per_chunk=req.max_words_per_chunk,
            )

            duration = words[-1].end if words else 0
            subtitles = [
                SubtitleItem(start_sec=c.start_sec, end_sec=c.end_sec, text=c.text)
                for c in chunks
            ]

            logger.info(
                "Transcription done: %d words → %d subtitle chunks, %.1fs",
                len(words), len(subtitles), duration,
            )

            return TranscribeResponse(
                subtitles=subtitles,
                word_count=len(words),
                duration_sec=round(duration, 2),
            )

        except FileNotFoundError as exc:
            logger.error("Asset not found: %s", exc)
            raise HTTPException(status_code=404, detail=f"Asset not found: {exc}")

        except Exception as exc:
            logger.exception("Transcription failed for %s", req.storage_key)
            raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")

        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)

    return router
