"""Centralized settings loaded from environment / .env file."""

import shutil
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Walk up to monorepo root to find the shared .env
_this_dir = Path(__file__).resolve().parent.parent        # apps/video-processor
_root_env = _this_dir.parent.parent / ".env"              # <repo>/.env


class Settings(BaseSettings):
    # ── MinIO/S3 ──────────────────────────────────────────────────────
    minio_endpoint: str = "localhost:9000"
    minio_port: int = 9000
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_bucket: str = "kmmzavod"
    minio_secure: bool = False

    # ── FFmpeg knobs ──────────────────────────────────────────────────
    # Directory containing ffmpeg/ffprobe binaries (auto-detected if empty)
    ffmpeg_bin_dir: str = ""
    # Threads: 0=auto (all cores). On 4-core server use 3 to leave 1 for API/DB
    ffmpeg_threads: int = 3
    # Preset used for intermediate (temp) files — fast I/O, lower quality OK
    ffmpeg_interim_preset: str = "ultrafast"
    # Preset for the final output file — veryfast for CPU-only server (4 cores)
    ffmpeg_final_preset: str = "veryfast"
    # CRF for final encode: 24-26 = good quality, much faster encoding on CPU
    ffmpeg_crf: int = 24
    # Output audio bitrate (reduced slightly to save CPU during mux)
    ffmpeg_audio_bitrate: str = "128k"
    # Max video bitrate for social media (helps with platform limits)
    ffmpeg_max_bitrate: str = "4M"
    ffmpeg_bufsize: str = "8M"

    # ── Service ───────────────────────────────────────────────────────
    log_level: str = "INFO"
    # Hard limit concurrent jobs for 4-core / 6GB RAM server (no GPU)
    max_concurrent_jobs: int = 2
    # Temp dir base; defaults to OS temp
    work_dir_base: str = ""

    model_config = SettingsConfigDict(
        env_file=(".env", str(_root_env)),
        extra="ignore",
    )


settings = Settings()

# If MINIO_ENDPOINT has no port, append MINIO_PORT
if ":" not in settings.minio_endpoint:
    settings.minio_endpoint = f"{settings.minio_endpoint}:{settings.minio_port}"

# Auto-detect FFmpeg bin directory if not explicitly configured
if not settings.ffmpeg_bin_dir:
    _ffmpeg = shutil.which("ffmpeg")
    if _ffmpeg:
        settings.ffmpeg_bin_dir = str(Path(_ffmpeg).parent)
    else:
        # Check common Windows locations
        for _candidate in [
            Path(r"C:\OSPanel\addons\FFMpeg\bin"),
            Path(r"C:\ffmpeg\bin"),
            Path(r"C:\Program Files\ffmpeg\bin"),
        ]:
            if (_candidate / "ffmpeg.exe").exists():
                settings.ffmpeg_bin_dir = str(_candidate)
                break
