#!/usr/bin/env python3
"""CLI for local / offline use of the editor analysis & selection pipeline.

Examples
────────
# Probe a media file:
python cli.py probe video.mp4

# Analyse one or more sources and print the proposed storyboard (EDL):
python cli.py analyze a.mp4 b.mp4 --geometry highlights --clips 5 --seconds 30
python cli.py analyze long.mp4 --geometry mix --seconds 25 --no-transcript

In LOCAL mode source arguments are treated as local file paths.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import click

sys.path.insert(0, str(Path(__file__).parent))


@click.group()
def cli() -> None:
    """kmmzavod editor — local CLI."""


@cli.command()
@click.argument("media_file", type=click.Path(exists=True))
def probe(media_file: str) -> None:
    """Print media file metadata (via ffprobe)."""
    from app.services.ffmpeg import probe as _probe

    info = _probe(media_file)
    click.echo(
        f"Duration : {info.duration:.3f}s\n"
        f"Video    : {info.width}x{info.height} @ {info.fps:.2f}fps (has_video={info.has_video})\n"
        f"Audio    : has_audio={info.has_audio}"
    )


@cli.command()
@click.argument("sources", nargs=-1, required=True, type=click.Path(exists=True))
@click.option("-g", "--geometry", type=click.Choice(["highlights", "mix"]), default="highlights")
@click.option("--clips", "clip_count", default=5, help="Target clip count (highlights)")
@click.option("--seconds", "target_seconds", default=30.0, help="Target clip length (s)")
@click.option("--no-transcript", is_flag=True, help="Skip Whisper (faster offline check)")
@click.option("-o", "--output", default="", help="Write full JSON result to this path")
def analyze(sources, geometry, clip_count, target_seconds, no_transcript, output):
    """Analyse sources and print the proposed storyboard (EDL)."""
    from app.models import Geometry, SourceAnalysis
    from app.services import select as selector
    from app.services.analyze import analyze_source

    async def _run():
        analyses: list[SourceAnalysis] = []
        for src in sources:
            click.echo(f"Analysing {src} ...")
            analyses.append(await analyze_source(src, storage_key=src,
                                                 with_transcript=not no_transcript))
        clips = selector.build_clips(
            analyses, Geometry(geometry),
            target_count=clip_count, target_seconds=target_seconds,
        )
        return analyses, clips

    analyses, clips = asyncio.run(_run())

    click.secho(f"\n{len(analyses)} source(s):", fg="cyan")
    for i, a in enumerate(analyses):
        click.echo(
            f"  [{i}] {a.duration_sec:.1f}s {a.width}x{a.height} "
            f"scenes={len(a.scene_breaks)} beats={len(a.beats)} "
            f"face={a.face_ratio} motion={a.motion_score} "
            f"transcript_segs={len(a.transcript)}"
        )

    click.secho(f"\n{len(clips)} proposed clip(s):", fg="green")
    for c in clips:
        seg_desc = ", ".join(
            f"src{s.src_idx}[{s.start:.1f}-{s.end:.1f}] {s.score:.2f}" for s in c.segments
        )
        click.echo(f"  - {c.title}: {seg_desc}")
        if c.transcript_snippet:
            click.echo(f'      "{c.transcript_snippet}"')

    if output:
        payload = {
            "sources": [a.model_dump() for a in analyses],
            "clips": [c.model_dump() for c in clips],
        }
        Path(output).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        click.secho(f"\n[done] JSON written to {output}", fg="green")


@cli.command()
@click.argument("sources", nargs=-1, required=True, type=click.Path(exists=True))
@click.option("-g", "--geometry", type=click.Choice(["highlights", "mix"]), default="highlights")
@click.option("-m", "--mode", type=click.Choice(["uniquify_source", "smart_montage"]),
              default="smart_montage")
@click.option("--aspect", type=click.Choice(["9:16", "1:1", "16:9", "4:5"]), default="9:16")
@click.option("--audio", type=click.Choice(["keep", "replace"]), default="keep")
@click.option("--seconds", "target_seconds", default=20.0)
@click.option("--clips", "clip_count", default=1)
@click.option("--no-smart-crop", is_flag=True)
@click.option("--subtitle-style", default="tiktok")
@click.option("-o", "--output", required=True, help="Output MP4 (first clip) / prefix")
def render(sources, geometry, mode, aspect, audio, target_seconds, clip_count,
           no_smart_crop, subtitle_style, output):
    """Analyse sources, build an EDL, and render the clip(s) locally (no MinIO)."""
    import tempfile
    from app.models import AspectRatio, AudioMode, EditMode, Geometry
    from app.services import render as renderer
    from app.services import select as selector
    from app.services.analyze import analyze_source

    async def _run():
        analyses = []
        locals_by_idx = list(sources)
        for src in sources:
            click.echo(f"Analysing {src} ...")
            analyses.append(await analyze_source(src, storage_key=src))
        clips = selector.build_clips(analyses, Geometry(geometry),
                                     target_count=clip_count, target_seconds=target_seconds)
        w, h = AspectRatio(aspect).dimensions()
        work = tempfile.mkdtemp(prefix="editor_render_")
        outputs = []
        for i, clip in enumerate(clips):
            out = output if i == 0 else output.rsplit(".", 1)[0] + f"_{i}.mp4"
            click.echo(f"Rendering {clip.title or f'clip {i}'} -> {out}")
            res = renderer.render_clip(
                clip, locals_by_idx, work, out,
                mode=EditMode(mode), audio_mode=AudioMode(audio),
                out_w=w, out_h=h, fps=30, smart_crop=not no_smart_crop,
                subtitle_style=subtitle_style,
            )
            outputs.append(res)
        return outputs

    outputs = asyncio.run(_run())
    for r in outputs:
        q = "ok" if r.quality_ok else f"FLAGGED: {r.quality_reason}"
        # ASCII marker: Windows consoles with cp1251 crash on fancy glyphs.
        click.secho(
            f"[done] {r.output_path} ({r.duration_sec:.1f}s {r.width}x{r.height} "
            f"{r.file_size_bytes // 1024} KB phash={r.phash} quality={q})",
            fg="green" if r.quality_ok else "yellow")


if __name__ == "__main__":
    cli()
