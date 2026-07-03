"""Shared faster-whisper access.

One cached model instance per process (analyze + render both use it — раньше
модель грузилась заново на каждый вызов), plus a human-readable availability
probe for /health so a broken Whisper is visible instead of silently producing
videos without subtitles.
"""

from __future__ import annotations

import logging
from functools import lru_cache

from app.config import settings

logger = logging.getLogger(__name__)


def _load(path_or_size: str):
    from faster_whisper import WhisperModel  # heavy import, lazy

    return WhisperModel(
        path_or_size,
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
    )


@lru_cache(maxsize=1)
def get_model():
    """Load (once) and return the WhisperModel.

    Resolution order — устойчиво к недоступности huggingface.co:
      1. локальная папка ручной загрузки (запечена в образ на этапе сборки);
      2. HF-кэш (local_files_only, без сети);
      3. ручная загрузка обычным HTTPS с фолбэком на зеркала (download_model.py);
      4. стандартный путь faster-whisper/huggingface_hub (последний шанс).
    """
    from download_model import ensure_model, is_ready, model_dir

    model = settings.whisper_model
    if is_ready(model):
        return _load(model_dir(model))
    try:
        from faster_whisper import download_model as hf_dl
        return _load(hf_dl(model, local_files_only=True))
    except Exception:  # noqa: BLE001 — not cached, go download
        pass
    try:
        return _load(ensure_model(model))
    except Exception as e:  # noqa: BLE001
        logger.warning("manual whisper download failed (%s), trying huggingface_hub", e)
    logger.info("Loading Whisper model %r via huggingface_hub...", model)
    return _load(model)


def whisper_status() -> dict:
    """Cheap probe: is the lib importable and the model already on disk?
    Does NOT download or load the model."""
    status: dict = {"model": settings.whisper_model, "available": False, "cached": False}
    try:
        from faster_whisper import download_model  # noqa: F401
    except Exception as e:  # noqa: BLE001
        status["reason"] = f"faster-whisper import failed: {e}"
        return status
    status["available"] = True
    try:
        from download_model import is_ready, model_dir
        if is_ready(settings.whisper_model):
            status["cached"] = True
            status["path"] = model_dir(settings.whisper_model)
            return status
    except Exception:  # noqa: BLE001
        pass
    try:
        from faster_whisper import download_model
        path = download_model(settings.whisper_model, local_files_only=True)
        status["cached"] = True
        status["path"] = path
    except Exception:  # noqa: BLE001
        status["reason"] = (
            "model files not cached — first transcription will try to download "
            "them (needs internet; endpoints: HF_ENDPOINT → huggingface.co → hf-mirror.com)"
        )
    return status
