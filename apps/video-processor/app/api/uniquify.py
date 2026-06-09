"""
Video uniquification HTTP endpoints.

POST /uniquify/analyze  — Analyze a source video (probe, scene detection, audio profile)
POST /uniquify/render   — Render a single unique variant with specified transforms
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.services.storage import StorageClient
from app.services.uniquify import (
    VariantTransforms,
    analyze_video,
    render_unique_variant,
    generate_random_transforms,
)

logger = logging.getLogger(__name__)

_semaphore: asyncio.Semaphore | None = None
_storage: StorageClient | None = None


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(settings.max_concurrent_jobs)
    return _semaphore


def _get_storage() -> StorageClient:
    global _storage
    if _storage is None:
        _storage = StorageClient()
    return _storage


# ── Request/Response models ───────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    source_video_id: str
    storage_key: str


class AnalyzeResponse(BaseModel):
    duration_sec: float
    width: int
    height: int
    fps: float
    scene_breaks: list[float] = []
    audio_profile: dict[str, Any] = {}


class RenderRequest(BaseModel):
    variant_id: str
    uniquify_job_id: str
    tenant_id: str
    source_storage_key: str
    output_key: str
    transforms: dict[str, Any]
    transcript: list[dict[str, Any]] | None = None
    bgm_storage_key: str | None = None
    tts_storage_key: str | None = None


class RenderResponse(BaseModel):
    output_key: str
    thumbnail_key: str | None = None
    duration_sec: float
    file_size_bytes: int
    width: int
    height: int
    phash: str | None = None


class GenerateTransformsRequest(BaseModel):
    count: int = Field(default=10, ge=1, le=100)
    seed: int | None = None


class GenerateTransformsResponse(BaseModel):
    transforms: list[dict[str, Any]]


# ── Router ────────────────────────────────────────────────────────────────────

def create_router() -> APIRouter:
    router = APIRouter(prefix="/uniquify", tags=["uniquify"])

    @router.post(
        "/analyze",
        response_model=AnalyzeResponse,
        summary="Analyze source video",
    )
    async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
        """
        Download source video from storage, run analysis:
        - FFprobe for metadata (duration, resolution, fps)
        - Scene detection (scene change timestamps)
        - Audio loudness profiling
        """
        work_dir: str | None = None
        try:
            storage = _get_storage()
            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"analyze_{req.source_video_id}_{int(time.time())}")
            os.makedirs(work_dir, exist_ok=True)

            src_path = os.path.join(work_dir, "source.mp4")
            logger.info("Downloading source video %s", req.storage_key)
            await storage.download(req.storage_key, src_path)

            result = await analyze_video(src_path)

            return AnalyzeResponse(
                duration_sec=result.duration_sec,
                width=result.width,
                height=result.height,
                fps=result.fps,
                scene_breaks=result.scene_breaks,
                audio_profile=result.audio_profile,
            )
        except Exception as e:
            logger.exception("Analyze failed for %s", req.source_video_id)
            raise HTTPException(status_code=500, detail=str(e))
        finally:
            if work_dir and os.path.exists(work_dir):
                shutil.rmtree(work_dir, ignore_errors=True)

    @router.post(
        "/render",
        response_model=RenderResponse,
        summary="Render unique variant",
    )
    async def render(req: RenderRequest) -> RenderResponse:
        """
        Download source video, apply transforms, upload unique variant.
        """
        work_dir: str | None = None
        try:
            sem = _get_semaphore()
            storage = _get_storage()

            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"uniquify_{req.variant_id}_{int(time.time())}")
            os.makedirs(work_dir, exist_ok=True)

            # Download source
            src_path = os.path.join(work_dir, "source.mp4")
            logger.info("Downloading source for variant %s", req.variant_id)
            await storage.download(req.source_storage_key, src_path)

            # Parse transforms
            transforms = VariantTransforms.from_dict(req.transforms)

            # Download BGM if provided
            if req.bgm_storage_key:
                bgm_path = os.path.join(work_dir, "bgm.mp3")
                await storage.download(req.bgm_storage_key, bgm_path)
                transforms.bgm_track_path = bgm_path

            # Download TTS if provided
            if req.tts_storage_key:
                tts_path = os.path.join(work_dir, "tts.mp3")
                await storage.download(req.tts_storage_key, tts_path)
                transforms.tts_audio_path = tts_path

            output_path = os.path.join(work_dir, "output.mp4")

            async with sem:
                result = await render_unique_variant(
                    source_path=src_path,
                    output_path=output_path,
                    transforms=transforms,
                    transcript=req.transcript,
                    work_dir=work_dir,
                )

            # Upload output
            logger.info("Uploading variant %s → %s", req.variant_id, req.output_key)
            await storage.upload(req.output_key, result.output_path, "video/mp4")

            # Upload thumbnail
            thumbnail_key = None
            if result.thumbnail_path and os.path.exists(result.thumbnail_path):
                thumbnail_key = req.output_key.rsplit(".", 1)[0] + "_thumb.jpg"
                await storage.upload(thumbnail_key, result.thumbnail_path, "image/jpeg")

            return RenderResponse(
                output_key=req.output_key,
                thumbnail_key=thumbnail_key,
                duration_sec=result.duration_sec,
                file_size_bytes=result.file_size_bytes,
                width=result.width,
                height=result.height,
                phash=result.phash,
            )
        except Exception as e:
            logger.exception("Render failed for variant %s", req.variant_id)
            raise HTTPException(status_code=500, detail=str(e))
        finally:
            if work_dir and os.path.exists(work_dir):
                shutil.rmtree(work_dir, ignore_errors=True)

    @router.post(
        "/generate-transforms",
        response_model=GenerateTransformsResponse,
        summary="Generate N random transform sets",
    )
    async def gen_transforms(req: GenerateTransformsRequest) -> GenerateTransformsResponse:
        """
        Generate N sets of random transforms for batch uniquification.
        Each set is guaranteed to be different.
        """
        results = []
        for i in range(req.count):
            seed = (req.seed or 42) + i if req.seed is not None else None
            results.append(generate_random_transforms(seed))
        return GenerateTransformsResponse(transforms=results)

    return router
