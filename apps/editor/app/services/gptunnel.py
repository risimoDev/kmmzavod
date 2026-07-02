"""GPTunnel client — LLM moment selection + gpt-4o vision on frames.

GPTunnel is OpenAI-compatible (chat/completions). It has NO speech-to-text, so
transcription stays local (faster-whisper); here we only use the chat endpoint for
the *semantic* layer: ranking candidate windows by their transcript and writing
short titles, plus optional gpt-4o vision over sampled keyframes.

All calls are best-effort: any failure (missing key, network, bad JSON) is swallowed
and the caller falls back to the heuristic result, so the pipeline never blocks on
the paid layer.
"""

from __future__ import annotations

import base64
import json
import logging
import re

from app.config import settings

logger = logging.getLogger(__name__)


def is_configured() -> bool:
    return bool(settings.gptunnel_api_key)


def _extract_json(raw: str) -> str:
    s = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, re.IGNORECASE)
    if fence:
        s = fence[1].strip()
    first, last = s.find("{"), s.rfind("}")
    if first >= 0 and last > first:
        return s[first:last + 1]
    return s


async def _post(payload: dict, timeout: float = 120.0) -> dict:
    import httpx

    base = settings.gptunnel_base_url.rstrip("/")
    headers = {"Authorization": settings.gptunnel_api_key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{base}/chat/completions", json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


async def chat_json(system: str, user: str, *, model: str | None = None,
                    max_tokens: int = 1500) -> dict | None:
    """Single chat call expecting a JSON object reply. Returns parsed dict or None."""
    if not is_configured():
        return None
    try:
        data = await _post({
            "model": model or settings.gptunnel_text_model,
            "temperature": 0.4,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        })
        content = data["choices"][0]["message"]["content"]
        return json.loads(_extract_json(content))
    except Exception as e:  # noqa: BLE001 — paid layer is best-effort
        logger.warning("GPTunnel chat failed: %s", e)
        return None


async def vision_score(prompt: str, image_paths: list[str], *,
                       max_tokens: int = 600) -> dict | None:
    """gpt-4o vision over sampled keyframes. Returns parsed JSON dict or None."""
    if not is_configured() or not image_paths:
        return None
    try:
        content: list[dict] = [{"type": "text", "text": prompt}]
        for p in image_paths:
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            })
        data = await _post({
            "model": settings.gptunnel_vision_model,
            "temperature": 0.3,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": content}],
        }, timeout=180.0)
        reply = data["choices"][0]["message"]["content"]
        return json.loads(_extract_json(reply))
    except Exception as e:  # noqa: BLE001
        logger.warning("GPTunnel vision failed: %s", e)
        return None
