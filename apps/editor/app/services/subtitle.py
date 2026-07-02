"""ASS subtitle generator for the editor render phase.

Self-contained, social-friendly styles. When Whisper word timestamps are
available the subtitles are rendered **karaoke-style**: short 2–4 word lines
where the active word lights up in the highlight colour as it is spoken
(the retention-friendly TikTok look). Without word data it falls back to
plain per-line subtitles.

Entries are given in OUTPUT-timeline seconds (the caller transcribes the final
rendered audio, so lines are already on the output timeline).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SubWord:
    start: float
    end: float
    text: str


@dataclass
class SubLine:
    start: float
    end: float
    text: str
    words: list[SubWord] = field(default_factory=list)


_STYLES = {
    # name: (fontsize_frac, primary(=highlight), secondary(=unspoken), outline,
    #        outline_w, bold, align, margin_v_frac)
    "tiktok":    (0.058, "&H0000FFFF", "&H00FFFFFF", "&H00000000", 3.5, -1, 2, 0.16),
    "cinematic": (0.044, "&H00FFFFFF", "&H00DDDDDD", "&H64000000", 2.0, 0, 2, 0.10),
    "minimal":   (0.040, "&H00FFFFFF", "&H00BBBBBB", "&H00000000", 1.5, 0, 8, 0.08),
    "default":   (0.050, "&H0000D7FF", "&H00FFFFFF", "&H00000000", 2.5, -1, 2, 0.12),
}

# Karaoke line grouping: short punchy lines, broken on speech pauses.
_MAX_WORDS = 4
_MAX_LINE_SEC = 2.4
_BREAK_GAP = 0.6


def _ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("\n", " ").replace("{", "(").replace("}", ")").strip()


def regroup_words(lines: list[SubLine]) -> list[SubLine]:
    """Re-split word-timestamped lines into short karaoke lines (≤4 words,
    ≤2.4s), breaking early on natural speech pauses."""
    words = [w for ln in lines for w in ln.words if w.text.strip()]
    if not words:
        return lines
    out: list[SubLine] = []
    cur: list[SubWord] = []
    for w in words:
        if cur and (
            len(cur) >= _MAX_WORDS
            or w.end - cur[0].start > _MAX_LINE_SEC
            or w.start - cur[-1].end > _BREAK_GAP
        ):
            out.append(SubLine(cur[0].start, cur[-1].end,
                               " ".join(x.text.strip() for x in cur), cur))
            cur = []
        cur.append(w)
    if cur:
        out.append(SubLine(cur[0].start, cur[-1].end,
                           " ".join(x.text.strip() for x in cur), cur))
    return out


def _karaoke_text(line: SubLine) -> str:
    """ASS \\k tags: each word holds SecondaryColour until its start, then flips
    to PrimaryColour. Durations are centiseconds; trailing gap goes to the word."""
    parts: list[str] = []
    for i, w in enumerate(line.words):
        nxt = line.words[i + 1].start if i + 1 < len(line.words) else line.end
        dur_cs = max(1, round((nxt - w.start) * 100))
        parts.append(f"{{\\k{dur_cs}}}{_esc(w.text)}")
    return " ".join(parts)


def generate_ass(lines: list[SubLine], out_path: str, width: int, height: int,
                 style: str = "tiktok") -> None:
    fsz_frac, primary, secondary, outline, ow, bold, align, mv_frac = \
        _STYLES.get(style, _STYLES["default"])
    fontsize = max(16, int(height * fsz_frac))
    margin_v = int(height * mv_frac)
    margin_h = int(width * 0.06)

    karaoke = any(ln.words for ln in lines)
    if karaoke:
        lines = regroup_words(lines)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV\n"
        f"Style: Main,Arial,{fontsize},{primary},{secondary},{outline},&H00000000,"
        f"{bold},0,1,{ow},0,{align},{margin_h},{margin_h},{margin_v}\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    body = []
    for ln in lines:
        if ln.end <= ln.start:
            continue
        text = _karaoke_text(ln) if ln.words else _esc(ln.text)
        if not text:
            continue
        body.append(f"Dialogue: 0,{_ts(ln.start)},{_ts(ln.end)},Main,,0,0,0,,{text}")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(body) + "\n")
