"""FastAPI entry point for the private publisher service."""

import logging
import time

from fastapi import FastAPI

from app.api.publish import create_router
from app.config import settings

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

_startup_time = time.time()

app = FastAPI(
    title="Publisher",
    version="1.0.0",
    description="Private (non-official-API) social publisher: Instagram (instagrapi) + TikTok (tiktok-uploader).",
)
app.include_router(create_router())


@app.get("/health", tags=["ops"], summary="Liveness probe")
def health() -> dict:
    return {"status": "ok", "uptime_sec": round(time.time() - _startup_time)}
