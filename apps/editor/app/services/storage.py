"""Source fetch helper.

The orchestrator sends MinIO presigned URLs in production; the CLI passes local
file paths. This resolves either to a usable local path, downloading URLs to a
temp file (size-guarded) and leaving local paths untouched.
"""

from __future__ import annotations

import logging
import os
import tempfile

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

    scheme = "https" if settings.minio_secure else "http"
    return aioboto3.Session().client(
        "s3",
        endpoint_url=f"{scheme}://{settings.minio_endpoint}",
        aws_access_key_id=settings.minio_access_key,
        aws_secret_access_key=settings.minio_secret_key,
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
    if os.path.exists(url_or_path):
        return url_or_path, False
    if not url_or_path.lower().startswith(("http://", "https://")):
        raise FileNotFoundError(f"source not found and not a URL: {url_or_path}")

    import httpx

    fd, tmp = tempfile.mkstemp(prefix="src_", suffix=".mp4", dir=_work_dir())
    os.close(fd)
    written = 0
    async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as client:
        async with client.stream("GET", url_or_path) as resp:
            resp.raise_for_status()
            with open(tmp, "wb") as f:
                async for chunk in resp.aiter_bytes(1024 * 256):
                    written += len(chunk)
                    if written > _MAX_BYTES:
                        f.close()
                        os.remove(tmp)
                        raise ValueError("source exceeds max download size")
                    f.write(chunk)
    logger.info("Downloaded %s → %s (%d bytes)", url_or_path[:80], tmp, written)
    return tmp, True
