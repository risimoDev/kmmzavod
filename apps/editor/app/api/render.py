"""Render router — takes a (possibly user-edited) EDL and renders final clips.

Resolves the sources (+ optional shared voiceover / BGM for audio_mode=replace),
renders every *included* clip via the render engine, uploads each output + thumb
to MinIO, and returns the keys + metadata. The orchestrator persists these onto
EditClip rows and — for mode=uniquify_source — promotes them to SourceVideo.
"""

from __future__ import annotations

import logging
import os
import tempfile

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models import (
    AspectRatio, AudioMode, EditMode, RenderedClip, RenderRequest, RenderResponse,
)
from app.services import render as renderer
from app.services import storage

logger = logging.getLogger(__name__)


def create_router() -> APIRouter:
    router = APIRouter(prefix="", tags=["render"])

    @router.post("/render", response_model=RenderResponse)
    async def render(req: RenderRequest) -> RenderResponse:
        included = [c for c in req.clips if c.included]
        if not included:
            raise HTTPException(400, "no included clips to render")

        out_w, out_h = req.aspect.dimensions() if isinstance(req.aspect, AspectRatio) \
            else AspectRatio(req.aspect).dimensions()

        temps: list[str] = []
        work = tempfile.mkdtemp(prefix="editor_render_", dir=settings.work_dir_base or None)
        try:
            # Resolve sources + optional shared audio assets.
            locals_by_idx: list[str] = []
            for url in req.source_urls:
                local, is_temp = await storage.resolve_source(url)
                if is_temp:
                    temps.append(local)
                locals_by_idx.append(local)

            voiceover_path = bgm_path = None
            if req.voiceover_url:
                voiceover_path, t = await storage.resolve_source(req.voiceover_url)
                if t:
                    temps.append(voiceover_path)
            if req.bgm_url:
                bgm_path, t = await storage.resolve_source(req.bgm_url)
                if t:
                    temps.append(bgm_path)

            rendered: list[RenderedClip] = []
            prefix = req.output_key_prefix.rstrip("/")
            for i, clip in enumerate(included):
                out_path = os.path.join(work, f"clip_{i:03d}.mp4")
                res = await _to_thread_render(
                    clip, locals_by_idx, work, out_path, req,
                    out_w, out_h, voiceover_path, bgm_path,
                )
                key = f"{prefix}/clip_{i:03d}.mp4"
                await storage.upload_file(key, res.output_path, "video/mp4")
                thumb_key = None
                if res.thumbnail_path and os.path.exists(res.thumbnail_path):
                    thumb_key = f"{prefix}/clip_{i:03d}_thumb.jpg"
                    await storage.upload_file(thumb_key, res.thumbnail_path, "image/jpeg")
                rendered.append(RenderedClip(
                    title=clip.title, output_key=key, thumbnail_key=thumb_key,
                    duration_sec=res.duration_sec, width=res.width, height=res.height,
                    file_size_bytes=res.file_size_bytes, phash=res.phash,
                    quality_ok=res.quality_ok, quality_reason=res.quality_reason,
                ))
            return RenderResponse(project_id=req.project_id, clips=rendered)
        finally:
            import shutil
            shutil.rmtree(work, ignore_errors=True)
            for t in temps:
                try:
                    os.remove(t)
                except OSError:
                    pass

    return router


async def _to_thread_render(clip, locals_by_idx, work, out_path, req,
                            out_w, out_h, voiceover_path, bgm_path):
    """Run the (blocking, CPU-bound) render in a worker thread."""
    import asyncio
    return await asyncio.to_thread(
        renderer.render_clip, clip, locals_by_idx, work, out_path,
        mode=EditMode(req.mode), audio_mode=AudioMode(req.audio_mode),
        out_w=out_w, out_h=out_h, fps=req.fps, smart_crop=req.smart_crop,
        subtitle_style=(req.subtitle_style.value if hasattr(req.subtitle_style, "value")
                        else str(req.subtitle_style)),
        voiceover_path=voiceover_path, bgm_path=bgm_path,
    )
