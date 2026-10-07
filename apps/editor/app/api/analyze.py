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
from app.models import ANALYSIS_VERSION, AnalyzeRequest, AnalyzeResponse, AudioMode, EdlClip, Geometry, SourceAnalysis
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


def _cache_usable(cached: SourceAnalysis | None, need_transcript: bool) -> bool:
    """A cached analysis is reused when it is current and has the transcript
    this project needs (voiceover projects don't need one)."""
    return (
        cached is not None
        and cached.analysis_version == ANALYSIS_VERSION
        and cached.duration_sec > 0
        and (cached.transcribed or not need_transcript)
    )


def create_router() -> APIRouter:
    router = APIRouter(prefix="", tags=["analyze"])

    @router.post("/analyze", response_model=AnalyzeResponse)
    async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
        if len(req.source_urls) > settings.max_source_videos:
            raise HTTPException(400, f"too many sources (max {settings.max_source_videos})")

        is_mix = req.geometry in (Geometry.MIX, "mix")
        keep_audio = AudioMode(req.audio_mode) == AudioMode.KEEP
        # Source speech only matters when it is heard: voiceover projects skip
        # Whisper over the sources entirely (the biggest analysis cost).
        need_transcript = req.need_transcript if req.need_transcript is not None else keep_audio

        sources: list[SourceAnalysis] = []
        locals_by_idx: list[str] = []   # resolved local path per source index
        temps: list[str] = []
        reused = 0
        try:
            for i, url in enumerate(req.source_urls):
                local, is_temp = await storage.resolve_source(url)
                if is_temp:
                    temps.append(local)
                locals_by_idx.append(local)
                cached = req.cached_analyses[i] if i < len(req.cached_analyses) else None
                if _cache_usable(cached, need_transcript):
                    analysis = cached
                    reused += 1
                else:
                    analysis = await analyze_source(local, storage_key=url,
                                                    with_transcript=need_transcript)
                    err = analysis.transcript_error or ""
                    # Whisper genuinely ran (even if it heard no speech) ⇒ reusable
                    # for keep-audio projects later; a broken STT must be retried.
                    analysis.transcribed = need_transcript and not err.startswith(
                        ("Whisper unavailable", "Transcription failed"))
                if analysis.duration_sec > settings.max_source_duration_sec:
                    raise HTTPException(
                        400, f"source too long: {analysis.duration_sec}s "
                             f"(max {settings.max_source_duration_sec})")
                sources.append(analysis)
            if reused:
                logger.info("Analyze %s: reused %d/%d cached source analyses",
                            req.project_id, reused, len(sources))

            effective_target = 1 if is_mix else max(req.target_clip_count, len(sources))
            exclude = [[(float(a), float(b)) for a, b in rng] for rng in req.exclude_ranges]
            clips = selector.build_clips(
                sources, req.geometry,
                target_count=effective_target,
                target_seconds=req.target_clip_seconds,
                variant_count=req.variant_count,
                seed=req.seed,
                pace=req.pace.value if hasattr(req.pace, "value") else str(req.pace),
                keep_audio=keep_audio,
                hook_first=req.hook_first,
                exclude_ranges=exclude,
            )
            if not is_mix:
                clips = _dedupe_visual(clips, locals_by_idx)
                # GPTunnel — full-transcript range proposal (highlights) or re-rank
                # fallback, + optional vision on silent clips. Mix variants are
                # assembled shot-by-shot and need no LLM (saves tokens + time).
                clips = await enrich.enrich_clips(
                    clips, sources, use_vision=req.use_vision, locals_by_idx=locals_by_idx,
                    target_count=effective_target,
                    target_seconds=req.target_clip_seconds,
                )
            # Storyboard previews (first-shot frames) while temp sources still exist.
            _attach_thumbs(clips, locals_by_idx)
            # Proposed subtitles on each clip's output timeline (user-editable).
            for c in clips:
                c.subtitles = selector.map_clip_subtitles(
                    c, sources, transition_sec=selector.TRANSITION_SEC if c.transitions else 0.0)
        finally:
            for t in temps:
                try:
                    os.remove(t)
                except OSError:
                    pass

        return AnalyzeResponse(project_id=req.project_id, sources=sources, clips=clips)

    return router
