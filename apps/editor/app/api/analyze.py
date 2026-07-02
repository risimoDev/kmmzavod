"""Analyze router — phase 1 of the two-phase editor flow.

Resolves each source (presigned URL or local path), runs the local analysis layer,
and builds a heuristic EDL (storyboard). The GPTunnel LLM/vision re-rank is layered
on in Phase 2; vision is opt-in via ``use_vision``.
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models import AnalyzeRequest, AnalyzeResponse
from app.services import enrich
from app.services import select as selector
from app.services import storage
from app.services.analyze import analyze_source

logger = logging.getLogger(__name__)


def create_router() -> APIRouter:
    router = APIRouter(prefix="", tags=["analyze"])

    @router.post("/analyze", response_model=AnalyzeResponse)
    async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
        if len(req.source_urls) > settings.max_source_videos:
            raise HTTPException(400, f"too many sources (max {settings.max_source_videos})")

        sources = []
        locals_by_idx: list[str] = []   # resolved local path per source index
        temps: list[str] = []
        try:
            for url in req.source_urls:
                local, is_temp = await storage.resolve_source(url)
                if is_temp:
                    temps.append(local)
                locals_by_idx.append(local)
                analysis = await analyze_source(local, storage_key=url)
                if analysis.duration_sec > settings.max_source_duration_sec:
                    raise HTTPException(
                        400, f"source too long: {analysis.duration_sec}s "
                             f"(max {settings.max_source_duration_sec})")
                sources.append(analysis)

            clips = selector.build_clips(
                sources, req.geometry,
                target_count=req.target_clip_count,
                target_seconds=req.target_clip_seconds,
            )
            # Phase 2: GPTunnel re-rank + titles (+ optional vision on silent clips).
            # Runs while temp sources still exist (vision samples keyframes from them).
            clips = await enrich.enrich_clips(
                clips, sources, use_vision=req.use_vision, locals_by_idx=locals_by_idx,
            )
        finally:
            for t in temps:
                try:
                    os.remove(t)
                except OSError:
                    pass

        return AnalyzeResponse(project_id=req.project_id, sources=sources, clips=clips)

    return router
