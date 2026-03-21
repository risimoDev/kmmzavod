"""Centralized settings loaded from environment / .env file."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # ── MinIO/S3 ──────────────────────────────────────────────────────
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_bucket: str = "kmmzavod"
    minio_secure: bool = False

    # ── FFmpeg knobs ──────────────────────────────────────────────────
    # Threads: 0 means let FFmpeg auto-detect (uses all cores)
    ffmpeg_threads: int = 0
    # Preset used for intermediate (temp) files — fast I/O, lower quality OK
    ffmpeg_interim_preset: str = "ultrafast"
    # Preset for the final output file — better compression
    ffmpeg_final_preset: str = "fast"
    # CRF for final encode (18=visually lossless, 23=good, 28=acceptable)
    ffmpeg_crf: int = 23
    # Output audio bitrate
    ffmpeg_audio_bitrate: str = "128k"
    # Max video bitrate for social media (helps with platform limits)
    ffmpeg_max_bitrate: str = "4M"
    ffmpeg_bufsize: str = "8M"

    # ── Service ───────────────────────────────────────────────────────
    log_level: str = "INFO"
    # Limit concurrent composition jobs to avoid OOM on CPU-heavy tasks
    max_concurrent_jobs: int = 2
    # Temp dir base; defaults to OS temp
    work_dir_base: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
