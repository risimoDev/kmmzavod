"""Analyze router — phase 1 of the two-phase editor flow.

Resolves each source (presigned URL or local path), runs the local analysis layer,
and builds a heuristic EDL (storyboard). The GPTunnel LLM/vision re-rank is layered
on in Phase 2; vision is opt-in via ``use_vision``.
"""

from __future__ import annotations

import logging
import os

import tempfile

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models import AnalyzeRequest, AnalyzeResponse, EdlClip
from app.services import enrich
from app.services import ffmpeg as fx
from app.services import select as selector
from app.services import storage
from app.services.analyze import analyze_source

logger = logging.getLogger(__name__)


def _hamming(a: str, b: str) -> int:
    return sum(x != y for x, y in zip(a, b)) + abs(len(a) - len(b))


def _dedupe_visual(clips: list[EdlClip], locals_by_idx: list[str],
                   max_dist: int = 6) -> list[EdlClip]:
    """Drop near-duplicate candidates: hash the midpoint frame of each clip and
    keep only the first (highest-ranked) of visually identical ones. Applies to
    single-segment (highlight) clips; best-effort — clips without a hash stay."""
    if len(clips) < 2 or any(len(c.segments) != 1 for c in clips):
        return clips
    work = tempfile.mkdtemp(prefix="editor_dedupe_")
    kept: list[EdlClip] = []
    hashes: list[str] = []
    try:
        for i, clip in enumerate(clips):
            seg = clip.segments[0]
            h = None
            if seg.src_idx < len(locals_by_idx):
                frame = os.path.join(work, f"c{i}.jpg")
                try:
                    fx.extract_frame(locals_by_idx[seg.src_idx],
                                     (seg.start + seg.end) / 2.0, frame, width=256)
                    h = fx.average_hash(frame)
                except Exception:  # noqa: BLE001
                    h = None
            if h and any(_hamming(h, other) <= max_dist for other in hashes):
                logger.info("Dedupe: dropped visually duplicate clip %r", clip.title)
                continue
            if h:
                hashes.append(h)
            kept.append(clip)
    finally:
        import shutil
        shutil.rmtree(work, ignore_errors=True)
    return kept


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
            clips = _dedupe_visual(clips, locals_by_idx)
            # Phase 2: GPTunnel — full-transcript range proposal (highlights) or
            # re-rank fallback, + optional vision on silent clips. Runs while temp
            # sources still exist (vision samples keyframes from them).
            clips = await enrich.enrich_clips(
                clips, sources, use_vision=req.use_vision, locals_by_idx=locals_by_idx,
                target_count=req.target_clip_count,
                target_seconds=req.target_clip_seconds,
            )
        finally:
            for t in temps:
                try:
                    os.remove(t)
                except OSError:
                    pass

        return AnalyzeResponse(project_id=req.project_id, sources=sources, clips=clips)

    return router
