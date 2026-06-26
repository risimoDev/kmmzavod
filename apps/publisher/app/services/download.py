"""Download a video from a presigned URL into a temp file (size-guarded)."""

from __future__ import annotations

import os

import requests

from app.config import settings


def download_to_temp(url: str, work_dir: str, max_mb: int | None = None) -> str:
    """Stream the video to <work_dir>/video.mp4, aborting if it exceeds max_mb."""
    max_mb = max_mb if max_mb is not None else settings.max_download_mb
    limit = max_mb * 1024 * 1024
    path = os.path.join(work_dir, "video.mp4")

    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        total = 0
        with open(path, "wb") as f:
            for chunk in r.iter_content(chunk_size=256 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > limit:
                    raise ValueError(f"video exceeds {max_mb} MB limit")
                f.write(chunk)

    if os.path.getsize(path) == 0:
        raise ValueError("downloaded video is empty")
    return path
