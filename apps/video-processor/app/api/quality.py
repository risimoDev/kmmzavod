"""
Quality gate and beat detection HTTP endpoints.

POST /quality    — Check clip quality (blur, black frames, artifacts)
POST /beat-detect — Analyze BGM for beat timestamps
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal

from app.config import settings
from app.services.beat_detect import detect_beats
from app.services.quality_gate import check_image, check_video_clip
from app.services.storage import StorageClient

logger = logging.getLogger(__name__)

_storage: StorageClient | None = None


def _get_storage() -> StorageClient:
    global _storage
    if _storage is None:
        _storage = StorageClient()
    return _storage


class QualityCheckItem(BaseModel):
    storage_key: str
    clip_type: Literal["video", "image"] = "video"
    scene_index: int = 0


class QualityCheckRequest(BaseModel):
    clips: list[QualityCheckItem] = Field(min_length=1)


class QualityCheckIssue(BaseModel):
    scene_index: int
    issue_type: str
    severity: str
    score: float
    message: str


class QualityCheckResponse(BaseModel):
    passed: bool
    issues: list[QualityCheckIssue]
    overall_score: float


class BeatDetectRequest(BaseModel):
    storage_key: str = Field(min_length=1, description="MinIO key of the audio file")


class BeatDetectResponse(BaseModel):
    beat_timestamps: list[float]
    bpm: float
    onset_timestamps: list[float]


def create_router() -> APIRouter:
    router = APIRouter(tags=["intelligence"])

    @router.post(
        "/quality",
        response_model=QualityCheckResponse,
        summary="Check video/image quality",
    )
    async def check_quality(req: QualityCheckRequest) -> QualityCheckResponse:
        """
        Download clips from MinIO and run quality gate checks
        (blur, black frames, darkness, brightness).
        """
        from app.services.quality_gate import run_quality_gate

        storage = _get_storage()
        work_dir: str | None = None
        try:
            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"qa_{os.urandom(4).hex()}")
            os.makedirs(work_dir, exist_ok=True)

            qa_clips: list[tuple[str, str, int]] = []

            for item in req.clips:
                ext = ".jpg" if item.clip_type == "image" else ".mp4"
                local = os.path.join(work_dir, f"clip_{item.scene_index:03d}{ext}")
                await storage.download(item.storage_key, local)
                qa_clips.append((local, item.clip_type, item.scene_index))

            report = run_quality_gate(qa_clips)

            return QualityCheckResponse(
                passed=report.passed,
                issues=[
                    QualityCheckIssue(
                        scene_index=i.scene_index,
                        issue_type=i.issue_type,
                        severity=i.severity,
                        score=i.score,
                        message=i.message,
                    )
                    for i in report.issues
                ],
                overall_score=report.overall_score,
            )

        except Exception as exc:
            logger.exception("Quality check failed")
            raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")

        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)

    @router.post(
        "/beat-detect",
        response_model=BeatDetectResponse,
        summary="Detect beats in an audio file",
    )
    async def beat_detect_endpoint(req: BeatDetectRequest) -> BeatDetectResponse:
        """
        Download an audio file from MinIO and analyze it for beat/onset timestamps.
        Returns beat positions (sparse, rhythmic) and onset positions (dense, structural).
        """
        storage = _get_storage()
        work_dir: str | None = None
        try:
            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"beat_{os.urandom(4).hex()}")
            os.makedirs(work_dir, exist_ok=True)

            local = os.path.join(work_dir, "audio_source")
            await storage.download(req.storage_key, local)

            info = detect_beats(local)

            return BeatDetectResponse(
                beat_timestamps=info.timestamps,
                bpm=info.bpm,
                onset_timestamps=info.onset_timestamps,
            )

        except Exception as exc:
            logger.exception("Beat detection failed")
            raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")

        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)

    return router
