"""HTTP endpoints for the private publisher service."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import time

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models import (
    InstagramPublishRequest,
    PublishResponse,
    TiktokPublishRequest,
    WarmupRequest,
    WarmupResponse,
)
from app.services import instagram as ig
from app.services import tiktok as tt
from app.services.download import download_to_temp

logger = logging.getLogger(__name__)

_semaphore: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(settings.max_concurrent)
    return _semaphore


def _work_dir(prefix: str) -> str:
    base = settings.work_dir_base or tempfile.gettempdir()
    d = os.path.join(base, f"{prefix}_{int(time.time() * 1000)}_{os.urandom(3).hex()}")
    os.makedirs(d, exist_ok=True)
    return d


def create_router() -> APIRouter:
    router = APIRouter(tags=["publish"])

    @router.post("/instagram/publish", response_model=PublishResponse, summary="Publish Reel (instagrapi)")
    async def instagram_publish(req: InstagramPublishRequest) -> PublishResponse:
        work = _work_dir("ig")
        try:
            async with _get_semaphore():
                path = await asyncio.to_thread(download_to_temp, req.video_url, work)
                external_id, session = await asyncio.to_thread(
                    ig.publish_reel,
                    req.session_data, path, req.caption, req.proxy_url, req.device_fingerprint,
                )
            return PublishResponse(ok=True, external_id=external_id, session_data=session)
        except Exception as e:
            logger.exception("Instagram publish failed")
            raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {e}")
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @router.post("/tiktok/publish", response_model=PublishResponse, summary="Publish video (tiktok-uploader)")
    async def tiktok_publish(req: TiktokPublishRequest) -> PublishResponse:
        work = _work_dir("tt")
        try:
            async with _get_semaphore():
                path = await asyncio.to_thread(download_to_temp, req.video_url, work)
                await asyncio.to_thread(tt.publish, req.session_data, path, req.caption, req.proxy_url)
            # TikTok upload via browser yields no reliable post id; session unchanged.
            return PublishResponse(ok=True, external_id=None, session_data=req.session_data)
        except Exception as e:
            logger.exception("TikTok publish failed")
            raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {e}")
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @router.post("/instagram/warmup", response_model=WarmupResponse, summary="Warm up an IG account")
    async def instagram_warmup(req: WarmupRequest) -> WarmupResponse:
        try:
            async with _get_semaphore():
                actions, session = await asyncio.to_thread(
                    ig.warmup, req.session_data, req.proxy_url, req.like_count, req.device_fingerprint,
                )
            return WarmupResponse(ok=True, actions=actions, session_data=session)
        except Exception as e:
            logger.exception("Instagram warmup failed")
            raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {e}")

    return router
