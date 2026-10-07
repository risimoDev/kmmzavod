"""Subtitle text from the known voiceover script, timings from Whisper.

When the narration is TTS of a script we wrote, the script IS the ground truth
for spelling (brand names, product names, numbers) — Whisper only knows *when*
each word is said. We align the two token streams (difflib) and keep Whisper's
timings with the script's words. Unmatched script words are spread over the
matching time gap; Whisper-only words (mis-hearings) are dropped.
"""

from __future__ import annotations

import difflib
import re

from app.services.subtitle import SubLine, SubWord

_TAG_RE = re.compile(r"\[[a-zA-Z_\s-]+\]")


def _norm(token: str) -> str:
    return re.sub(r"[^\w]", "", token.lower().replace("ё", "е"))


def script_tokens(script: str) -> list[str]:
    return [t for t in _TAG_RE.sub(" ", script).split() if _norm(t)]


def align_to_script(lines: list[SubLine], script: str) -> list[SubLine]:
    """Return ``lines`` re-spelled from ``script`` (same line timing structure)."""
    words = [w for ln in lines for w in ln.words if w.text.strip()]
    tokens = script_tokens(script)
    if not words or not tokens:
        return lines

    a = [_norm(w.text) for w in words]
    b = [_norm(t) for t in tokens]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    # Too different → the audio isn't this script (user edited text after TTS).
    if sm.ratio() < 0.45:
        return lines

    out: list[SubWord] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                w = words[i1 + k]
                out.append(SubWord(start=w.start, end=w.end, text=tokens[j1 + k]))
            continue
        if j2 <= j1:
            continue  # Whisper heard something that isn't in the script — drop it
        if i2 > i1:
            t0, t1 = words[i1].start, words[i2 - 1].end
        else:
            t0 = out[-1].end if out else words[0].start
            t1 = words[i1].start if i1 < len(words) else t0 + 0.32 * (j2 - j1)
        t1 = max(t1, t0 + 0.08 * (j2 - j1))
        step = (t1 - t0) / (j2 - j1)
        for k in range(j2 - j1):
            out.append(SubWord(start=round(t0 + k * step, 3), end=round(t0 + (k + 1) * step, 3),
                               text=tokens[j1 + k]))

    # Regroup into the original lines by time so line breaks stay natural.
    bounds = [ln.start for ln in lines[1:]] + [float("inf")]
    regrouped: list[SubLine] = []
    wi = 0
    for ln, nxt in zip(lines, bounds):
        bucket: list[SubWord] = []
        while wi < len(out) and out[wi].start < nxt - 0.02:
            bucket.append(out[wi])
            wi += 1
        if bucket:
            regrouped.append(SubLine(start=bucket[0].start, end=max(bucket[-1].end, bucket[0].start + 0.2),
                                     text=" ".join(w.text for w in bucket), words=bucket))
    if wi < len(out) and regrouped:
        tail = out[wi:]
        last = regrouped[-1]
        last.words.extend(tail)
        last.end = tail[-1].end
        last.text = " ".join(w.text for w in last.words)
    return regrouped or lines


def lines_from_script(script: str, duration: float, chunk: int = 4) -> list[SubLine]:
    """No Whisper: spread the script over the voice duration by character weight."""
    tokens = script_tokens(script)
    if not tokens or duration <= 0:
        return []
    total = sum(len(t) + 1 for t in tokens)
    t = 0.0
    words: list[SubWord] = []
    for tok in tokens:
        d = duration * (len(tok) + 1) / total
        words.append(SubWord(start=round(t, 3), end=round(t + d, 3), text=tok))
        t += d
    return [
        SubLine(start=ws[0].start, end=ws[-1].end, text=" ".join(w.text for w in ws), words=ws)
        for ws in (words[i:i + chunk] for i in range(0, len(words), chunk))
    ]
