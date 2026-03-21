"""
ASS subtitle generation for vertical social-media video.

Supported styles
────────────────
DEFAULT   — White Arial, 3 px black outline, bottom-centre, max 28 chars/line
TIKTOK    — Bold white, yellow second colour (karaoke), no box, 2–3 words/line
CINEMATIC — Italic, smaller body text, semi-transparent dark background box
MINIMAL   — Small font, no outline, upper-centre placement

All styles target a 1080 × 1920 canvas.  ``PlayResX/Y`` in the ASS header
must match the video resolution passed to ``generate_ass_file``.

Word wrapping
─────────────
Long subtitle lines are wrapped at ``max_chars`` per line using
``_wrap_text()``.  ASS uses ``\\N`` (escaped backslash-N) for hard newlines.
"""

from __future__ import annotations

import textwrap
from dataclasses import dataclass
from typing import Sequence

from app.models import SubtitleEntry, SubtitleStyle


# ─────────────────────────────────────────────────────────────────────────────
# Style definitions
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _StyleDef:
    name: str
    fontname: str
    fontsize: int
    primary_colour: str   # &HAABBGGRR  (alpha, blue, green, red)
    secondary_colour: str
    outline_colour: str
    back_colour: str
    bold: int             # -1 = bold, 0 = normal
    italic: int
    border_style: int     # 1 = outline+shadow, 3 = opaque box
    outline: int          # px
    shadow: int           # px
    alignment: int        # SSA numpad: 1–9
    margin_v: int         # vertical margin from edge (px)
    max_chars_per_line: int


_STYLES: dict[SubtitleStyle, _StyleDef] = {
    SubtitleStyle.DEFAULT: _StyleDef(
        name="Default",
        fontname="Arial",
        fontsize=56,
        primary_colour="&H00FFFFFF",   # white
        secondary_colour="&H000000FF", # blue (unused)
        outline_colour="&H00000000",   # black outline
        back_colour="&H80000000",      # semi-transparent shadow
        bold=-1,
        italic=0,
        border_style=1,
        outline=3,
        shadow=0,
        alignment=2,   # bottom-centre
        margin_v=90,
        max_chars_per_line=28,
    ),
    SubtitleStyle.TIKTOK: _StyleDef(
        name="TikTok",
        fontname="Arial",
        fontsize=68,
        primary_colour="&H00FFFFFF",   # white
        secondary_colour="&H0000FFFF", # yellow highlight (karaoke)
        outline_colour="&H00000000",
        back_colour="&H00000000",
        bold=-1,
        italic=0,
        border_style=1,
        outline=4,
        shadow=2,
        alignment=2,   # bottom-centre
        margin_v=120,
        max_chars_per_line=18,         # 2–3 words per line
    ),
    SubtitleStyle.CINEMATIC: _StyleDef(
        name="Cinematic",
        fontname="Arial",
        fontsize=44,
        primary_colour="&H00FFFFFF",
        secondary_colour="&H000000FF",
        outline_colour="&H00000000",
        back_colour="&HAA000000",      # dark semi-transparent box
        bold=0,
        italic=-1,
        border_style=3,                # opaque box background
        outline=0,
        shadow=0,
        alignment=2,
        margin_v=80,
        max_chars_per_line=32,
    ),
    SubtitleStyle.MINIMAL: _StyleDef(
        name="Minimal",
        fontname="Arial",
        fontsize=38,
        primary_colour="&H00FFFFFF",
        secondary_colour="&H000000FF",
        outline_colour="&H00000000",
        back_colour="&H00000000",
        bold=0,
        italic=0,
        border_style=1,
        outline=1,
        shadow=0,
        alignment=8,   # top-centre
        margin_v=80,
        max_chars_per_line=35,
    ),
}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _ts(sec: float) -> str:
    """Convert seconds → ASS timestamp ``H:MM:SS.cc``."""
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _escape_ass(text: str) -> str:
    """Escape characters that have special meaning in ASS dialogue text."""
    return text.replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def _wrap_text(text: str, max_chars: int) -> str:
    """
    Wrap ``text`` into lines of at most ``max_chars`` characters.

    Respects word boundaries (no mid-word breaks).
    Returns a string with ``\\N`` (ASS hard newline) between wrapped lines.
    """
    lines = textwrap.wrap(text, width=max_chars, break_long_words=False)
    return "\\N".join(lines) if lines else text


def _ass_header(style: _StyleDef, width: int, height: int) -> str:
    """Build the [Script Info] + [V4+ Styles] ASS sections."""
    s = style
    style_line = (
        f"Style: {s.name},{s.fontname},{s.fontsize},"
        f"{s.primary_colour},{s.secondary_colour},{s.outline_colour},{s.back_colour},"
        f"{s.bold},{s.italic},0,0,"        # Underline, StrikeOut
        f"100,100,0,0,"                    # ScaleX, ScaleY, Spacing, Angle
        f"{s.border_style},{s.outline},{s.shadow},"
        f"{s.alignment},"
        f"20,20,{s.margin_v},1"            # MarginL, R, V, Encoding
    )
    return (
        f"[Script Info]\n"
        f"ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        f"ScaledBorderAndShadow: yes\n"
        f"WrapStyle: 1\n\n"
        f"[V4+ Styles]\n"
        f"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        f"OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        f"ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        f"Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"{style_line}\n\n"
        f"[Events]\n"
        f"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def generate_ass_file(
    entries: Sequence[SubtitleEntry],
    output_path: str,
    width: int = 1080,
    height: int = 1920,
    style: SubtitleStyle = SubtitleStyle.TIKTOK,
) -> None:
    """
    Write an ASS subtitle file from a list of ``SubtitleEntry`` objects.

    Each entry's text is:
    1. Wrapped at the style's ``max_chars_per_line`` (word boundary).
    2. ASS-escaped (curly braces, newlines).
    3. Written as a ``Dialogue:`` event line.
    """
    style_def = _STYLES[style]

    dialogue_lines: list[str] = []
    for entry in entries:
        wrapped = _wrap_text(entry.text, style_def.max_chars_per_line)
        safe_text = _escape_ass(wrapped)
        start = _ts(entry.start_sec)
        end = _ts(entry.end_sec)
        dialogue_lines.append(
            f"Dialogue: 0,{start},{end},{style_def.name},,0,0,0,,{safe_text}"
        )

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(_ass_header(style_def, width, height))
        f.writelines(line + "\n" for line in dialogue_lines)

