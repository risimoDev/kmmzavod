#!/usr/bin/env python3
"""
CLI for local / offline use of the video composition pipeline.

Usage examples
──────────────
# Compose a video from a manifest JSON file:
python cli.py compose manifest.json --output final.mp4

# Convert a single image to an animated Ken Burns clip:
python cli.py ken-burns photo.jpg --duration 5 --preset zoom_in --output clip.mp4

# Generate an ASS subtitle file:
python cli.py subtitles subs.json --style tiktok --output subs.ass

# Probe a media file:
python cli.py probe video.mp4

Manifest JSON format (for ``compose`` command):
    {
      "job_id": "local-test-01",
      "tenant_id": "local",
      "output_key": "output/final.mp4",
      "scenes": [
        {
          "scene_id": "s1",
          "type": "image",
          "storage_key": "path/to/image.jpg",
          "duration_sec": 4,
          "transition": "fade",
          "transition_duration": 0.5,
          "ken_burns": "zoom_in"
        },
        ...
      ],
      "subtitles": [
        { "start_sec": 0.0, "end_sec": 2.5, "text": "Добро пожаловать!" }
      ],
      "settings": { "width": 1080, "height": 1920, "fps": 30, "crf": 23 }
    }

In LOCAL mode (no MinIO), ``storage_key`` is treated as a local file path
and the output is written to ``--output`` directly.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import click

# Allow running from repo root without installation
sys.path.insert(0, str(Path(__file__).parent))


# ─────────────────────────────────────────────────────────────────────────────
# Inline local storage (bypasses MinIO for CLI use)
# ─────────────────────────────────────────────────────────────────────────────

class _LocalStorage:
    """StorageClient compatible adapter that uses the local filesystem."""

    async def download(self, key: str, local_path: str) -> None:
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        if key != local_path:
            shutil.copy2(key, local_path)

    async def upload(self, key: str, local_path: str, content_type: str = "") -> None:
        os.makedirs(os.path.dirname(key) or ".", exist_ok=True)
        if key != local_path:
            shutil.copy2(local_path, key)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

@click.group()
def cli() -> None:
    """kmmzavod video-processor — local CLI interface."""


# ── compose ────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("manifest", type=click.Path(exists=True))
@click.option("-o", "--output", required=True, help="Output MP4 file path")
@click.option("--threads", default=0, help="FFmpeg thread count (0 = auto)")
@click.option("--no-cleanup", is_flag=True, help="Keep temp working directory")
def compose(manifest: str, output: str, threads: int, no_cleanup: bool) -> None:
    """
    Compose a video from a JSON manifest file.

    In CLI mode, MinIO keys are treated as local file paths.
    """
    with open(manifest, encoding="utf-8") as f:
        data = json.load(f)

    # Force output key to point to the desired output file
    data["output_key"] = output

    from app.models import ComposeRequest
    req = ComposeRequest(**data)

    work_dir = tempfile.mkdtemp(prefix="kmmzavod_cli_")
    click.echo(f"Working directory: {work_dir}")

    async def _run() -> None:
        from app.services.pipeline import CompositionPipeline, PipelineProgress

        def _cb(p: PipelineProgress) -> None:
            click.echo(
                f"  [{p.step}/{p.total_steps}] {p.stage} — {p.elapsed_sec:.1f}s"
            )

        pipeline = CompositionPipeline(
            request=req,
            work_dir=work_dir,
            storage=_LocalStorage(),  # type: ignore[arg-type]
            threads=threads,
            progress_cb=_cb,
        )
        result = await pipeline.run()
        click.secho(
            f"\n✓ Готово: {result.output_key} "
            f"({result.duration_sec:.1f}s | {result.file_size_bytes // 1024} KB "
            f"| {result.width}x{result.height})",
            fg="green",
        )

    try:
        asyncio.run(_run())
    finally:
        if not no_cleanup:
            shutil.rmtree(work_dir, ignore_errors=True)
        else:
            click.echo(f"Temp dir preserved: {work_dir}")


# ── ken-burns ──────────────────────────────────────────────────────────────

@cli.command("ken-burns")
@click.argument("image", type=click.Path(exists=True))
@click.option("-d", "--duration", default=4.0, help="Duration in seconds")
@click.option(
    "-p", "--preset",
    type=click.Choice(["zoom_in", "zoom_out", "pan_lr", "pan_rl", "pan_tb", "auto"]),
    default="zoom_in",
)
@click.option("--fps", default=30)
@click.option("--width", default=1080)
@click.option("--height", default=1920)
@click.option("--threads", default=0)
@click.option("-o", "--output", required=True, help="Output MP4 file")
def ken_burns(
    image: str,
    duration: float,
    preset: str,
    fps: int,
    width: int,
    height: int,
    threads: int,
    output: str,
) -> None:
    """Convert a single image to a Ken Burns animated clip."""
    from app.services.ffmpeg import image_to_clip
    from app.models import KenBurnsPreset

    click.echo(f"Converting {image} → {output} (preset={preset}, {duration}s)")

    image_to_clip(
        input_path=image,
        output_path=output,
        width=width,
        height=height,
        duration=duration,
        fps=fps,
        preset=KenBurnsPreset(preset),
        scene_index=0,
        threads=threads,
    )
    click.secho(f"✓ {output}", fg="green")


# ── subtitles ──────────────────────────────────────────────────────────────

@cli.command()
@click.argument("subs_json", type=click.Path(exists=True))
@click.option(
    "-s", "--style",
    type=click.Choice(["default", "tiktok", "cinematic", "minimal"]),
    default="tiktok",
)
@click.option("--width", default=1080)
@click.option("--height", default=1920)
@click.option("-o", "--output", required=True, help="Output .ass file")
def subtitles(subs_json: str, style: str, width: int, height: int, output: str) -> None:
    """
    Generate an ASS subtitle file from a JSON array.

    JSON format: [{"start_sec": 0, "end_sec": 2.5, "text": "Hello"}]
    """
    from app.models import SubtitleEntry, SubtitleStyle
    from app.services.subtitle import generate_ass_file

    with open(subs_json, encoding="utf-8") as f:
        raw = json.load(f)

    entries = [SubtitleEntry(**e) for e in raw]
    generate_ass_file(entries, output, width=width, height=height, style=SubtitleStyle(style))
    click.secho(f"✓ {output} ({len(entries)} entries)", fg="green")


# ── probe ──────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("media_file", type=click.Path(exists=True))
def probe(media_file: str) -> None:
    """Print media file metadata (via ffprobe)."""
    from app.services.ffmpeg import probe as _probe

    info = _probe(media_file)
    click.echo(
        f"Duration : {info.duration:.3f}s\n"
        f"Video    : {info.width}x{info.height} @ {info.fps:.2f}fps  (has_video={info.has_video})\n"
        f"Audio    : has_audio={info.has_audio}"
    )


# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cli()
