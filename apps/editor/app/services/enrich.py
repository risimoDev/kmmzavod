"""LLM enrichment of the EDL (Phase 2).

Two-tier strategy, everything degrading gracefully to the heuristic result:

1. **Full-transcript proposal** (highlights geometry): the model reads the WHOLE
   timecoded transcript and proposes highlight ranges itself — story-driven
   selection («найди хук, конфликт, панчлайн»), not just a re-rank of windows.
   Proposed ranges are validated, snapped to speech pauses and merged with the
   heuristic clips (LLM picks first, heuristic fills the remainder).
2. **Re-rank + titles** fallback: when the proposal is unavailable (no key, no
   transcript, bad JSON) the heuristic clips are re-ranked by their snippets.

For silent clips (no transcript) with ``use_vision`` on, a keyframe is sampled
and gpt-4o judges interest + titles the shot.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile

from app.models import EdlClip, EdlSegment, SourceAnalysis
from app.services import ffmpeg as fx
from app.services import gptunnel
from app.services.select import _window_score, _transcript_snippet, snap_window

logger = logging.getLogger(__name__)

_SYSTEM = (
    "Ты — монтажёр коротких вертикальных видео (Reels/TikTok). "
    "Тебе дают видео-фрагменты с расшифровкой речи. Выбери самые цепляющие "
    "и придумай короткий вирусный заголовок на русском для каждого. "
    "Отвечай строго одним валидным JSON-объектом."
)

_PROPOSE_SYSTEM = (
    "Ты — монтажёр вирусных коротких видео (Reels/TikTok). Тебе дают полную "
    "расшифровку исходников с таймкодами. Найди самые цепляющие моменты: хук, "
    "конфликт, инсайт, панчлайн. Каждый выбранный диапазон должен быть "
    "самодостаточной мыслью — начинаться с начала фразы и заканчиваться её "
    "завершением. Отвечай строго одним валидным JSON-объектом."
)

# Max characters of transcript shipped to the model (~4k tokens of RU text).
_TRANSCRIPT_CHAR_CAP = 14000


def _clip_midpoint(clip: EdlClip) -> tuple[int, float]:
    """Return (src_idx, time) at the middle of a clip's first segment."""
    seg = clip.segments[0]
    return seg.src_idx, (seg.start + seg.end) / 2.0


# ── Tier 1: full-transcript range proposal ────────────────────────────────────

def _timecoded_transcript(sources: list[SourceAnalysis]) -> str:
    lines: list[str] = []
    budget = _TRANSCRIPT_CHAR_CAP
    for idx, src in enumerate(sources):
        for seg in src.transcript:
            line = f"[src{idx} {seg.start:.1f}-{seg.end:.1f}] {seg.text.strip()}"
            budget -= len(line) + 1
            if budget <= 0:
                return "\n".join(lines)
            lines.append(line)
    return "\n".join(lines)


async def _llm_propose(sources: list[SourceAnalysis], *, target_count: int,
                       target_seconds: float) -> list[EdlClip] | None:
    """Ask the model for highlight ranges over the full transcript. None on failure."""
    transcript = _timecoded_transcript(sources)
    if not transcript.strip():
        return None
    user = (
        f"Расшифровка (формат [srcN start-end] текст):\n{transcript}\n\n"
        f"Выбери до {target_count} лучших моментов длительностью примерно "
        f"{target_seconds:.0f} сек каждый (допустимо {target_seconds * 0.5:.0f}–"
        f"{target_seconds * 1.5:.0f} сек). Верни JSON: "
        "{\"clips\":[{\"src\":<N>,\"start\":<сек>,\"end\":<сек>,"
        "\"title\":\"<вирусный заголовок>\",\"rank\":<0..1>}]}"
    )
    parsed = await gptunnel.chat_json(_PROPOSE_SYSTEM, user, max_tokens=2000)
    if not parsed or not isinstance(parsed.get("clips"), list):
        return None

    out: list[EdlClip] = []
    for item in parsed["clips"]:
        try:
            src_idx = int(item["src"])
            start, end = float(item["start"]), float(item["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= src_idx < len(sources)):
            continue
        src = sources[src_idx]
        # Clamp to sane bounds relative to the target, then snap to pauses.
        if end - start < 3.0 or end - start > target_seconds * 2.5:
            continue
        start, end = snap_window(src, max(0.0, start), min(end, src.duration_sec))
        if end - start < 3.0:
            continue
        rank = item.get("rank")
        score = round(float(rank), 4) if isinstance(rank, (int, float)) \
            else _window_score(src, start, end)
        out.append(EdlClip(
            title=str(item.get("title", "")).strip()[:120] or f"Момент {len(out) + 1}",
            segments=[EdlSegment(src_idx=src_idx, start=start, end=end, score=score)],
            transcript_snippet=_transcript_snippet(src, start, end),
        ))
        if len(out) >= target_count:
            break
    return out or None


def _overlaps(a: EdlClip, b: EdlClip) -> bool:
    sa, sb = a.segments[0], b.segments[0]
    return sa.src_idx == sb.src_idx and not (sa.end <= sb.start or sa.start >= sb.end)


def _merge(llm: list[EdlClip], heuristic: list[EdlClip], target_count: int) -> list[EdlClip]:
    """LLM picks first; heuristic clips fill remaining slots if they don't overlap."""
    merged = list(llm)
    for clip in heuristic:
        if len(merged) >= target_count:
            break
        if not any(_overlaps(clip, m) for m in merged):
            merged.append(clip)
    return merged


# ── Tier 2: re-rank fallback ──────────────────────────────────────────────────

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
                       locals_by_idx: list[str] | None = None,
                       target_count: int | None = None,
                       target_seconds: float | None = None) -> list[EdlClip]:
    """LLM layer over the heuristic EDL. Returns clips (possibly replaced/reordered)."""
    if not gptunnel.is_configured() or not clips:
        return clips

    proposed = None
    # Full-transcript proposal only makes sense for single-segment (highlight) clips.
    if target_count and target_seconds and all(len(c.segments) == 1 for c in clips):
        proposed = await _llm_propose(sources, target_count=target_count,
                                      target_seconds=target_seconds)
    if proposed:
        clips = _merge(proposed, clips, target_count or len(proposed))
        logger.info("LLM proposed %d ranges (merged to %d clips)", len(proposed), len(clips))
    else:
        await _text_rerank(clips)

    if use_vision and locals_by_idx:
        await _vision_titles(clips, sources, locals_by_idx)

    # Re-order by (refined) score, keep included first, renumber order.
    clips.sort(key=lambda c: (c.included, c.segments[0].score), reverse=True)
    for order, clip in enumerate(clips):
        clip.order = order
    return clips
