"""LLM enrichment of the heuristic EDL (Phase 2).

Takes the clips proposed by the cheap heuristic scorer and asks GPTunnel to:
  • re-rank them by how "hooky" the spoken content is, and
  • write a short punchy RU title per clip.
For silent clips (no transcript) and when ``use_vision`` is on, it samples a
keyframe and asks gpt-4o to judge interest + title the shot.

Everything degrades gracefully: with no API key (or any failure) the input clips
are returned unchanged, so analysis never blocks on the paid layer.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile

from app.models import EdlClip, SourceAnalysis
from app.services import ffmpeg as fx
from app.services import gptunnel

logger = logging.getLogger(__name__)

_SYSTEM = (
    "Ты — монтажёр коротких вертикальных видео (Reels/TikTok). "
    "Тебе дают видео-фрагменты с расшифровкой речи. Выбери самые цепляющие "
    "и придумай короткий вирусный заголовок на русском для каждого. "
    "Отвечай строго одним валидным JSON-объектом."
)


def _clip_midpoint(clip: EdlClip) -> tuple[int, float]:
    """Return (src_idx, time) at the middle of a clip's first segment."""
    seg = clip.segments[0]
    return seg.src_idx, (seg.start + seg.end) / 2.0


async def _text_rerank(clips: list[EdlClip]) -> None:
    """In-place re-rank + title using the transcript. No-op if not configured."""
    indexed = [
        {"i": i, "dur": round(sum(s.end - s.start for s in c.segments), 1),
         "text": c.transcript_snippet[:240]}
        for i, c in enumerate(clips) if c.transcript_snippet.strip()
    ]
    if not indexed:
        return
    user = (
        "Фрагменты-кандидаты:\n"
        + json.dumps(indexed, ensure_ascii=False)
        + "\n\nВерни JSON: {\"clips\":[{\"i\":<индекс>,\"title\":\"<заголовок>\","
          "\"keep\":true|false,\"rank\":<0..1>}]}. "
          "keep=false только для откровенно слабых фрагментов."
    )
    parsed = await gptunnel.chat_json(_SYSTEM, user)
    if not parsed or "clips" not in parsed:
        return
    by_i = {int(item["i"]): item for item in parsed["clips"] if "i" in item}
    for i, clip in enumerate(clips):
        item = by_i.get(i)
        if not item:
            continue
        if item.get("title"):
            clip.title = str(item["title"]).strip()[:120]
        if isinstance(item.get("rank"), (int, float)):
            clip.segments[0].score = round(float(item["rank"]), 4)
        if item.get("keep") is False and len(clips) > 1:
            clip.included = False


async def _vision_titles(clips: list[EdlClip], sources: list[SourceAnalysis],
                         locals_by_idx: list[str]) -> None:
    """For silent clips, ask gpt-4o to title + score a sampled keyframe."""
    work = tempfile.mkdtemp(prefix="editor_vision_")
    try:
        for i, clip in enumerate(clips):
            if clip.transcript_snippet.strip():
                continue
            src_idx, t = _clip_midpoint(clip)
            if src_idx >= len(locals_by_idx):
                continue
            frame = os.path.join(work, f"clip_{i}.jpg")
            try:
                fx.extract_frame(locals_by_idx[src_idx], t, frame, width=512)
            except Exception:  # noqa: BLE001
                continue
            parsed = await gptunnel.vision_score(
                "Опиши кадр короткого видео. Верни JSON "
                "{\"title\":\"<вирусный заголовок на русском>\","
                "\"interest\":<0..1>}.",
                [frame],
            )
            if not parsed:
                continue
            if parsed.get("title"):
                clip.title = str(parsed["title"]).strip()[:120]
            if isinstance(parsed.get("interest"), (int, float)):
                clip.segments[0].score = round(float(parsed["interest"]), 4)
    finally:
        import shutil
        shutil.rmtree(work, ignore_errors=True)


async def enrich_clips(clips: list[EdlClip], sources: list[SourceAnalysis], *,
                       use_vision: bool = False,
                       locals_by_idx: list[str] | None = None) -> list[EdlClip]:
    """Re-rank + title clips via GPTunnel. Returns clips (possibly reordered)."""
    if not gptunnel.is_configured() or not clips:
        return clips

    await _text_rerank(clips)
    if use_vision and locals_by_idx:
        await _vision_titles(clips, sources, locals_by_idx)

    # Re-order by (refined) score, keep included first, renumber order.
    clips.sort(key=lambda c: (c.included, c.segments[0].score), reverse=True)
    for order, clip in enumerate(clips):
        clip.order = order
    return clips
