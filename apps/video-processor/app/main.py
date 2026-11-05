"""FastAPI entry point for video-processor service."""

import hmac
import logging
import os
import time

from fastapi import Depends, FastAPI, HTTPException, Request

from app.api.compose import create_router as compose_router
from app.api.transcribe import create_router as transcribe_router
from app.api.quality import create_router as quality_router
from app.api.uniquify import create_router as uniquify_router
from app.config import settings

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

_startup_time = time.time()


async def require_internal_token(request: Request) -> None:
    """Optional service-to-service auth.

    Enforced only when INTERNAL_SERVICE_TOKEN is set; unset/empty keeps the
    service open (backward compatible). /health stays public for probes.
    """
    expected = settings.internal_service_token
    if not expected or request.url.path == "/health":
        return
    provided = request.headers.get("x-internal-token", "")
    if not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Unauthorized")


app = FastAPI(
    title="Video Processor",
    version="3.0.0",
    description="FFmpeg-based video composition service with beat-sync, audio ducking, quality gate, and subtitle support.",
    dependencies=[Depends(require_internal_token)],
)
app.include_router(compose_router())
app.include_router(transcribe_router())
app.include_router(quality_router())
app.include_router(uniquify_router())


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

