"""
Video uniquification HTTP endpoints (montage-based).

POST /uniquify/analyze — Probe source clip(s): metadata + scene breaks.
POST /uniquify/render  — Render one unique montage variant: cut the footage to
                         the shared AI voiceover, add per-variant music + burned
                         subtitles, and produce a finished social-ready video.

Design note: the heavy creative work (script, voiceover, transcription) happens
ONCE per job in the orchestrator and is passed in here for every variant. This
endpoint is purely deterministic montage + audio assembly keyed by ``seed`` —
no AI calls, so producing 30 variants costs 30 FFmpeg renders and zero extra
tokens.
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
from app.services.uniquify import analyze_video
from app.services.montage import render_montage

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
    # Either a single key or several (pool mode). `storage_key` kept for back-compat.
    storage_key: str | None = None
    storage_keys: list[str] = Field(default_factory=list)


class SourceMeta(BaseModel):
    storage_key: str
    duration_sec: float
    width: int
    height: int
    fps: float
    scene_breaks: list[float] = []


class AnalyzeResponse(BaseModel):
    # Primary source (back-compat with single-source callers)
    duration_sec: float
    width: int
    height: int
    fps: float
    scene_breaks: list[float] = []
    audio_profile: dict[str, Any] = {}
    # All sources (pool mode)
    sources: list[SourceMeta] = []


class SubtitleIn(BaseModel):
    start_sec: float
    end_sec: float
    text: str


class RenderRequest(BaseModel):
    variant_id: str
    uniquify_job_id: str
    tenant_id: str
    source_storage_keys: list[str] = Field(min_length=1)
    voiceover_storage_key: str
    output_key: str
    seed: int
    width: int = 1080
    height: int = 1920
    fps: int = 30
    subtitles: list[SubtitleIn] = []
    subtitle_style: str = "tiktok"
    bgm_storage_key: str | None = None
    bgm_volume: float = 0.16
    voiceover_volume: float = 1.0
    beat_sync: bool = True
    # Scene-break timestamps per source clip (aligned to source_storage_keys),
    # so the montage cuts on real scene boundaries.
    scene_breaks: list[list[float]] = Field(default_factory=list)


class RenderResponse(BaseModel):
    output_key: str
    thumbnail_key: str | None = None
    duration_sec: float
    file_size_bytes: int
    width: int
    height: int
    phash: str | None = None
    segment_count: int = 0


# ── Router ────────────────────────────────────────────────────────────────────

def create_router() -> APIRouter:
    router = APIRouter(prefix="/uniquify", tags=["uniquify"])

    @router.post("/analyze", response_model=AnalyzeResponse, summary="Analyze source clip(s)")
    async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
        keys = list(req.storage_keys) or ([req.storage_key] if req.storage_key else [])
        if not keys:
            raise HTTPException(status_code=400, detail="No storage_key(s) provided")

        work_dir: str | None = None
        try:
            storage = _get_storage()
            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"analyze_{req.source_video_id}_{int(time.time())}")
            os.makedirs(work_dir, exist_ok=True)

            sources: list[SourceMeta] = []
            primary_profile: dict[str, Any] = {}
            for i, key in enumerate(keys):
                src_path = os.path.join(work_dir, f"source_{i}.mp4")
                await storage.download(key, src_path)
                result = await analyze_video(src_path)
                sources.append(SourceMeta(
                    storage_key=key,
                    duration_sec=result.duration_sec,
                    width=result.width,
                    height=result.height,
                    fps=result.fps,
                    scene_breaks=result.scene_breaks,
                ))
                if i == 0:
                    primary_profile = result.audio_profile

            p = sources[0]
            return AnalyzeResponse(
                duration_sec=p.duration_sec,
                width=p.width,
                height=p.height,
                fps=p.fps,
                scene_breaks=p.scene_breaks,
                audio_profile=primary_profile,
                sources=sources,
            )
        except Exception as e:
            logger.exception("Analyze failed for %s", req.source_video_id)
            raise HTTPException(status_code=500, detail=str(e))
        finally:
            if work_dir and os.path.exists(work_dir):
                shutil.rmtree(work_dir, ignore_errors=True)

    @router.post("/render", response_model=RenderResponse, summary="Render unique montage variant")
    async def render(req: RenderRequest) -> RenderResponse:
        work_dir: str | None = None
        try:
            sem = _get_semaphore()
            storage = _get_storage()

            base = settings.work_dir_base or tempfile.gettempdir()
            work_dir = os.path.join(base, f"uniquify_{req.variant_id}_{int(time.time())}")
            os.makedirs(work_dir, exist_ok=True)

            # Download sources.
            source_paths: list[str] = []
            for i, key in enumerate(req.source_storage_keys):
                p = os.path.join(work_dir, f"source_{i}.mp4")
                await storage.download(key, p)
                source_paths.append(p)

            # Download the shared voiceover.
            voiceover_path = os.path.join(work_dir, "voiceover.mp3")
            await storage.download(req.voiceover_storage_key, voiceover_path)

            # Download this variant's background music (if any).
            bgm_path: str | None = None
            if req.bgm_storage_key:
                bgm_path = os.path.join(work_dir, "bgm.mp3")
                await storage.download(req.bgm_storage_key, bgm_path)

            output_path = os.path.join(work_dir, "output.mp4")

            async with sem:
                result = await render_montage(
                    source_paths=source_paths,
                    voiceover_path=voiceover_path,
                    output_path=output_path,
                    work_dir=work_dir,
                    seed=req.seed,
                    width=req.width,
                    height=req.height,
                    fps=req.fps,
                    subtitles=[s.model_dump() for s in req.subtitles],
                    subtitle_style=req.subtitle_style,
                    bgm_path=bgm_path,
                    bgm_volume=req.bgm_volume,
                    voiceover_volume=req.voiceover_volume,
                    beat_sync=req.beat_sync,
                    scene_breaks_by_source=req.scene_breaks,
                )

            # Upload output + thumbnail.
            await storage.upload(req.output_key, result.output_path, "video/mp4")
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
                segment_count=result.segment_count,
            )
        except Exception as e:
            logger.exception("Render failed for variant %s", req.variant_id)
            raise HTTPException(status_code=500, detail=str(e))
        finally:
            if work_dir and os.path.exists(work_dir):
                shutil.rmtree(work_dir, ignore_errors=True)

    return router
