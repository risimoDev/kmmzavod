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

import re
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
#
# Colours are ASS &HAABBGGRR. border_style 1 = outline + shadow; 4 = one solid box behind
# the whole line (libass ≥ 0.17; style 3 would draw a separate box per karaoke word).
# Box styles set OutlineColour = BackColour = the box colour.
# Fonts are installed in the editor image (see Dockerfile) and all cover Cyrillic:
# Montserrat, Roboto, Open Sans, Comfortaa, PT Sans / PT Sans Narrow / PT Serif,
# Lobster, DejaVu Sans, Liberation Sans. A missing font only falls back, never fails.
_STYLES = {
    # TikTok classic: bright yellow highlight, crisp white unspoken, thick black stroke
    "tiktok":      (0.040, "&H0000FFFF", "&H00FFFFFF", "&H00000000", 3.4, -1, 2, 0.18, 1, "&H00000000", "Montserrat"),
    # MrBeast: electric yellow, chunky black-weight font, higher placement, bouncy
    "mrbeast":     (0.044, "&H0000E6FF", "&H00FFFFFF", "&H00000000", 4.0, -1, 2, 0.22, 1, "&H00000000", "Montserrat Black"),
    # Neon glow: cyan highlight, magenta outline, rounded font
    "neon_glow":   (0.038, "&H00FFFF00", "&H00E0E0E0", "&H00FF0080", 3.0, -1, 2, 0.18, 1, "&H80000000", "Comfortaa"),
    # Fire hype: orange-red highlight on white, heavy font
    "fire_hype":   (0.042, "&H000077FF", "&H00FFFFFF", "&H00000000", 3.6, -1, 2, 0.20, 1, "&H00000000", "Roboto Black"),
    # 1-word flash: one word at a time, centre screen
    "single_word": (0.050, "&H0000FFFF", "&H00FFFFFF", "&H00000000", 4.5, -1, 5, 0.45, 1, "&H00000000", "Montserrat Black"),
    # Cinematic: serif, lower third, soft
    "cinematic":   (0.032, "&H00FFFFFF", "&H00CCCCCC", "&H64000000", 2.0, 0, 2, 0.12, 1, "&H00000000", "PT Serif"),
    # Minimal: thin outline, modern sans
    "minimal":     (0.028, "&H00FFFFFF", "&H00A0A0A0", "&H00000000", 1.5, 0, 2, 0.12, 1, "&H00000000", "Open Sans"),
    # ── new ────────────────────────────────────────────────────────────────
    # Yellow box: black words on a yellow block, spoken word turns red (IG-reels look)
    "yellow_box":  (0.036, "&H000000D0", "&H00000000", "&H0000E6FF", 6.0, -1, 2, 0.20, 4, "&H0000E6FF", "Montserrat Black"),
    # Dark pill: white text on a translucent black box, spoken word in mint
    "dark_pill":   (0.034, "&H00B4FF6E", "&H00FFFFFF", "&H90000000", 8.0, -1, 2, 0.18, 4, "&H90000000", "Roboto"),
    # News: uppercase white on a red bar, narrow font, lower third
    "news":        (0.034, "&H0000FFFF", "&H00FFFFFF", "&H002020D0", 7.0, -1, 2, 0.10, 4, "&H002020D0", "PT Sans Narrow"),
    # Handwritten: script font, warm peach highlight, soft dark outline
    "handwritten": (0.044, "&H0080B4FF", "&H00FFFFFF", "&H00301E14", 2.6, 0, 2, 0.18, 1, "&H00000000", "Lobster"),
    # Pastel: rounded font, pink highlight, light lavender outline
    "pastel":      (0.038, "&H00C77BFF", "&H00FFFFFF", "&H00602840", 2.8, -1, 2, 0.18, 1, "&H00000000", "Comfortaa"),
    # Gaming: neon green highlight, purple stroke, heavy font, bouncy
    "gaming":      (0.042, "&H0000FF66", "&H00FFFFFF", "&H00A0208C", 3.8, -1, 2, 0.20, 1, "&H00000000", "Roboto Black"),
    # Blue pop: white words, spoken word in electric blue, clean bold font
    "blue_pop":    (0.040, "&H00FF9A1E", "&H00FFFFFF", "&H00000000", 3.2, -1, 2, 0.18, 1, "&H00000000", "Open Sans ExtraBold"),
    # Center bold: big uppercase lines in the middle of the frame
    "center_bold": (0.048, "&H0000E6FF", "&H00FFFFFF", "&H00000000", 4.2, -1, 5, 0.45, 1, "&H00000000", "PT Sans"),
    # Classic default
    "default":     (0.038, "&H0000D7FF", "&H00FFFFFF", "&H00000000", 2.8, -1, 2, 0.18, 1, "&H00000000", "DejaVu Sans"),
}

