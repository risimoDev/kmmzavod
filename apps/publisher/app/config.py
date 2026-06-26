"""Settings for the private publisher service."""

import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    log_level: str = "INFO"
    # Temp dir base for downloaded videos (defaults to OS temp).
    work_dir_base: str = ""
    # Cap simultaneous publishes (each TikTok upload spins a headless browser).
    max_concurrent: int = 2
    # Reject videos larger than this when downloading the presigned URL.
    max_download_mb: int = 300
    # Browser binaries — default to the Dockerfile's CHROME_BIN / CHROMEDRIVER_PATH.
    chrome_binary: str = os.environ.get("CHROME_BIN", "")
    chromedriver_path: str = os.environ.get("CHROMEDRIVER_PATH", "")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
