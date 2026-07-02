"""Centralized settings for the editor (smart cutting / montage) service.

Loaded from environment / the shared monorepo .env. FFmpeg knobs mirror the
video-processor service so both render with the same CPU-friendly defaults.
"""

import shutil
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Walk up to monorepo root to find the shared .env
_this_dir = Path(__file__).resolve().parent.parent        # apps/editor
_root_env = _this_dir.parent.parent / ".env"              # <repo>/.env


class Settings(BaseSettings):
    # ── MinIO/S3 ──────────────────────────────────────────────────────
    minio_endpoint: str = "localhost:9000"
    minio_port: int = 9000
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_bucket: str = "kmmzavod"
    minio_secure: bool = False

    # ── FFmpeg knobs (mirror video-processor) ─────────────────────────
    ffmpeg_bin_dir: str = ""
    ffmpeg_threads: int = 3
    ffmpeg_interim_preset: str = "ultrafast"
    ffmpeg_final_preset: str = "veryfast"
    ffmpeg_crf: int = 24
    ffmpeg_audio_bitrate: str = "128k"
    ffmpeg_max_bitrate: str = "4M"
    ffmpeg_bufsize: str = "8M"

    # ── Analysis ──────────────────────────────────────────────────────
    # Whisper model size: tiny|base|small|medium. small = good RU accuracy / CPU.
    whisper_model: str = "small"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_language: str = "ru"
    # Scene-cut sensitivity for ffmpeg select='gt(scene,T)'. Lower = more cuts.
    scene_threshold: float = 0.35
    # Sampling fps for motion / scene analysis (keep CPU low on long videos).
    analysis_sample_fps: float = 2.0

    # ── GPTunnel (LLM moment selection + gpt-4o vision) ───────────────
    gptunnel_api_key: str = ""
    gptunnel_base_url: str = "https://gptunnel.ru/v1"
    gptunnel_text_model: str = "gpt-4o-mini"
    gptunnel_vision_model: str = "gpt-4o"

    # ── Limits ────────────────────────────────────────────────────────
    max_source_videos: int = 12
    max_source_duration_sec: int = 3600
    max_clips_per_project: int = 30

    # ── Service ───────────────────────────────────────────────────────
    log_level: str = "INFO"
    max_concurrent_jobs: int = 2
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
        for _candidate in [
            Path(r"C:\OSPanel\addons\FFMpeg\bin"),
            Path(r"C:\ffmpeg\bin"),
            Path(r"C:\Program Files\ffmpeg\bin"),
        ]:
            if (_candidate / "ffmpeg.exe").exists():
                settings.ffmpeg_bin_dir = str(_candidate)
                break
