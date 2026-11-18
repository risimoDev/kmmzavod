"""Source fetch helper.

The orchestrator sends MinIO presigned URLs in production; the CLI passes local
file paths. This resolves either to a usable local path, downloading URLs to a
temp file (size-guarded) and leaving local paths untouched.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from app.config import settings

logger = logging.getLogger(__name__)

_MAX_BYTES = 4 * 1024 * 1024 * 1024  # 4 GB hard ceiling


def _work_dir() -> str:
    base = settings.work_dir_base or tempfile.gettempdir()
    d = os.path.join(base, "kmmzavod_editor")
    os.makedirs(d, exist_ok=True)
    return d


def _s3():
    import aioboto3
    from botocore.config import Config

    raw_ep = settings.minio_endpoint.strip()
    if raw_ep.startswith("https://"):
        scheme = "https"
        clean_ep = raw_ep[8:].rstrip("/")
    elif raw_ep.startswith("http://"):
        scheme = "http"
        clean_ep = raw_ep[7:].rstrip("/")
    else:
        scheme = "https" if settings.minio_secure else "http"
        clean_ep = raw_ep.rstrip("/")

    if ":" not in clean_ep:
        if scheme == "http" and settings.minio_port and settings.minio_port != 80:
            clean_ep = f"{clean_ep}:{settings.minio_port}"
        elif scheme == "https" and settings.minio_port and settings.minio_port != 443:
            clean_ep = f"{clean_ep}:{settings.minio_port}"

    region = getattr(settings, "minio_region", "us-east-1")
    return aioboto3.Session().client(
        "s3",
        endpoint_url=f"{scheme}://{clean_ep}",
        aws_access_key_id=settings.minio_access_key,
        aws_secret_access_key=settings.minio_secret_key,
        region_name=region,
        config=Config(signature_version="s3v4", proxies={}),
    )


async def upload_file(key: str, local_path: str,
                      content_type: str = "application/octet-stream") -> str:
    """Upload a local file to the MinIO bucket under ``key``. Returns the key."""
    async with _s3() as s3:
        await s3.upload_file(local_path, settings.minio_bucket, key,
                             ExtraArgs={"ContentType": content_type})
    return key


async def resolve_source(url_or_path: str) -> tuple[str, bool]:
    """Return (local_path, is_temp). Local paths pass through; URLs are downloaded."""
    restricted = settings.require_internal_service_token
    if not restricted and os.path.exists(url_or_path):
        return url_or_path, False
    if not url_or_path.lower().startswith(("http://", "https://")):
        raise FileNotFoundError(f"source not found and not a URL: {url_or_path}")

    import httpx

    def origin(url: str):
        parts = urlsplit(url)
        return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)

    if restricted:
        internal = f"{'https' if settings.minio_secure else 'http'}://{settings.minio_endpoint}"
        parts = urlsplit(url_or_path)
        allowed = {origin(internal), origin(settings.minio_public_url)}
        if parts.username or parts.password or origin(url_or_path) not in allowed:
            raise ValueError("source must be hosted on configured object storage")

    fd, tmp = tempfile.mkstemp(prefix="src_", suffix=".mp4", dir=_work_dir())
    os.close(fd)
    written = 0
    try:
        async with httpx.AsyncClient(timeout=600.0, follow_redirects=not restricted) as client:
            async with client.stream("GET", url_or_path) as resp:
                resp.raise_for_status()
                with open(tmp, "wb") as f:
                    async for chunk in resp.aiter_bytes(1024 * 256):
                        written += len(chunk)
                        if written > _MAX_BYTES:
                            raise ValueError("source exceeds max download size")
                        f.write(chunk)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    logger.info("Downloaded source (%d bytes)", written)
    return tmp, True
