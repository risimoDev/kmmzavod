"""
ASS subtitle generation for vertical social-media video.

Supported styles
────────────────
DEFAULT   — White Arial, 3 px black outline, bottom-centre, max 28 chars/line
TIKTOK    — Bold white, word-by-word animated karaoke, 2–3 words/chunk, yellow highlight
CINEMATIC — Italic, smaller body text, semi-transparent dark background box, fade in/out
MINIMAL   — Small font, no outline, upper-centre placement

All styles target a 1080 × 1920 canvas.  ``PlayResX/Y`` in the ASS header
must match the video resolution passed to ``generate_ass_file``.

Animation features
──────────────────
• TikTok:    Word-by-word karaoke with \\kf tags; words displayed in 2–3 word chunks
             with scale pop-in (\\fscx110\\fscy110→100%) per chunk
• Cinematic: Smooth fade-in/out per subtitle line (\\fad)
• Default:   Gentle fade-in per line (\\fad)
• Minimal:   Clean appearance, no animation
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
    words_per_chunk: int  # for karaoke: how many words per display chunk


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
        margin_v=300,
        max_chars_per_line=28,
        words_per_chunk=5,
    ),
    SubtitleStyle.TIKTOK: _StyleDef(
        name="TikTok",
        fontname="Arial",
        fontsize=72,
        primary_colour="&H00FFFFFF",   # white
        secondary_colour="&H0000FFFF", # yellow highlight (karaoke active)
        outline_colour="&H00000000",
        back_colour="&H00000000",
        bold=-1,
        italic=0,
        border_style=1,
        outline=5,
        shadow=3,
        alignment=2,   # bottom-centre
        margin_v=350,
        max_chars_per_line=18,
        words_per_chunk=2,
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
        margin_v=280,
        max_chars_per_line=32,
        words_per_chunk=6,
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
        margin_v=120,
        max_chars_per_line=35,
        words_per_chunk=6,
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
    lines = textwrap.wrap(text, width=max_chars, break_long_words=False)
    return "\\N".join(lines) if lines else text


def _ass_header(style: _StyleDef, width: int, height: int) -> str:
    """Build the [Script Info] + [V4+ Styles] ASS sections."""
    s = style
    style_line = (
        f"Style: {s.name},{s.fontname},{s.fontsize},"
        f"{s.primary_colour},{s.secondary_colour},{s.outline_colour},{s.back_colour},"
        f"{s.bold},{s.italic},0,0,"
        f"100,100,0,0,"
        f"{s.border_style},{s.outline},{s.shadow},"
        f"{s.alignment},"
        f"20,20,{s.margin_v},1"
    )

    # Additional style for highlight word (TikTok)
    highlight_style = ""
    if s.name == "TikTok":
        highlight_style = (
            f"\nStyle: TikTokHL,{s.fontname},{s.fontsize},"
            f"&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,"  # yellow primary
            f"{s.bold},{s.italic},0,0,"
            f"100,100,0,0,"
            f"{s.border_style},{s.outline},{s.shadow},"
            f"{s.alignment},"
            f"20,20,{s.margin_v},1"
        )

    return (
        f"[Script Info]\n"
        f"ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        f"ScaledBorderAndShadow: yes\n"
        f"WrapStyle: 0\n"
        f"Collisions: Normal\n\n"
        f"[V4+ Styles]\n"
        f"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        f"OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        f"ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        f"Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"{style_line}{highlight_style}\n\n"
        f"[Events]\n"
        f"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def _split_into_chunks(words: list[str], words_per_chunk: int) -> list[list[str]]:
    """Split a list of words into chunks of ``words_per_chunk``."""
    chunks: list[list[str]] = []
    for i in range(0, len(words), words_per_chunk):
        chunks.append(words[i:i + words_per_chunk])
    return chunks


def _word_duration_sec(word: str, total_duration: float, total_chars: int) -> float:
    """Estimate duration for a single word based on its character proportion."""
    if total_chars == 0:
        return 0.0
    return max(0.08, (len(word) / total_chars) * total_duration)


# ─────────────────────────────────────────────────────────────────────────────
# Animated subtitle generators per style
# ─────────────────────────────────────────────────────────────────────────────

def _generate_tiktok_dialogue(
    entry: SubtitleEntry,
    style_def: _StyleDef,
) -> list[str]:
    """
    TikTok-style: word-by-word karaoke in chunks of 2–3 words.
    Each chunk appears with a pop-in scale animation.
    Current word is highlighted yellow via \\kf (smooth fill karaoke).
    """
    words = entry.text.split()
    if not words:
        return []

    total_chars = sum(len(w) for w in words)
    entry_duration = entry.end_sec - entry.start_sec
    if entry_duration <= 0:
        return []

    chunks = _split_into_chunks(words, style_def.words_per_chunk)
    dialogue_lines: list[str] = []

    cursor = entry.start_sec

    for chunk in chunks:
        chunk_chars = sum(len(w) for w in chunk)
        chunk_duration = max(0.3, (chunk_chars / max(total_chars, 1)) * entry_duration)
        chunk_start = cursor
        chunk_end = min(cursor + chunk_duration, entry.end_sec)

        # Build karaoke text with \kf tags (centiseconds)
        # \kf = smooth karaoke fill using secondary colour
        kara_parts: list[str] = []
        word_cursor_cs = 0  # centiseconds within the chunk
        chunk_word_chars = sum(len(w) for w in chunk)

        for wi, word in enumerate(chunk):
            word_dur_cs = max(8, int((_word_duration_sec(word, chunk_end - chunk_start, chunk_word_chars)) * 100))
            safe_word = _escape_ass(word)
            kara_parts.append(f"{{\\kf{word_dur_cs}}}{safe_word}")
            word_cursor_cs += word_dur_cs

        chunk_text = " ".join(kara_parts) if not kara_parts else kara_parts[0]
        # Join with spaces between words (space between ASS kf blocks)
        chunk_text = " ".join(kara_parts)

        # Pop-in animation: start at 110% scale → settle to 100% over 150ms
        pop_in = "{\\fscx115\\fscy115\\t(0,150,\\fscx100\\fscy100)}"

        start = _ts(chunk_start)
        end = _ts(chunk_end)
        dialogue_lines.append(
            f"Dialogue: 0,{start},{end},{style_def.name},,0,0,0,,{pop_in}{chunk_text}"
        )

        cursor = chunk_end

    return dialogue_lines


def _generate_cinematic_dialogue(
    entry: SubtitleEntry,
    style_def: _StyleDef,
) -> list[str]:
    """
    Cinematic style: full text with fade-in 300ms / fade-out 400ms.
    """
    wrapped = _wrap_text(entry.text, style_def.max_chars_per_line)
    safe_text = _escape_ass(wrapped)
    start = _ts(entry.start_sec)
    end = _ts(entry.end_sec)
    # \fad(fade_in_ms, fade_out_ms)
    fade = "{\\fad(300,400)}"
    return [
        f"Dialogue: 0,{start},{end},{style_def.name},,0,0,0,,{fade}{safe_text}"
    ]


def _generate_default_dialogue(
    entry: SubtitleEntry,
    style_def: _StyleDef,
) -> list[str]:
    """
    Default style: full text with gentle fade-in 200ms / fade-out 200ms.
    """
    wrapped = _wrap_text(entry.text, style_def.max_chars_per_line)
    safe_text = _escape_ass(wrapped)
    start = _ts(entry.start_sec)
    end = _ts(entry.end_sec)
    fade = "{\\fad(200,200)}"
    return [
        f"Dialogue: 0,{start},{end},{style_def.name},,0,0,0,,{fade}{safe_text}"
    ]


def _generate_minimal_dialogue(
    entry: SubtitleEntry,
    style_def: _StyleDef,
) -> list[str]:
    """
    Minimal style: clean text, no animation.
    """
    wrapped = _wrap_text(entry.text, style_def.max_chars_per_line)
    safe_text = _escape_ass(wrapped)
    start = _ts(entry.start_sec)
    end = _ts(entry.end_sec)
    return [
        f"Dialogue: 0,{start},{end},{style_def.name},,0,0,0,,{safe_text}"
    ]


# Style → generator mapping
_GENERATORS = {
    SubtitleStyle.TIKTOK: _generate_tiktok_dialogue,
    SubtitleStyle.CINEMATIC: _generate_cinematic_dialogue,
    SubtitleStyle.DEFAULT: _generate_default_dialogue,
    SubtitleStyle.MINIMAL: _generate_minimal_dialogue,
}


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

    For TikTok style: generates word-by-word karaoke animation with pop-in.
    For Cinematic: generates fade-in/fade-out lines.
    For Default: gentle fade per line.
    For Minimal: clean static text.
    """
    style_def = _STYLES[style]
    generator = _GENERATORS[style]

    dialogue_lines: list[str] = []
    for entry in entries:
        dialogue_lines.extend(generator(entry, style_def))

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(_ass_header(style_def, width, height))
        f.writelines(line + "\n" for line in dialogue_lines)

