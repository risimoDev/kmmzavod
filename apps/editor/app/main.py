"""FastAPI entry point for the editor (smart cutting / montage) service."""

import hmac
import logging
import os
import time

from fastapi import Depends, FastAPI, HTTPException, Request

from app.api.analyze import create_router as analyze_router
from app.api.render import create_router as render_router
from app.config import settings

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

_startup_time = time.time()


async def require_internal_token(request: Request) -> None:
    """Optional service-to-service auth (M8).
    Enforced only when INTERNAL_SERVICE_TOKEN is set; unset/empty keeps the
    service open (backward compatible). /health stays public for probes.
    """
    expected = settings.internal_service_token
    if not expected or request.url.path in ("/health", "/metrics"):
        return
    provided = request.headers.get("x-internal-token", "")
    if not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Unauthorized")


app = FastAPI(
    title="Editor",
    version="0.1.0",
    description="Intelligent video cutting & montage: analyse multiple sources, "
                "select beautiful moments, render highlights / mixes for "
                "uniquification or as finished subtitled videos.",
    dependencies=[Depends(require_internal_token)],
)
app.include_router(analyze_router())
app.include_router(render_router())


@app.get("/health", tags=["ops"], summary="Liveness probe")
def health() -> dict:
    from app.services.stt import whisper_status
    return {
        "status": "ok",
        "uptime_sec": round(time.time() - _startup_time),
        # Субтитры зависят от Whisper — сломанный STT должен быть виден здесь,
        # а не обнаруживаться по беззвучным роликам.
        "whisper": whisper_status(),
    }


@app.get("/metrics", tags=["ops"], summary="Basic service metrics")
def metrics() -> dict:
    import psutil
    proc = psutil.Process(os.getpid())
    return {
        "uptime_sec": round(time.time() - _startup_time),
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_rss_mb": round(proc.memory_info().rss / 1_048_576, 1),
        "open_files": len(proc.open_files()),
    }
