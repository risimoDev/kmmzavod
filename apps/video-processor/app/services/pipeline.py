"""
CompositionPipeline — orchestrates the full video composition workflow.

Pipeline stages
───────────────
1. Download all scene assets from MinIO (async, parallelised)
2. Prepare scenes:
   • Video/avatar/clip → normalize_video_clip (scale, fps, audio)
   • Image           → image_to_clip (Ken Burns animation)
3. Concatenate clips with xfade transitions → combined.mp4
4. Burn ASS subtitles (if any) → subtitled.mp4
5. Mix optional background music → bgm_mixed.mp4
6. Final H.264 encode with social-media settings → final.mp4
7. Upload final.mp4 to MinIO
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from app.models import (
    ComposeRequest,
    ComposeResponse,
    KenBurnsPreset,
    LayoutComposeRequest,
    LayoutType,
    SceneItem,
    SubtitleEntry,
    SubtitleStyle,
    TransitionType,
)
from app.services import ffmpeg as fx
from app.services.ffmpeg import ClipInfo
from app.services.storage import StorageClient
from app.services.subtitle import generate_ass_file

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Progress reporting (optional callback)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class PipelineProgress:
    stage: str
    step: int
    total_steps: int
    elapsed_sec: float
    detail: str = ""


ProgressCallback = Callable[[PipelineProgress], None]


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline
# ─────────────────────────────────────────────────────────────────────────────

class CompositionPipeline:
    """
    Encapsulates a single video composition job.

    Usage::

        pipeline = CompositionPipeline(
            request=req,
            work_dir="/tmp/job_xyz",
            storage=StorageClient(),
        )
        response = await pipeline.run()
    """

    TOTAL_STAGES = 7

    def __init__(
        self,
        request: ComposeRequest,
        work_dir: str,
        storage: StorageClient,
        threads: int = 0,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> None:
        self.req = request
        self.work_dir = work_dir
        self.storage = storage
        self.threads = threads
        self.progress_cb = progress_cb
        self._start_time = time.monotonic()

    # ── Public entry point ─────────────────────────────────────────────────

    async def run(self) -> ComposeResponse:
        s = self.req.settings

        # Stage 1: Download
        self._progress(1, "Скачиваем ассеты сцен")
        raw_paths = await self._download_scenes()

        # Stage 2: Prepare clips (CPU-bound — run in thread pool)
        self._progress(2, "Готовим клипы (нормализация + Ken Burns)")
        clips = await asyncio.get_event_loop().run_in_executor(
            None, self._prepare_clips, raw_paths
        )

        # Stage 3: Concat with transitions
        self._progress(3, f"Склеиваем {len(clips)} сцен")
        combined = self._path("combined.mp4")
        await asyncio.get_event_loop().run_in_executor(
            None, fx.concat_with_transitions, clips, combined, self.threads
        )

        # Stage 4: Burn subtitles
        current = combined
        if self.req.subtitles:
            self._progress(4, "Сжигаем субтитры")
            ass_path = self._path("subs.ass")
            subtitled = self._path("subtitled.mp4")
            generate_ass_file(
                self.req.subtitles,
                ass_path,
                width=s.width,
                height=s.height,
                style=s.subtitle_style,
            )
            await asyncio.get_event_loop().run_in_executor(
                None, fx.burn_subtitles, current, ass_path, subtitled, self.threads
            )
            current = subtitled
        else:
            self._progress(4, "Субтитров нет, пропускаем")

        # Stage 5: Mix BGM
        if self.req.audio_track:
            self._progress(5, "Микшируем фоновую музыку")
            bgm_local = self._path("bgm_source")
            await self.storage.download(self.req.audio_track.storage_key, bgm_local)
            bgm_mixed = self._path("bgm_mixed.mp4")
            at = self.req.audio_track
            await asyncio.get_event_loop().run_in_executor(
                None,
                fx.mix_bgm,
                current,
                bgm_local,
                bgm_mixed,
                at.volume,
                at.fade_in_sec,
                at.fade_out_sec,
                self.threads,
            )
            current = bgm_mixed
        else:
            self._progress(5, "Фоновой музыки нет, пропускаем")

        # Stage 6: Final encode
        self._progress(6, "Финальная кодировка (H.264, social-media)")
        final = self._path("final.mp4")
        await asyncio.get_event_loop().run_in_executor(
            None,
            fx.final_encode,
            current,
            final,
            s.width,
            s.height,
            s.fps,
            s.crf,
            s.preset,
            s.audio_bitrate,
            s.max_bitrate,
            s.bufsize,
            self.threads,
        )

        # Stage 7: Upload
        self._progress(7, f"Загружаем результат → {self.req.output_key}")
        await self.storage.upload(self.req.output_key, final, "video/mp4")

        info = fx.probe(final)
        file_size = os.path.getsize(final)

        logger.info(
            "Job %s завершён за %.1f с | %dx%d | %.1f с | %d KB",
            self.req.job_id,
            time.monotonic() - self._start_time,
            info.width,
            info.height,
            info.duration,
            file_size // 1024,
        )

        return ComposeResponse(
            output_key=self.req.output_key,
            duration_sec=round(info.duration, 2),
            file_size_bytes=file_size,
            width=info.width,
            height=info.height,
            scene_count=len(self.req.scenes),
        )

    # ── Stage implementations ──────────────────────────────────────────────

    async def _download_scenes(self) -> list[tuple[SceneItem, str]]:
        """Download all scene assets concurrently. Returns (scene, local_path) pairs."""
        tasks = []
        for i, scene in enumerate(self.req.scenes):
            ext = _scene_extension(scene.type)
            local_path = self._path(f"raw_{i:03d}{ext}")
            tasks.append(self._download_one(scene, local_path))
        results = await asyncio.gather(*tasks)
        return list(results)

    async def _download_one(self, scene: SceneItem, local_path: str) -> tuple[SceneItem, str]:
        await self.storage.download(scene.storage_key, local_path)
        logger.debug("Downloaded scene %s → %s", scene.scene_id, local_path)
        return scene, local_path

    def _prepare_clips(self, raw: list[tuple[SceneItem, str]]) -> list[ClipInfo]:
        """
        Convert each raw asset to a normalised intermediate clip.
        All clips will have: same resolution, same fps, yuv420p, stereo AAC audio.
        Runs synchronously (called via run_in_executor).
        """
        s = self.req.settings
        clips: list[ClipInfo] = []

        for i, (scene, src_path) in enumerate(raw):
            out_path = self._path(f"clip_{i:03d}.mp4")

            if scene.type == "image":
                fx.image_to_clip(
                    input_path=src_path,
                    output_path=out_path,
                    width=s.width,
                    height=s.height,
                    duration=scene.duration_sec,
                    fps=s.fps,
                    preset=scene.ken_burns,
                    scene_index=i,
                    threads=self.threads,
                )
            else:
                # avatar, clip, text
                info = fx.probe(src_path)
                # For avatar scenes: use actual source duration so voice is never cut
                # For clip scenes: trim to requested duration
                if scene.type == "avatar" and info.duration > 0:
                    duration = info.duration
                else:
                    duration = min(scene.duration_sec, info.duration) if info.duration > 0 else scene.duration_sec
                fx.normalize_video_clip(
                    input_path=src_path,
                    output_path=out_path,
                    width=s.width,
                    height=s.height,
                    fps=s.fps,
                    duration=duration,
                    threads=self.threads,
                )

            clip_info = fx.probe(out_path)
            clips.append(
                ClipInfo(
                    path=out_path,
                    duration=clip_info.duration,
                    has_audio=clip_info.has_audio,
                    transition=scene.transition,
                    transition_duration=scene.transition_duration,
                )
            )
            logger.debug(
                "Prepared clip %d/%d: scene_id=%s type=%s duration=%.2f",
                i + 1, len(raw), scene.scene_id, scene.type, clip_info.duration,
            )

        return clips

    # ── Internal helpers ───────────────────────────────────────────────────

    def _path(self, filename: str) -> str:
        return os.path.join(self.work_dir, filename)

    def _progress(self, step: int, detail: str) -> None:
        elapsed = time.monotonic() - self._start_time
        logger.info(
            "[Job %s] Stage %d/%d — %s (%.1fs elapsed)",
            self.req.job_id, step, self.TOTAL_STAGES, detail, elapsed,
        )
        if self.progress_cb:
            self.progress_cb(
                PipelineProgress(
                    stage=detail,
                    step=step,
                    total_steps=self.TOTAL_STAGES,
                    elapsed_sec=elapsed,
                    detail=detail,
                )
            )


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _scene_extension(scene_type: str) -> str:
    if scene_type == "image":
        return ".jpg"       # accept png/jpg; ffmpeg probes format automatically
    return ".mp4"


# ─────────────────────────────────────────────────────────────────────────────
# Layout Composition Pipeline
# ─────────────────────────────────────────────────────────────────────────────

class LayoutCompositionPipeline:
    """
    Compose a single chroma-keyed avatar video with background assets
    according to a layout template that defines segment-by-segment
    avatar positioning (fullscreen, PIP corners, voiceover).

    Pipeline stages:
    1. Download avatar + background assets (async, parallelised)
    2. Probe avatar duration → compute segment timings
    3. Prepare background clips (normalise video / Ken Burns image)
    4. Compose each segment (chroma-key avatar overlaid on background)
    5. Concatenate segment clips with transitions
    6. Burn subtitles (if any)
    7. Mix BGM (if any)
    8. Final H.264 encode
    9. Upload to storage
    """

    TOTAL_STAGES = 9

    def __init__(
        self,
        request: LayoutComposeRequest,
        work_dir: str,
        storage: StorageClient,
        threads: int = 0,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> None:
        self.req = request
        self.work_dir = work_dir
        self.storage = storage
        self.threads = threads
        self.progress_cb = progress_cb
        self._start_time = time.monotonic()

    async def run(self) -> ComposeResponse:
        s = self.req.settings

        # ── Stage 1: Download assets ───────────────────────────────────────
        self._progress(1, "Скачиваем аватар и фоны")
        avatar_local = self._path("avatar_raw.mp4")
        await self.storage.download(self.req.avatar_storage_key, avatar_local)

        bg_locals: list[str] = []
        tasks = []
        for i, bg in enumerate(self.req.backgrounds):
            ext = ".jpg" if bg.type == "image" else ".mp4"
            local = self._path(f"bg_raw_{i:02d}{ext}")
            bg_locals.append(local)
            tasks.append(self.storage.download(bg.storage_key, local))
        await asyncio.gather(*tasks)

        # ── Stage 2: Compute segment timings ───────────────────────────────
        self._progress(2, "Рассчитываем тайминги сегментов")
        avatar_info = fx.probe(avatar_local)
        total_duration = avatar_info.duration

        total_weight = sum(seg.weight for seg in self.req.segments)
        seg_timings: list[tuple[float, float]] = []  # (start_sec, duration)
        cursor = 0.0
        for seg in self.req.segments:
            dur = total_duration * (seg.weight / total_weight)
            seg_timings.append((cursor, dur))
            cursor += dur

        logger.info(
            "Avatar duration=%.1fs, %d segments, weights normalised",
            total_duration, len(self.req.segments),
        )

        # ── Stage 3: Prepare background clips ─────────────────────────────
        self._progress(3, "Готовим фоновые клипы")
        bg_prepared: dict[tuple[int, int], str] = {}  # (bg_index, seg_idx) → path

        def _prepare_bg(seg_idx: int) -> str:
            seg = self.req.segments[seg_idx]
            _, dur = seg_timings[seg_idx]
            bg_asset = self.req.backgrounds[seg.bg_index]
            raw_path = bg_locals[seg.bg_index]

            out_path = self._path(f"bg_prep_{seg_idx:02d}.mp4")

            if bg_asset.type == "image":
                kb = KenBurnsPreset.AUTO
                fx.image_to_clip(
                    input_path=raw_path,
                    output_path=out_path,
                    width=s.width, height=s.height,
                    duration=dur, fps=s.fps,
                    preset=kb, scene_index=seg_idx,
                    threads=self.threads,
                )
            else:
                fx.normalize_video_clip(
                    input_path=raw_path,
                    output_path=out_path,
                    width=s.width, height=s.height,
                    fps=s.fps, duration=dur,
                    threads=self.threads,
                )
            return out_path

        bg_prepared_list = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: [_prepare_bg(i) for i in range(len(self.req.segments))],
        )

        # ── Stage 4: Compose each segment ─────────────────────────────────
        self._progress(4, f"Композитим {len(self.req.segments)} сегментов")

        chroma_hex = self.req.chroma_color.lstrip("#")
        chroma_ffmpeg = f"0x{chroma_hex}"

        def _compose_all() -> list[ClipInfo]:
            clips: list[ClipInfo] = []
            for i, seg in enumerate(self.req.segments):
                start, dur = seg_timings[i]
                out = self._path(f"seg_{i:02d}.mp4")

                fx.compose_layout_segment(
                    avatar_path=avatar_local,
                    bg_clip_path=bg_prepared_list[i],
                    output_path=out,
                    start_sec=start,
                    duration=dur,
                    layout=seg.layout.value,
                    width=s.width, height=s.height,
                    pip_scale=self.req.pip_scale,
                    pip_margin=self.req.pip_margin,
                    chroma_color=chroma_ffmpeg,
                    threads=self.threads,
                )
                ci = fx.probe(out)
                clips.append(ClipInfo(
                    path=out,
                    duration=ci.duration,
                    has_audio=ci.has_audio,
                    transition=self.req.transition,
                    transition_duration=self.req.transition_duration,
                ))
                logger.debug(
                    "Segment %d/%d: layout=%s dur=%.2f",
                    i + 1, len(self.req.segments), seg.layout.value, ci.duration,
                )
            return clips

        clips = await asyncio.get_event_loop().run_in_executor(None, _compose_all)

        # ── Stage 5: Concatenate segments ──────────────────────────────────
        self._progress(5, f"Склеиваем {len(clips)} сегментов")
        combined = self._path("combined.mp4")
        await asyncio.get_event_loop().run_in_executor(
            None, fx.concat_with_transitions, clips, combined, self.threads,
        )

        # Adjust subtitle timings for xfade overlap.
        # xfade transitions shorten the video: each transition_duration between
        # segments consumes time from both clips. We need to shift subtitle
        # timestamps so they stay aligned with the shorter output.
        if self.req.subtitles and len(clips) > 1:
            # Build a map: at each segment boundary in the original avatar timeline,
            # the cumulative transition overlap increases.
            seg_boundaries: list[tuple[float, float]] = []  # (avatar_time, overlap_so_far)
            cum_avatar = 0.0
            cum_overlap = 0.0
            for i, clip in enumerate(clips):
                cum_avatar += clip.duration
                if i < len(clips) - 1:
                    td = clip.transition_duration
                    if clip.transition != TransitionType.CUT and td > 0:
                        cum_overlap += td
                seg_boundaries.append((cum_avatar, cum_overlap))

            if cum_overlap > 0:
                def _adjust_time(t: float) -> float:
                    """Shift a subtitle timestamp to account for transition overlap."""
                    overlap = 0.0
                    for boundary_time, boundary_overlap in seg_boundaries:
                        if t <= boundary_time:
                            # Interpolate overlap within this segment
                            overlap = boundary_overlap
                            break
                        overlap = boundary_overlap
                    return max(0.0, t - overlap)

                adjusted_subs = []
                for sub in self.req.subtitles:
                    adjusted_subs.append(SubtitleEntry(
                        start_sec=round(_adjust_time(sub.start_sec), 2),
                        end_sec=round(_adjust_time(sub.end_sec), 2),
                        text=sub.text,
                    ))
                self.req.subtitles = adjusted_subs
                logger.info(
                    "Adjusted %d subtitle timings for %.2fs total xfade overlap",
                    len(adjusted_subs), cum_overlap,
                )

        # ── Stage 6: Burn subtitles ───────────────────────────────────────
        current = combined
        if self.req.subtitles:
            self._progress(6, "Сжигаем субтитры")
            ass_path = self._path("subs.ass")
            subtitled = self._path("subtitled.mp4")
            generate_ass_file(
                self.req.subtitles, ass_path,
                width=s.width, height=s.height,
                style=s.subtitle_style,
            )
            await asyncio.get_event_loop().run_in_executor(
                None, fx.burn_subtitles, current, ass_path, subtitled, self.threads,
            )
            current = subtitled
        else:
            self._progress(6, "Субтитров нет, пропускаем")

        # ── Stage 7: Mix BGM ──────────────────────────────────────────────
        if self.req.audio_track:
            self._progress(7, "Микшируем фоновую музыку")
            bgm_local = self._path("bgm_source")
            await self.storage.download(self.req.audio_track.storage_key, bgm_local)
            bgm_mixed = self._path("bgm_mixed.mp4")
            at = self.req.audio_track
            await asyncio.get_event_loop().run_in_executor(
                None, fx.mix_bgm,
                current, bgm_local, bgm_mixed,
                at.volume, at.fade_in_sec, at.fade_out_sec,
                self.threads,
            )
            current = bgm_mixed
        else:
            self._progress(7, "Фоновой музыки нет, пропускаем")

        # ── Stage 8: Final encode ─────────────────────────────────────────
        self._progress(8, "Финальная кодировка (H.264)")
        final = self._path("final.mp4")
        await asyncio.get_event_loop().run_in_executor(
            None, fx.final_encode,
            current, final,
            s.width, s.height, s.fps,
            s.crf, s.preset, s.audio_bitrate,
            s.max_bitrate, s.bufsize,
            self.threads,
        )

        # ── Stage 9: Upload ───────────────────────────────────────────────
        self._progress(9, f"Загружаем → {self.req.output_key}")
        await self.storage.upload(self.req.output_key, final, "video/mp4")

        info = fx.probe(final)
        file_size = os.path.getsize(final)

        logger.info(
            "Layout job %s done in %.1fs | %dx%d | %.1fs | %d KB",
            self.req.job_id,
            time.monotonic() - self._start_time,
            info.width, info.height,
            info.duration, file_size // 1024,
        )

        return ComposeResponse(
            output_key=self.req.output_key,
            duration_sec=round(info.duration, 2),
            file_size_bytes=file_size,
            width=info.width,
            height=info.height,
            scene_count=len(self.req.segments),
        )

    # ── Internal helpers ───────────────────────────────────────────────────

    def _path(self, filename: str) -> str:
        return os.path.join(self.work_dir, filename)

    def _progress(self, step: int, detail: str) -> None:
        elapsed = time.monotonic() - self._start_time
        logger.info(
            "[LayoutJob %s] Stage %d/%d — %s (%.1fs)",
            self.req.job_id, step, self.TOTAL_STAGES, detail, elapsed,
        )
        if self.progress_cb:
            self.progress_cb(PipelineProgress(
                stage=detail, step=step,
                total_steps=self.TOTAL_STAGES,
                elapsed_sec=elapsed, detail=detail,
            ))
