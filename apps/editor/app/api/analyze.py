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
                   max_dist: int = 4) -> list[EdlClip]:
    """Drop near-duplicate SILENT candidates: hash the midpoint frame and keep
    only the first of visually identical ones. Clips WITH speech are exempt —
    different moments of a talking-head video look identical frame-wise but are
    distinguished by what is said (deduping them collapsed everything to one)."""
    if len(clips) < 2 or any(len(c.segments) != 1 for c in clips):
        return clips
    work = tempfile.mkdtemp(prefix="editor_dedupe_")
    kept: list[EdlClip] = []
    hashes: list[str] = []
    try:
        for i, clip in enumerate(clips):
            if clip.transcript_snippet.strip():
                kept.append(clip)  # speech ⇒ a distinct moment by definition
                continue
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
                logger.info("Dedupe: dropped visually duplicate silent clip %r", clip.title)
                continue
            if h:
                hashes.append(h)
            kept.append(clip)
    finally:
        import shutil
        shutil.rmtree(work, ignore_errors=True)
    return kept


def _attach_thumbs(clips: list[EdlClip], locals_by_idx: list[str]) -> None:
    """Fill ``thumb_b64`` (JPEG, ~360px) from each clip's midpoint frame so the
    storyboard has previews. Best-effort per clip; must run while temp sources
    still exist. The orchestrator uploads these to MinIO and strips the base64."""
    import base64

    work = tempfile.mkdtemp(prefix="editor_thumbs_")
    try:
        for i, clip in enumerate(clips):
            seg = clip.segments[0] if clip.segments else None
            if seg is None or seg.src_idx >= len(locals_by_idx):
                continue
            frame = os.path.join(work, f"t{i}.jpg")
            try:
                fx.extract_frame(locals_by_idx[seg.src_idx],
                                 (seg.start + seg.end) / 2.0, frame, width=360)
                with open(frame, "rb") as f:
                    clip.thumb_b64 = base64.b64encode(f.read()).decode()
            except Exception as e:  # noqa: BLE001
                logger.warning("Thumbnail failed for clip %d: %s", i, e)
    finally:
        import shutil
        shutil.rmtree(work, ignore_errors=True)


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
            # Storyboard previews (midpoint frames) — after enrich so LLM-proposed
            # ranges get thumbs too; while temp sources still exist.
            _attach_thumbs(clips, locals_by_idx)
        finally:
            for t in temps:
                try:
                    os.remove(t)
                except OSError:
                    pass

        return AnalyzeResponse(project_id=req.project_id, sources=sources, clips=clips)

    return router