# Behaviour per style (missing key → defaults below).
#   words  — (max_words, max_chars, max_line_sec, break_gap) for karaoke regrouping
#   fill   — smooth \kf highlight instead of the word-by-word \k flip
#   bounce — scale-pop at the start of each line
#   upper  — render the text in uppercase
#   flash  — one word at a time with a pop-in (centre)
_DEFAULT_TRAITS = {"words": (3, 20, 2.0, 0.45), "fill": False, "bounce": False, "upper": False, "flash": False}
_TRAITS = {
    "single_word": {"words": (1, 14, 1.0, 0.15), "flash": True, "upper": True},
    "mrbeast":     {"words": (3, 18, 1.8, 0.4), "fill": True, "bounce": True},
    "fire_hype":   {"words": (3, 18, 1.8, 0.4), "fill": True, "bounce": True},
    "neon_glow":   {"fill": True},
    "cinematic":   {"words": (5, 28, 3.0, 0.6)},
    "yellow_box":  {"words": (3, 18, 1.8, 0.4), "upper": True},
    "dark_pill":   {"words": (4, 24, 2.4, 0.5)},
    "news":        {"words": (4, 26, 2.6, 0.5), "upper": True},
    "handwritten": {"words": (4, 22, 2.4, 0.5), "fill": True},
    "pastel":      {"words": (3, 20, 2.0, 0.45), "fill": True},
    "gaming":      {"words": (2, 16, 1.4, 0.35), "fill": True, "bounce": True, "upper": True},
    "blue_pop":    {"words": (3, 20, 2.0, 0.45), "bounce": True},
    "center_bold": {"words": (2, 16, 1.4, 0.35), "upper": True, "bounce": True},
}

SUBTITLE_STYLE_IDS = tuple(k for k in _STYLES if k != "default")


def _traits(style: str) -> dict:
    return {**_DEFAULT_TRAITS, **_TRAITS.get(style, {})}


def _ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _esc(text: str) -> str:
    # Strip Fish Audio emotion brackets like [excited], [whispering]
    text = re.sub(r'\[[a-zA-Z_\s-]+\]', '', text)
    return text.replace("\n", " ").replace("{", "(").replace("}", ")").strip()


def _wrap_line_fallback(text: str, max_chars: int = 22) -> str:
    """Break long plain lines with \\N for ASS rendering when word timestamps are absent."""
    words = text.split()
    if not words:
        return text
    lines: list[str] = []
    cur_line: list[str] = []
    cur_len = 0
    for w in words:
        if cur_line and (cur_len + 1 + len(w) > max_chars):
            lines.append(" ".join(cur_line))
            cur_line = [w]
            cur_len = len(w)
        else:
            cur_line.append(w)
            cur_len += (1 if cur_line else 0) + len(w)
    if cur_line:
        lines.append(" ".join(cur_line))
    return "\\N".join(lines)


def regroup_words(lines: list[SubLine], style: str = "tiktok") -> list[SubLine]:
    """Re-split word-timestamped lines into punchy karaoke groups based on style.
    Enforces word count, character width, and breaks on speech pauses."""
    words = [
        w for ln in lines for w in ln.words
        if w.text.strip() and not re.match(r'^\[[a-zA-Z_\s-]+\]$', w.text.strip())
    ]
    if not words:
        return lines

    max_words, max_chars, max_line_sec, break_gap = _traits(style)["words"]

    out: list[SubLine] = []
    cur: list[SubWord] = []
    for w in words:
        cur_chars = sum(len(x.text.strip()) for x in cur) + max(0, len(cur) - 1)
        w_len = len(w.text.strip())
        if cur and (
            len(cur) >= max_words
            or (cur_chars + 1 + w_len > max_chars)
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
    if not line.words:
        return _wrap_line_fallback(_esc(line.text))
    tag = "\\kf" if _traits(style)["fill"] else "\\k"
    parts: list[str] = []

    # If the first word starts after the line starts, hold initial silence
    initial_gap = round((line.words[0].start - line.start) * 100)
    if initial_gap > 3:
        parts.append(f"{{{tag}{initial_gap}}}")

    for i, w in enumerate(line.words):
        nxt = line.words[i + 1].start if i + 1 < len(line.words) else max(w.end, line.end)
        dur_cs = max(1, round((nxt - w.start) * 100))
        parts.append(f"{{{tag}{dur_cs}}}{_esc(w.text)}")
    return " ".join(parts)


def generate_ass(lines: list[SubLine], out_path: str, width: int, height: int,
                 style: str = "tiktok") -> None:
    style_spec = _STYLES.get(style, _STYLES["default"])
    (fsz_frac, primary, secondary, outline, ow, bold, align, mv_frac,
     border_style, back_colour, fontname) = style_spec

    fontsize = max(18, int(height * fsz_frac))
    margin_v = max(80, int(height * mv_frac))
    # Safe horizontal padding: at least 10% of width (108px on 1080px canvas)
    margin_h = max(50, int(width * 0.10))

    karaoke = any(ln.words for ln in lines)
    if karaoke:
        lines = regroup_words(lines, style=style)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "Collisions: Normal\n\n"
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

        tr = _traits(style)
        if tr["flash"]:
            # Pop-in bouncy scale animation for 1-word flash
            raw_text = _esc(ln.text).upper()
            anim = "{\\fad(30,30)\\t(0,70,\\fscx112\\fscy112)\\t(70,140,\\fscx100\\fscy100)}"
            text = f"{anim}{raw_text}"
        else:
            if ln.words:
                body_text = _karaoke_text(ln, style)
            else:
                plain = _esc(ln.text)
                body_text = _wrap_line_fallback(plain.upper() if tr["upper"] else plain)
            if tr["upper"] and ln.words:
                # Uppercase the words but not the {\\k..} override tags.
                body_text = re.sub(r"(^|})([^{]*)", lambda m: m.group(1) + m.group(2).upper(), body_text)
            anim = "{\\t(0,80,\\fscx104\\fscy104)\\t(80,160,\\fscx100\\fscy100)}" if tr["bounce"] else ""
            text = anim + body_text

        if not text:
            continue
        body.append(f"Dialogue: 0,{_ts(ln.start)},{_ts(ln.end)},Main,,0,0,0,,{text}")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(body) + "\n")

