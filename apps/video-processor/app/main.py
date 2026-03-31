"""FastAPI entry point for video-processor service."""

import logging
import os
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.api.compose import create_router as compose_router
from app.api.transcribe import create_router as transcribe_router
from app.config import settings

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

_startup_time = time.time()

app = FastAPI(
    title="Video Processor",
    version="2.0.0",
    description="FFmpeg-based video composition service with Ken Burns, xfade, and subtitle support.",
)
app.include_router(compose_router())
app.include_router(transcribe_router())


@app.get("/health", tags=["ops"], summary="Liveness probe")
def health() -> dict:
    return {"status": "ok", "uptime_sec": round(time.time() - _startup_time)}


@app.get("/metrics", tags=["ops"], summary="Basic service metrics")
def metrics() -> dict:
    """Returns basic runtime info. Suitable for a simple Prometheus text_file_collector."""
    import psutil
    proc = psutil.Process(os.getpid())
    return {
        "uptime_sec": round(time.time() - _startup_time),
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_rss_mb": round(proc.memory_info().rss / 1_048_576, 1),
        "open_files": len(proc.open_files()),
    }

