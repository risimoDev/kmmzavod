"""Render engine — turn a (confirmed) EDL clip into a finished MP4.

Self-contained for now (Phase 3a); the shared montage primitives move to
media-core in Phase 3b. Pipeline per clip:

  1. Cut each EDL segment and reframe to the target aspect (cover-crop, with a
     real face-centred horizontal bias when smart_crop is on).
  2. Concatenate the segments (hard cuts — robust; xfade is a later nicety).
  3. Audio:
       • keep    → original segment audio is carried through (+ optional ducked BGM)
       • replace → video-only segments + a shared TTS voiceover (+ ducked BGM)
  4. smart_montage → transcribe the FINAL audio (faster-whisper, RU) and burn
     perfectly-synced subtitles. uniquify_source → no subtitles (uniquify adds its
     own later). Output is loudness-normalised (EBU R128).
  5. Thumbnail + average-hash.
"""

from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass

from app.config import settings
from app.models import AudioMode, EditMode
from app.services import ffmpeg as fx
from app.services.subtitle import SubLine, generate_ass

logger = logging.getLogger(__name__)


def _run(cmd: list[str], label: str) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or "")[-4000:]
        logger.error("[%s] ffmpeg failed (rc=%d)\n%s", label, result.returncode, tail)
        raise subprocess.CalledProcessError(result.returncode, cmd, stderr=result.stderr)


def _even(n: int) -> int:
    return n - (n % 2)


@dataclass
class RenderResult:
    output_path: str
    thumbnail_path: str | None
    duration_sec: float
    width: int
    height: int
    file_size_bytes: int
    phash: str | None
    quality_ok: bool = True
    quality_reason: str = ""


