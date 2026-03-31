"""
Video composition HTTP endpoints.

POST /compose          — Submit a composition job (synchronous; blocks until done)
GET  /compose/{job_id} — Reserved for future async job status polling

The endpoint runs the full pipeline synchronously within the request lifecycle.
Concurrency is capped by the ``max_concurrent_jobs`` semaphore so that multiple
simultaneous large jobs don't saturate all CPU cores at once.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import time

from fastapi import APIRouter, HTTPException, Request

from app.config import settings
from app.models import ComposeRequest, ComposeResponse, LayoutComposeRequest
from app.services.pipeline import CompositionPipeline, LayoutCompositionPipeline
from app.services.storage import StorageClient

logger = logging.getLogger(__name__)

# Global semaphore: limits simultaneous FFmpeg pipelines
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


def create_router() -> APIRouter:
    router = APIRouter(tags=["compose"])

    @router.post(
        "/compose",
        response_model=ComposeResponse,
        summary="Compose video from scenes",
    )
    async def compose_video(req: ComposeRequest) -> ComposeResponse:
        """
        Run the full video composition pipeline:

        1. Download scene assets from MinIO
        2. Normalize and animate clips (Ken Burns for images)
        3. Concatenate with xfade transitions
        4. Burn ASS subtitles
        5. Mix optional background music
        6. Final H.264 encode optimised for social media
        7. Upload result to MinIO

        Returns output key, duration, file size, and dimensions.
        """
        work_dir: str | None = None
        try:
            sem = _get_semaphore()
            storage = _get_storage()

            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"job_{req.job_id}_{int(time.time())}")
            os.makedirs(work_dir, exist_ok=True)

            logger.info(
                "Starting job %s | %d scenes | subtitles=%d | bgm=%s",
                req.job_id,
                len(req.scenes),
                len(req.subtitles),
                bool(req.audio_track),
            )

            async with sem:
                pipeline = CompositionPipeline(
                    request=req,
                    work_dir=work_dir,
                    storage=storage,
                    threads=settings.ffmpeg_threads,
                )
                return await pipeline.run()

        except FileNotFoundError as exc:
            logger.error("Asset not found for job %s: %s", req.job_id, exc)
            raise HTTPException(status_code=404, detail=f"Asset not found: {exc}")

        except Exception as exc:
            logger.exception("Pipeline failed for job %s", req.job_id)
            raise HTTPException(
                status_code=500,
                detail=f"{type(exc).__name__}: {exc}",
            )

        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)

    @router.post(
        "/compose-layout",
        response_model=ComposeResponse,
        summary="Compose video with layout-based avatar overlay",
    )
    async def compose_layout(req: LayoutComposeRequest) -> ComposeResponse:
        """
        Layout-based composition: avatar video (on black background) is overlaid
        on background assets using lumakey alpha channel extraction, according to
        a segment plan that alternates between
        fullscreen avatar, PIP (corner), and voice-over segments.

        Pipeline stages: download → compute timings → prepare BGs →
        composite segments → concat → subtitles → BGM → encode → upload.
        """
        work_dir: str | None = None
        try:
            sem = _get_semaphore()
            storage = _get_storage()

            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"layout_{req.job_id}_{int(time.time())}")
            os.makedirs(work_dir, exist_ok=True)

            logger.info(
                "Starting layout job %s | %d segments | avatar=%s",
                req.job_id, len(req.segments), req.avatar_storage_key,
            )

            async with sem:
                pipeline = LayoutCompositionPipeline(
                    request=req,
                    work_dir=work_dir,
                    storage=storage,
                    threads=settings.ffmpeg_threads,
                )
                return await pipeline.run()

        except FileNotFoundError as exc:
            logger.error("Asset not found for layout job %s: %s", req.job_id, exc)
            raise HTTPException(status_code=404, detail=f"Asset not found: {exc}")

        except Exception as exc:
            logger.exception("Layout pipeline failed for job %s", req.job_id)
            raise HTTPException(
                status_code=500,
                detail=f"{type(exc).__name__}: {exc}",
            )

        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)

    return router
