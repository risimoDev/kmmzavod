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
from app.services.subtitle import SubLine, SubWord, generate_ass

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


def _face_track(src_path: str, start: float, end: float,
                samples: int = 6) -> list[tuple[float, float]]:
    """Sample the largest face across the segment → EMA-smoothed keyframes of
    (t_rel_sec, bias_x 0..1). One capture, N seeks. Gaps are filled from the
    nearest detection so the crop holds position while the face is hidden."""
    dur = max(0.1, end - start)
    try:
        import cv2
        cascade = cv2.CascadeClassifier(
            os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
        cap = cv2.VideoCapture(src_path)
        if cascade.empty() or not cap.isOpened():
            return [(0.0, 0.5)]
        times = [start + dur * (i + 0.5) / samples for i in range(samples)]
        raw: list[float | None] = []
        for t in times:
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
            ok, frame = cap.read()
            if not ok:
                raw.append(None)
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(gray, 1.2, 5, minSize=(50, 50))
            if len(faces) == 0:
                raw.append(None)
                continue
            x, _y, w, _h = max(faces, key=lambda f: f[2] * f[3])
            raw.append(min(1.0, max(0.0, (x + w / 2.0) / max(1, frame.shape[1]))))
        cap.release()
        if all(v is None for v in raw):
            return [(0.0, 0.5)]
        # Fill gaps from the nearest detection, then EMA-smooth.
        known = [(i, v) for i, v in enumerate(raw) if v is not None]
        filled = [v if v is not None
                  else min(known, key=lambda kv: abs(kv[0] - i))[1]
                  for i, v in enumerate(raw)]
        smoothed: list[float] = []
        for v in filled:
            smoothed.append(v if not smoothed else 0.6 * smoothed[-1] + 0.4 * v)
        track = [(round(t - start, 3), round(b, 3)) for t, b in zip(times, smoothed)]
        # Static shot → collapse to one keyframe (cheap constant crop).
        if max(b for _t, b in track) - min(b for _t, b in track) < 0.04:
            return [(0.0, track[len(track) // 2][1])]
        return track
    except Exception:  # noqa: BLE001
        return [(0.0, 0.5)]


def _bias_expr(track: list[tuple[float, float]]) -> str:
    """Piecewise-linear ffmpeg expression bias(t) through the track keyframes
    (constant before the first and after the last)."""
    if len(track) == 1:
        return f"{track[0][1]:.3f}"
    expr = f"{track[-1][1]:.3f}"
    for (t0, b0), (t1, b1) in reversed(list(zip(track, track[1:]))):
        seg = f"({b0:.3f}+({b1:.3f}-{b0:.3f})*(t-{t0:.3f})/{max(t1 - t0, 0.01):.3f})"
        expr = f"if(lt(t\\,{t1:.3f})\\,{seg}\\,{expr})"
    return f"if(lt(t\\,{track[0][0]:.3f})\\,{track[0][1]:.3f}\\,{expr})"


def _reframe_vf(out_w: int, out_h: int, track: list[tuple[float, float]]) -> str:
    """Cover-scale to fill the target box, then crop along the (possibly moving)
    horizontal bias path — the crop follows the tracked face."""
    return (
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={out_w}:{out_h}:x=(in_w-{out_w})*{_bias_expr(track)}:y=(in_h-{out_h})/2,"
        f"format=yuv420p"
    )


def _prepare_segment(src_path: str, start: float, end: float, out_path: str,
                     out_w: int, out_h: int, fps: int, keep_audio: bool,
                     smart_crop: bool, threads: int) -> None:
    track = _face_track(src_path, start, end) if smart_crop else [(0.0, 0.5)]
    vf = _reframe_vf(out_w, out_h, track) + f",fps={fps}"
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


TRANSITIONS = ["fade", "dissolve", "smoothleft", "smoothright", "slideup", "wipeleft", "circleopen"]


def _concat(parts: list[str], out_path: str, with_audio: bool, threads: int,
            transitions: bool = True, tdur: float = 0.35, seed: int = 0) -> None:
    """Concatenate prepared segments. With ``transitions`` (default) each cut uses
    an xfade video transition (+ acrossfade audio) so the result reads as an edited
    montage rather than plain hard cuts. Falls back to a hard concat if disabled."""
    import random as _random
    n = len(parts)
    if n == 1:
        _run([fx._bin("ffmpeg"), "-y", "-i", parts[0], "-c", "copy", out_path], "concat_copy")
        return

    cmd = [fx._bin("ffmpeg"), "-y"]
    for p in parts:
        cmd += ["-i", p]

    if not transitions:
        if with_audio:
            streams = "".join(f"[{i}:v][{i}:a]" for i in range(n))
            fc = f"{streams}concat=n={n}:v=1:a=1[vout][aout]"
            maps = ["-map", "[vout]", "-map", "[aout]", "-c:a", "aac", "-b:a", "128k"]
        else:
            streams = "".join(f"[{i}:v]" for i in range(n))
            fc = f"{streams}concat=n={n}:v=1:a=0[vout]"
            maps = ["-map", "[vout]"]
        cmd += ["-filter_complex", fc, *maps,
                "-c:v", "libx264", "-preset", settings.ffmpeg_interim_preset, "-crf", "18",
                "-pix_fmt", "yuv420p", "-threads", str(threads), out_path]
        _run(cmd, "concat")
        return

    rng = _random.Random(seed)
    durs = [max(0.1, fx.probe(p).duration) for p in parts]
    fc_parts: list[str] = []

    # ── Video xfade chain: offset[i] = Σdur[0..i] − Σtd[1..i] ──
    v_prev = "[0:v]"
    cum = durs[0]
    cumt = 0.0
    tds: list[float] = []
    for i in range(1, n):
        td = min(tdur, durs[i - 1] * 0.5, durs[i] * 0.5)
        td = max(0.1, round(td, 3))
        tds.append(td)
        cumt += td
        offset = max(cum - cumt, 0.05)
        tr = rng.choice(TRANSITIONS)
        v_next = "[vout]" if i == n - 1 else f"[v{i}]"
        fc_parts.append(
            f"{v_prev}[{i}:v]xfade=transition={tr}:duration={td:.3f}:offset={offset:.3f}{v_next}")
        cum += durs[i]
        v_prev = v_next
    total = cum - cumt

    if with_audio:
        a_prev = "[0:a]"
        for i in range(1, n):
            a_next = "[aout]" if i == n - 1 else f"[a{i}]"
            fc_parts.append(f"{a_prev}[{i}:a]acrossfade=d={tds[i - 1]:.3f}:c1=tri:c2=tri{a_next}")
            a_prev = a_next
        maps = ["-map", "[vout]", "-map", "[aout]", "-c:a", "aac", "-b:a", "128k"]
    else:
        maps = ["-map", "[vout]"]

    cmd += ["-filter_complex", ";".join(fc_parts), *maps,
            "-c:v", "libx264", "-preset", settings.ffmpeg_interim_preset, "-crf", "18",
            "-pix_fmt", "yuv420p", "-t", f"{total:.3f}", "-threads", str(threads), out_path]
    _run(cmd, "concat_transitions")


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


def _lines_from_clip(clip) -> list[SubLine]:
    """Build subtitle lines from the clip's (possibly user-edited) EDL subtitles.
    Lines without word timings (typed by the user) get evenly-spread word timings
    so the karaoke highlight still works."""
    raw = getattr(clip, "subtitles", None) or []
    lines: list[SubLine] = []
    for ln in raw:
        get = (lambda o, k, d=None: getattr(o, k, o.get(k, d) if isinstance(o, dict) else d))
        start, end = float(get(ln, "start", 0.0)), float(get(ln, "end", 0.0))
        text = str(get(ln, "text", "") or "").strip()
        if not text or end <= start:
            continue
        words_raw = get(ln, "words", None) or []
        words = [
            SubWord(start=float(get(w, "start", 0.0)), end=float(get(w, "end", 0.0)),
                    text=str(get(w, "text", "")).strip())
            for w in words_raw if str(get(w, "text", "")).strip()
        ]
        if not words:
            tokens = text.split()
            step = (end - start) / max(1, len(tokens))
            words = [SubWord(start=round(start + i * step, 2),
                             end=round(start + (i + 1) * step, 2), text=t)
                     for i, t in enumerate(tokens)]
        lines.append(SubLine(start=start, end=end, text=text, words=words))
    return lines


def _transcribe_for_subs(audio_path: str) -> list[SubLine]:
    """Transcribe the final audio into subtitle lines with word timestamps
    (output timeline) — enables karaoke-style word highlighting. Optional."""
    try:
        from app.services.stt import get_model
        model = get_model()
    except Exception as e:  # noqa: BLE001
        logger.warning("subtitle transcription unavailable: %s", e)
        return []
    try:
        segments, _ = model.transcribe(audio_path, language=settings.whisper_language,
                                       word_timestamps=True, vad_filter=True)
        return [
            SubLine(
                start=s.start, end=s.end, text=s.text.strip(),
                words=[SubWord(start=w.start, end=w.end, text=w.word.strip())
                       for w in (s.words or []) if w.word.strip()],
            )
            for s in segments if s.text.strip()
        ]
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

    # 2. Concat with transitions (montage feel). Seed varies transitions per clip.
    assembled = os.path.join(work_dir, "assembled.mp4")
    seed = abs(hash((clip.title, len(clip.segments)))) % 100000
    _concat(seg_paths, assembled, with_audio=keep_audio, threads=threads, seed=seed)

    # 3. Audio bed for replace mode.
    pre_final = assembled
    if audio_mode == AudioMode.REPLACE and voiceover_path:
        pre_final = os.path.join(work_dir, "with_voice.mp4")
        _build_voiceover_bed(assembled, voiceover_path, bgm_path, pre_final, threads)
    elif keep_audio and bgm_path:
        # BGM under the original audio, side-chain-ducked by the speech so the
        # music breathes: quiet under voice, fuller in the gaps.
        pre_final = os.path.join(work_dir, "with_bgm.mp4")
        dur = fx.probe(assembled).duration
        fade = max(0.0, dur - 2.0)
        fc = (f"[0:a]asplit=2[orig][sc];"
              f"[1:a]aloop=loop=-1:size=2147483647,aformat=sample_rates=44100:channel_layouts=stereo,"
              f"atrim=duration={dur:.3f},volume=0.14,afade=t=in:st=0:d=1.2,"
              f"afade=t=out:st={fade:.3f}:d=2.0[bg];"
              f"[bg][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[bgd];"
              f"[orig][bgd]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a]")
        _run([fx._bin("ffmpeg"), "-y", "-i", assembled, "-i", bgm_path,
              "-filter_complex", fc, "-map", "0:v", "-map", "[a]",
              "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-t", f"{dur:.3f}",
              "-threads", str(threads), pre_final], "keep_bgm")

    # 4. Subtitles: burn whenever a style is chosen (user's explicit choice),
    #    independent of mode. EDL subtitles (proposed at analyze, possibly edited
    #    by the user) win; otherwise transcribe the FINAL audio.
    ass_path: str | None = None
    if subtitle_style and subtitle_style != "none":
        lines = _lines_from_clip(clip) or _transcribe_for_subs(pre_final)
        if lines:
            ass_path = os.path.join(work_dir, "subs.ass")
            generate_ass(lines, ass_path, out_w, out_h, subtitle_style)
            logger.info("Subtitles: burned %d lines (style=%s)", len(lines), subtitle_style)
        else:
            logger.warning("Subtitles requested (style=%s) but transcription produced no lines "
                           "(no speech / Whisper unavailable)", subtitle_style)
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