def _face_center_x(src_path: str, t: float) -> float:
    """Detect a face near time ``t`` and return its horizontal centre (0..1)."""
    try:
        import cv2
        cap = cv2.VideoCapture(src_path)
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            return 0.5
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        cascade = cv2.CascadeClassifier(
            os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
        if cascade.empty():
            return 0.5
        faces = cascade.detectMultiScale(gray, 1.2, 5, minSize=(50, 50))
        if len(faces) == 0:
            return 0.5
        # Largest face.
        x, _y, w, _h = max(faces, key=lambda f: f[2] * f[3])
        return min(1.0, max(0.0, (x + w / 2.0) / max(1, frame.shape[1])))
    except Exception:  # noqa: BLE001
        return 0.5


def _reframe_vf(out_w: int, out_h: int, bias_x: float) -> str:
    """Cover-scale to fill the target box, then crop with a horizontal bias."""
    return (
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={out_w}:{out_h}:(in_w-{out_w})*{bias_x:.3f}:(in_h-{out_h})/2,"
        f"format=yuv420p"
    )


def _prepare_segment(src_path: str, start: float, end: float, out_path: str,
                     out_w: int, out_h: int, fps: int, keep_audio: bool,
                     smart_crop: bool, threads: int) -> None:
    bias_x = _face_center_x(src_path, (start + end) / 2.0) if smart_crop else 0.5
    vf = _reframe_vf(out_w, out_h, bias_x) + f",fps={fps}"
    dur = max(0.1, end - start)

    cmd = [fx._bin("ffmpeg"), "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src_path]
    if keep_audio:
        # Reframe video; ensure a stereo audio stream exists (silence if none).
        cmd += [
            "-filter_complex",
            f"[0:v]{vf}[v];"
            f"[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a]",
            "-map", "[v]", "-map", "[a]",
        ]
        # If the source has no audio, the [0:a] reference fails → fallback below.
        probe = fx.probe(src_path)
        if not probe.has_audio:
            cmd = [fx._bin("ffmpeg"), "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}",
                   "-i", src_path,
                   "-f", "lavfi", "-t", f"{dur:.3f}",
                   "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                   "-filter_complex", f"[0:v]{vf}[v]",
                   "-map", "[v]", "-map", "1:a"]
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    else:
        cmd += ["-an", "-vf", vf]

    cmd += [
        "-c:v", "libx264", "-preset", settings.ffmpeg_interim_preset, "-crf", "18",
        "-pix_fmt", "yuv420p", "-threads", str(threads), out_path,
    ]
    _run(cmd, "prepare_segment")


def _concat(parts: list[str], out_path: str, with_audio: bool, threads: int) -> None:
    if len(parts) == 1:
        _run([fx._bin("ffmpeg"), "-y", "-i", parts[0], "-c", "copy", out_path], "concat_copy")
        return
    cmd = [fx._bin("ffmpeg"), "-y"]
    for p in parts:
        cmd += ["-i", p]
    n = len(parts)
    if with_audio:
        streams = "".join(f"[{i}:v][{i}:a]" for i in range(n))
        fc = f"{streams}concat=n={n}:v=1:a=1[v][a]"
        maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "128k"]
    else:
        streams = "".join(f"[{i}:v]" for i in range(n))
        fc = f"{streams}concat=n={n}:v=1:a=0[v]"
        maps = ["-map", "[v]"]
    cmd += ["-filter_complex", fc, *maps,
            "-c:v", "libx264", "-preset", settings.ffmpeg_interim_preset, "-crf", "18",
            "-pix_fmt", "yuv420p", "-threads", str(threads), out_path]
    _run(cmd, "concat")


def _build_voiceover_bed(video_path: str, voiceover_path: str, bgm_path: str | None,
                         out_path: str, threads: int) -> None:
    """Replace audio with voiceover (+ optional side-chain-ducked BGM)."""
    dur = fx.probe(video_path).duration
    inputs = ["-i", video_path, "-i", voiceover_path]
    if bgm_path:
        inputs += ["-i", bgm_path]
    fc = ["[1:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[vo][vosc]"]
    if bgm_path:
        fade = max(0.0, dur - 2.0)
        fc.append(
            f"[2:a]aloop=loop=-1:size=2147483647,aformat=sample_rates=44100:channel_layouts=stereo,"
            f"atrim=duration={dur:.3f},volume=0.16,afade=t=in:st=0:d=1.2,"
            f"afade=t=out:st={fade:.3f}:d=2.0[bg]")
        fc.append("[bg][vosc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[bgd]")
        fc.append("[vo][bgd]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a]")
    else:
        fc.append("[vo]anull[a]")
    cmd = [fx._bin("ffmpeg"), "-y", *inputs, "-filter_complex", ";".join(fc),
           "-map", "0:v", "-map", "[a]", "-c:v", "copy",
           "-c:a", "aac", "-b:a", "128k", "-t", f"{dur:.3f}",
           "-threads", str(threads), out_path]
    _run(cmd, "voiceover_bed")


def _transcribe_for_subs(audio_path: str) -> list[SubLine]:
    """Transcribe the final audio into subtitle lines (output timeline). Optional."""
    try:
        from faster_whisper import WhisperModel
    except Exception:  # noqa: BLE001
        return []
    try:
        model = WhisperModel(settings.whisper_model, device=settings.whisper_device,
                             compute_type=settings.whisper_compute_type)
        segments, _ = model.transcribe(audio_path, language=settings.whisper_language)
        return [SubLine(start=s.start, end=s.end, text=s.text.strip())
                for s in segments if s.text.strip()]
    except Exception as e:  # noqa: BLE001
        logger.warning("subtitle transcription failed: %s", e)
        return []


def _final_encode(video_in: str, out_path: str, out_w: int, out_h: int, fps: int,
                  ass_path: str | None, crf: int, threads: int) -> None:
    vf = f"scale={out_w}:{out_h},fps={fps},format=yuv420p"
    if ass_path:
        vf += f",ass='{fx._safe_filter_path(ass_path)}'"
    cmd = [
        fx._bin("ffmpeg"), "-y", "-i", video_in,
        "-vf", vf, "-af", "loudnorm=I=-16:LRA=11:TP=-1.5",
        "-c:v", "libx264", "-preset", settings.ffmpeg_final_preset, "-crf", str(crf),
        "-profile:v", "high", "-level:v", "4.1",
        "-maxrate", settings.ffmpeg_max_bitrate, "-bufsize", settings.ffmpeg_bufsize,
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", settings.ffmpeg_audio_bitrate,
        "-ar", "44100", "-ac", "2", "-movflags", "+faststart",
        "-threads", str(threads), out_path,
    ]
    _run(cmd, "final_encode")


def render_clip(clip, locals_by_idx: list[str], work_dir: str, output_path: str, *,
                mode: EditMode, audio_mode: AudioMode, out_w: int, out_h: int, fps: int,
                smart_crop: bool, subtitle_style: str,
                voiceover_path: str | None = None, bgm_path: str | None = None,
                crf: int | None = None, threads: int | None = None) -> RenderResult:
    """Render one EDL clip (dict-like with .segments) to ``output_path``."""
    threads = threads if threads is not None else settings.ffmpeg_threads
    crf = crf if crf is not None else settings.ffmpeg_crf
    out_w, out_h = _even(out_w), _even(out_h)
    keep_audio = (audio_mode == AudioMode.KEEP)

    # 1. Prepare segments.
    seg_paths: list[str] = []
    for i, seg in enumerate(clip.segments):
        src = locals_by_idx[seg.src_idx]
        out = os.path.join(work_dir, f"seg_{i:03d}.mp4")
        _prepare_segment(src, seg.start, seg.end, out, out_w, out_h, fps,
                         keep_audio, smart_crop, 1)
        seg_paths.append(out)

    # 2. Concat.
    assembled = os.path.join(work_dir, "assembled.mp4")
    _concat(seg_paths, assembled, with_audio=keep_audio, threads=threads)

    # 3. Audio bed for replace mode.
    pre_final = assembled
    if audio_mode == AudioMode.REPLACE and voiceover_path:
        pre_final = os.path.join(work_dir, "with_voice.mp4")
        _build_voiceover_bed(assembled, voiceover_path, bgm_path, pre_final, threads)
    elif keep_audio and bgm_path:
        # Mix a quiet ducked BGM under the original audio.
        pre_final = os.path.join(work_dir, "with_bgm.mp4")
        dur = fx.probe(assembled).duration
        fade = max(0.0, dur - 2.0)
        fc = (f"[1:a]aloop=loop=-1:size=2147483647,aformat=sample_rates=44100:channel_layouts=stereo,"
              f"atrim=duration={dur:.3f},volume=0.10,afade=t=in:st=0:d=1.2,"
              f"afade=t=out:st={fade:.3f}:d=2.0[bg];"
              f"[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a]")
        _run([fx._bin("ffmpeg"), "-y", "-i", assembled, "-i", bgm_path,
              "-filter_complex", fc, "-map", "0:v", "-map", "[a]",
              "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-t", f"{dur:.3f}",
              "-threads", str(threads), pre_final], "keep_bgm")

    # 4. Subtitles (smart_montage only) + final encode.
    ass_path: str | None = None
    if mode == EditMode.SMART_MONTAGE and subtitle_style and subtitle_style != "none":
        lines = _transcribe_for_subs(pre_final)
        if lines:
            ass_path = os.path.join(work_dir, "subs.ass")
            generate_ass(lines, ass_path, out_w, out_h, subtitle_style)
    _final_encode(pre_final, output_path, out_w, out_h, fps, ass_path, crf, threads)

    # 5. Thumbnail + phash.
    thumb = output_path.rsplit(".", 1)[0] + "_thumb.jpg"
    try:
        fx.extract_frame(output_path, max(0.2, fx.probe(output_path).duration * 0.2), thumb, width=540)
    except Exception:  # noqa: BLE001
        thumb = None
    phash = fx.average_hash(thumb) if thumb else None

    info = fx.probe(output_path)
    quality = fx.check_quality(output_path, info.duration)
    if not quality["ok"]:
        logger.warning("Render quality gate flagged %s: %s", output_path, quality["reason"])
    return RenderResult(
        output_path=output_path, thumbnail_path=thumb,
        duration_sec=round(info.duration, 2), width=out_w, height=out_h,
        file_size_bytes=os.path.getsize(output_path), phash=phash,
        quality_ok=quality["ok"], quality_reason=quality["reason"],
    )
