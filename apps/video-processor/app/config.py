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
    # Threads: 0 means let FFmpeg auto-detect (uses all cores)
    ffmpeg_threads: int = 0
    # Preset used for intermediate (temp) files — fast I/O, lower quality OK
    ffmpeg_interim_preset: str = "ultrafast"
    # Preset for the final output file — better compression
    ffmpeg_final_preset: str = "medium"
    # CRF for final encode (18=visually lossless, 21=high quality, 23=good)
    ffmpeg_crf: int = 21
    # Output audio bitrate
    ffmpeg_audio_bitrate: str = "192k"
    # Max video bitrate for social media (helps with platform limits)
    ffmpeg_max_bitrate: str = "6M"
    ffmpeg_bufsize: str = "12M"

    # ── Service ───────────────────────────────────────────────────────
    log_level: str = "INFO"
    # Limit concurrent composition jobs to avoid OOM on CPU-heavy tasks
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
