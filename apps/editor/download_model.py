#!/usr/bin/env python3
"""Whisper model fetcher that does NOT depend on huggingface_hub networking.

huggingface.co недоступен из ряда сетей (RU-блокировки), а huggingface_hub
несовместим с зеркалами из-за проверки заголовков — поэтому качаем файлы модели
обычным HTTPS (stdlib urllib) с фолбэком по списку эндпоинтов. Используется:
  • при сборке Docker-образа (RUN python download_model.py small) — модель
    запекается в образ и рантайм-сети не требуется вовсе;
  • в рантайме из app.services.stt как последний фолбэк.

Файлы кладутся в $HF_HOME/manual/<model> (или ~/.cache/kmm-whisper/<model>).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

REQUIRED = ["config.json", "model.bin"]
OPTIONAL = ["tokenizer.json", "vocabulary.txt", "vocabulary.json", "preprocessor_config.json"]

DEFAULT_ENDPOINTS = ["https://huggingface.co", "https://hf-mirror.com"]


def model_dir(model: str) -> str:
    base = os.environ.get("HF_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache", "kmm-whisper")
    return os.path.join(base, "manual", model.replace("/", "__"))


def is_ready(model: str) -> bool:
    d = model_dir(model)
    return all(os.path.exists(os.path.join(d, f)) for f in REQUIRED)


def _fetch(url: str, dest: str, timeout: int = 60) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "kmmzavod-editor/1.0"})
    tmp = dest + ".part"
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)


def ensure_model(model: str, endpoints: list[str] | None = None) -> str:
    """Download the CTranslate2 model files if missing. Returns the local dir."""
    d = model_dir(model)
    if is_ready(model):
        return d
    os.makedirs(d, exist_ok=True)
    repo = model if "/" in model else f"Systran/faster-whisper-{model}"

    env_ep = os.environ.get("HF_ENDPOINT", "").rstrip("/")
    eps = endpoints or ([env_ep] if env_ep else []) + DEFAULT_ENDPOINTS
    last_err: Exception | None = None
    for ep in dict.fromkeys(e for e in eps if e):  # unique, keep order
        try:
            for name in REQUIRED:
                path = os.path.join(d, name)
                if not os.path.exists(path):
                    print(f"[whisper] {ep}: {name} ...", flush=True)
                    _fetch(f"{ep}/{repo}/resolve/main/{name}", path,
                           timeout=1800 if name == "model.bin" else 60)
            for name in OPTIONAL:
                path = os.path.join(d, name)
                if os.path.exists(path):
                    continue
                try:
                    _fetch(f"{ep}/{repo}/resolve/main/{name}", path)
                except Exception:  # noqa: BLE001 — optional file, 404 is fine
                    pass
            # Sanity: config parses and model.bin is not an HTML error page.
            json.load(open(os.path.join(d, "config.json"), encoding="utf-8"))
            if os.path.getsize(os.path.join(d, "model.bin")) < 1_000_000:
                raise RuntimeError("model.bin suspiciously small — endpoint returned garbage")
            print(f"[whisper] model '{model}' ready at {d}", flush=True)
            return d
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"[whisper] endpoint {ep} failed: {e}", flush=True)
    raise RuntimeError(f"cannot download whisper model '{model}': {last_err}")


if __name__ == "__main__":
    m = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("WHISPER_MODEL", "small")
    if m == "none":
        print("[whisper] preload skipped (model=none)")
    else:
        ensure_model(m)
