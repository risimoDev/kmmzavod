"""ASS subtitle generator for the editor render phase.

Self-contained, social-friendly styles. When Whisper word timestamps are
available the subtitles are rendered **karaoke-style**: short punchy lines
where the active word lights up in the highlight colour as it is spoken
(the retention-friendly TikTok / MrBeast look). Without word data it falls back to
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


# Style definition:
# (fontsize_frac, primary(=highlight), secondary(=unspoken), outline,
#  outline_w, bold, align, margin_v_frac, border_style, back_colour, fontname)
_STYLES = {
    # TikTok classic: Bright yellow highlight, crisp white unspoken, thick black stroke
    "tiktok":      (0.056, "&H0000FFFF", "&H00FFFFFF", "&H00000000", 3.8, -1, 2, 0.18, 1, "&H00000000", "Arial"),
    # MrBeast style: Electric neon yellow, chunky bold, safe higher placement (avoiding TikTok UI), bouncy
    "mrbeast":     (0.065, "&H0000E6FF", "&H00FFFFFF", "&H00000000", 4.8, -1, 2, 0.22, 1, "&H00000000", "Arial Black"),
    # Neon Glow: Cyberpunk cyan highlight with vivid magenta outline & dark pill backing
    "neon_glow":   (0.052, "&H00FFFF00", "&H00E0E0E0", "&H00FF0080", 3.2, -1, 2, 0.18, 1, "&H80000000", "Arial"),
    # Fire Hype: Fiery orange-red highlight on pure white, high-energy impact
    "fire_hype":   (0.060, "&H000077FF", "&H00FFFFFF", "&H00000000", 4.0, -1, 2, 0.20, 1, "&H00000000", "Arial Black"),
    # 1-Word Flash: 1 word at a time, center screen, maximum retention for ultra-fast shorts
    "single_word": (0.075, "&H0000FFFF", "&H00FFFFFF", "&H00000000", 5.0, -1, 5, 0.45, 1, "&H00000000", "Arial Black"),
    # Cinematic: Elegant serif/clean sans, wider tracking, lower third
    "cinematic":   (0.042, "&H00FFFFFF", "&H00CCCCCC", "&H64000000", 2.0, 0, 2, 0.10, 1, "&H00000000", "Arial"),
    # Minimal: Subtle, translucent back box, modern aesthetic
    "minimal":     (0.038, "&H00FFFFFF", "&H00A0A0A0", "&H00000000", 1.5, 0, 2, 0.12, 1, "&H00000000", "Arial"),
    # Classic default
    "default":     (0.050, "&H0000D7FF", "&H00FFFFFF", "&H00000000", 2.8, -1, 2, 0.16, 1, "&H00000000", "Arial"),
}


def _ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("\n", " ").replace("{", "(").replace("}", ")").strip()


def regroup_words(lines: list[SubLine], style: str = "tiktok") -> list[SubLine]:
    """Re-split word-timestamped lines into punchy karaoke groups based on style.
    Breaks early on natural speech pauses."""
    words = [w for ln in lines for w in ln.words if w.text.strip()]
    if not words:
        return lines

    if style == "single_word":
        max_words = 1
        max_line_sec = 1.0
        break_gap = 0.15
    elif style in ("mrbeast", "fire_hype"):
        max_words = 3
        max_line_sec = 1.8
        break_gap = 0.4
    elif style == "cinematic":
        max_words = 6
        max_line_sec = 3.5
        break_gap = 0.7
    else:
        # Default / TikTok / Neon
        max_words = 4
        max_line_sec = 2.2
        break_gap = 0.5

    out: list[SubLine] = []
    cur: list[SubWord] = []
    for w in words:
        if cur and (
            len(cur) >= max_words
            or w.end - cur[0].start > max_line_sec
            or w.start - cur[-1].end > break_gap
        ):
            out.append(SubLine(cur[0].start, cur[-1].end,
                               " ".join(x.text.strip() for x in cur), cur))
            cur = []
        cur.append(w)
    if cur:
        out.append(SubLine(cur[0].start, cur[-1].end,
                           " ".join(x.text.strip() for x in cur), cur))
    return out


def _karaoke_text(line: SubLine, style: str = "tiktok") -> str:
    """ASS \\k / \\kf tags: each word holds SecondaryColour until its start,
    then flips to PrimaryColour. Smooth fill (\\kf) used for high-energy styles."""
    tag = "\\kf" if style in ("mrbeast", "fire_hype", "neon_glow") else "\\k"
    parts: list[str] = []
    for i, w in enumerate(line.words):
        nxt = line.words[i + 1].start if i + 1 < len(line.words) else line.end
        dur_cs = max(1, round((nxt - w.start) * 100))
        parts.append(f"{{{tag}{dur_cs}}}{_esc(w.text)}")
    return " ".join(parts)


def generate_ass(lines: list[SubLine], out_path: str, width: int, height: int,
                 style: str = "tiktok") -> None:
    style_spec = _STYLES.get(style, _STYLES["default"])
    (fsz_frac, primary, secondary, outline, ow, bold, align, mv_frac,
     border_style, back_colour, fontname) = style_spec

    fontsize = max(18, int(height * fsz_frac))
    margin_v = int(height * mv_frac)
    margin_h = int(width * 0.08)

    karaoke = any(ln.words for ln in lines)
    if karaoke:
        lines = regroup_words(lines, style=style)

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
        f"Style: Main,{fontname},{fontsize},{primary},{secondary},{outline},{back_colour},"
        f"{bold},0,{border_style},{ow},0,{align},{margin_h},{margin_h},{margin_v}\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    body = []
    for ln in lines:
        if ln.end <= ln.start:
            continue

        if style == "single_word":
            # Pop-in bouncy scale animation for 1-word flash
            raw_text = _esc(ln.text).upper()
            anim = "{\\fad(30,30)\\t(0,70,\\fscx112\\fscy112)\\t(70,140,\\fscx100\\fscy100)}"
            text = f"{anim}{raw_text}"
        elif style in ("mrbeast", "fire_hype"):
            # Slight bounce on line start + karaoke highlighting
            anim = "{\\t(0,80,\\fscx104\\fscy104)\\t(80,160,\\fscx100\\fscy100)}"
            text = anim + (_karaoke_text(ln, style) if ln.words else _esc(ln.text).upper())
        else:
            text = _karaoke_text(ln, style) if ln.words else _esc(ln.text)

        if not text:
            continue
        body.append(f"Dialogue: 0,{_ts(ln.start)},{_ts(ln.end)},Main,,0,0,0,,{text}")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(body) + "\n")
