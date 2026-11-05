"""FastAPI entry point for the private publisher service."""

import hmac
import logging
import time

from fastapi import Depends, FastAPI, HTTPException, Request

from app.api.publish import create_router
from app.config import settings

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

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
    title="Publisher",
    version="1.0.0",
    description="Private (non-official-API) social publisher: Instagram (instagrapi) + TikTok (tiktok-uploader).",
    dependencies=[Depends(require_internal_token)],
)
app.include_router(create_router())


@app.get("/health", tags=["ops"], summary="Liveness probe")
def health() -> dict:
    return {"status": "ok", "uptime_sec": round(time.time() - _startup_time)}
