"""Minimal ASS subtitle generator for the editor render phase.

Self-contained (one clean, social-friendly style) so apps/editor can burn
subtitles without depending on video-processor yet. When the shared media-core
package lands (Phase 3b) this can defer to the richer subtitle styles there.

Entries are given in OUTPUT-timeline seconds (the caller maps source transcript
to the cut/reordered output before calling this).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SubLine:
    start: float
    end: float
    text: str


_STYLES = {
    # name: (fontsize_frac_of_height, primary, outline, outline_w, bold, align, margin_v_frac)
    "tiktok":    (0.058, "&H00FFFFFF", "&H00000000", 3.5, -1, 2, 0.16),
    "cinematic": (0.044, "&H00FFFFFF", "&H64000000", 2.0, 0, 2, 0.10),
    "minimal":   (0.040, "&H00FFFFFF", "&H00000000", 1.5, 0, 8, 0.08),
    "default":   (0.050, "&H00FFFFFF", "&H00000000", 2.5, -1, 2, 0.12),
}


def _ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("\n", " ").replace("{", "(").replace("}", ")").strip()


def generate_ass(lines: list[SubLine], out_path: str, width: int, height: int,
                 style: str = "tiktok") -> None:
    fsz_frac, primary, outline, ow, bold, align, mv_frac = _STYLES.get(style, _STYLES["default"])
    fontsize = max(16, int(height * fsz_frac))
    margin_v = int(height * mv_frac)
    margin_h = int(width * 0.06)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, "
        "Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        f"Style: Main,Arial,{fontsize},{primary},{outline},&H00000000,"
        f"{bold},0,1,{ow},0,{align},{margin_h},{margin_h},{margin_v}\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    body = []
    for ln in lines:
        text = _esc(ln.text)
        if not text or ln.end <= ln.start:
            continue
        body.append(f"Dialogue: 0,{_ts(ln.start)},{_ts(ln.end)},Main,,0,0,0,,{text}")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(body) + "\n")
