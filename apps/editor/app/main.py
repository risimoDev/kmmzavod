"""FastAPI entry point for the editor (smart cutting / montage) service."""

import logging
import os
import time

from fastapi import FastAPI

from app.api.analyze import create_router as analyze_router
from app.api.render import create_router as render_router
from app.config import settings

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

_startup_time = time.time()

app = FastAPI(
    title="Editor",
    version="0.1.0",
    description="Intelligent video cutting & montage: analyse multiple sources, "
                "select beautiful moments, render highlights / mixes for "
                "uniquification or as finished subtitled videos.",
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
