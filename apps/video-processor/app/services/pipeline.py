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
    CutType,
    KenBurnsPreset,
    LayoutComposeRequest,
    LayoutType,
    SceneItem,
    SubtitleEntry,
    SubtitleStyle,
    TransitionType,
)
from app.services import ffmpeg as fx
from app.services.ffmpeg import ClipInfo, select_transition_for_pair
from app.services.beat_detect import (
    BeatInfo,
    compute_beat_aligned_segment_weights,
    detect_beats,
    snap_to_beat,
)
from app.services.quality_gate import run_quality_gate
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

    TOTAL_STAGES = 10

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
        self._beat_info: Optional[BeatInfo] = None

    # ── Public entry point ─────────────────────────────────────────────────

    async def run(self) -> ComposeResponse:
        s = self.req.settings

        # Stage 1: Download
        self._progress(1, "Скачиваем ассеты сцен")
        raw_paths = await self._download_scenes()

        # Stage 2: Quality gate
        if not self.req.skip_quality_gate:
            self._progress(2, "Проверяем качество клипов")
            qa_clips = [
                (path, "image" if scene.type == "image" else "video", i)
                for i, (scene, path) in enumerate(raw_paths)
            ]
            report = await asyncio.get_event_loop().run_in_executor(
                None, run_quality_gate, qa_clips,
            )
            if not report.passed:
                critical = [i for i in report.issues if i.severity == "critical"]
                logger.warning(
                    "Quality gate FAILED for job %s: %d critical issues — proceeding anyway (logged only)",
                    self.req.job_id, len(critical),
                )
        else:
            self._progress(2, "Quality gate пропущен")

        # Stage 3: Prepare clips (CPU-bound — run in thread pool)
        self._progress(3, "Готовим клипы (нормализация + Ken Burns)")
        clips = await asyncio.get_event_loop().run_in_executor(
            None, self._prepare_clips, raw_paths
        )

        # Stage 3.5: Beat detection for transition sync
        beat_times: list[float] = []
        if self.req.beat_sync and self.req.beat_sync.enabled and self.req.audio_track:
            self._progress(4, "Анализируем ритм BGM")
            bgm_local = self._path("bgm_source")
            await self.storage.download(self.req.audio_track.storage_key, bgm_local)
            self._beat_info = await asyncio.get_event_loop().run_in_executor(
                None, detect_beats, bgm_local,
            )
            if self.req.beat_sync.use_onsets:
                beat_times = self._beat_info.onset_timestamps
            else:
                beat_times = self._beat_info.timestamps
            logger.info(
                "Beat sync: %d beats at %.1f BPM for job %s",
                len(beat_times), self._beat_info.bpm, self.req.job_id,
            )
        else:
            self._progress(4, "Beat sync отключён")

        # Stage 4: Concat with transitions (beat-synced + L/J-cut if needed)
        self._progress(5, f"Склеиваем {len(clips)} сцен")
        combined = self._path("combined.mp4")

        if beat_times:
            adjusted_clips = self._beat_align_clips(clips, beat_times)
        else:
            adjusted_clips = clips

        # Use L/J-cut concat if any clip has non-hard cut type
        has_lj_cuts = any(c.cut_type != CutType.HARD for c in adjusted_clips)
        if has_lj_cuts:
            await asyncio.get_event_loop().run_in_executor(
                None, fx.concat_with_lj_cuts, adjusted_clips, combined, self.threads,
            )
        else:
            await asyncio.get_event_loop().run_in_executor(
                None, fx.concat_with_transitions, adjusted_clips, combined, self.threads,
            )

        # Stage 4.5: Color grading (if enabled and multiple clips)
        current = combined
        cg_config = self.req.color_grading
        if cg_config and cg_config.enabled and len(clips) > 1:
            self._progress(6, "Цветокоррекция сегментов")
            graded = self._path("color_graded.mp4")
            await asyncio.get_event_loop().run_in_executor(
                None,
                fx.color_grade_clip,
                current, graded,
                None,
                cg_config.strength,
                0.0, 1.0, 1.0,
                self.threads,
            )
            current = graded
        else:
            self._progress(6, "Цветокоррекция пропущена")

        # Adjust subtitle timings for actual clip durations + xfade overlap.
        # This is the authoritative timing adjustment — the orchestrator sends
        # RAW (unadjusted) subtitles and the Python pipeline fixes them.
        if self.req.subtitles and len(adjusted_clips) > 1:
            seg_boundaries: list[tuple[float, float]] = []
            cum_time = 0.0
            cum_overlap = 0.0
            for i, clip in enumerate(adjusted_clips):
                cum_time += clip.duration
                if i < len(adjusted_clips) - 1:
                    td = clip.transition_duration
                    if clip.transition != TransitionType.CUT and td > 0:
                        cum_overlap += td
                seg_boundaries.append((cum_time, cum_overlap))

            if cum_overlap > 0 or beat_times:
                def _adjust_sub_time(t: float) -> float:
                    overlap = 0.0
                    for boundary_time, boundary_overlap in seg_boundaries:
                        if t <= boundary_time:
                            overlap = boundary_overlap
                            break
                        overlap = boundary_overlap
                    return max(0.0, t - overlap)

                self.req.subtitles = [
                    SubtitleEntry(
                        start_sec=round(_adjust_sub_time(sub.start_sec), 2),
                        end_sec=round(_adjust_sub_time(sub.end_sec), 2),
                        text=sub.text,
                    )
                    for sub in self.req.subtitles
                ]
                logger.info(
                    "Adjusted %d subtitles for %.2fs xfade overlap (CompositionPipeline)",
                    len(self.req.subtitles), cum_overlap,
                )

        # Stage 5: Burn subtitles
        if self.req.subtitles:
            self._progress(7, "Сжигаем субтитры")
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
            self._progress(7, "Субтитров нет, пропускаем")

        # Stage 6: Mix BGM (with ducking if duck_zones provided)
        if self.req.audio_track:
            self._progress(8, "Микшируем фоновую музыку")
            bgm_local = self._path("bgm_source")
            if not os.path.exists(bgm_local):
                await self.storage.download(self.req.audio_track.storage_key, bgm_local)
            bgm_mixed = self._path("bgm_mixed.mp4")
            at = self.req.audio_track

            duck_zones = None
            if at.duck_zones:
                duck_zones = [(z.start_sec, z.end_sec) for z in at.duck_zones]

            await asyncio.get_event_loop().run_in_executor(
                None,
                fx.mix_bgm_ducking,
                current,
                bgm_local,
                bgm_mixed,
                at.volume,
                at.duck_zones[0].duck_volume if at.duck_zones else 0.04,
                duck_zones,
                at.duck_fade_ms,
                at.fade_in_sec,
                at.fade_out_sec,
                self.threads,
            )
            current = bgm_mixed
        else:
            self._progress(8, "Фоновой музыки нет, пропускаем")

        # Stage 7: Final encode
        self._progress(9, "Финальная кодировка (H.264, social-media)")
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

        # Stage 8: Upload
        self._progress(10, f"Загружаем результат → {self.req.output_key}")
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
        Also applies speed ramping and content-aware transitions.
        Runs synchronously (called via run_in_executor).
        """
        s = self.req.settings
        clips: list[ClipInfo] = []

        cat_config = self.req.content_aware_transitions

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
                info = fx.probe(src_path)
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

            # Apply speed ramping if scene has non-1.0 speed
            if abs(scene.speed - 1.0) > 0.01:
                ramped_path = self._path(f"clip_{i:03d}_ramped.mp4")
                new_dur = fx.apply_speed_ramp(
                    input_path=out_path,
                    output_path=ramped_path,
                    speed=scene.speed,
                    threads=self.threads,
                )
                out_path = ramped_path
            else:
                new_dur = None

            # Content-aware transition selection
            transition = scene.transition
            transition_duration = scene.transition_duration

            if cat_config and cat_config.enabled and i > 0:
                prev_scene = raw[i - 1][0]
                pair_key = f"{prev_scene.type}->{scene.type}"
                if pair_key in (cat_config.rules or {}):
                    selected_tr, selected_dur = select_transition_for_pair(
                        prev_scene.type, scene.type,
                        rules=cat_config.rules,
                    )
                    transition = TransitionType(selected_tr)
                    if selected_dur > 0:
                        transition_duration = selected_dur

            clip_info = fx.probe(out_path)
            clips.append(
                ClipInfo(
                    path=out_path,
                    duration=new_dur or clip_info.duration,
                    has_audio=clip_info.has_audio,
                    transition=transition,
                    transition_duration=transition_duration,
                    cut_type=scene.cut_type,
                    audio_offset_sec=scene.audio_offset_sec,
                    speed=scene.speed,
                )
            )
            logger.debug(
                "Prepared clip %d/%d: scene_id=%s type=%s duration=%.2f speed=%.2f",
                i + 1, len(raw), scene.scene_id, scene.type,
                new_dur or clip_info.duration, scene.speed,
            )

        return clips

    def _beat_align_clips(
        self,
        clips: list[ClipInfo],
        beats: list[float],
    ) -> list[ClipInfo]:
        """
        Adjust clip durations so that scene boundaries align with beats.

        Small adjustments (< tolerance) are made to clip durations so the
        transition between clips lands on a beat, creating a rhythmic edit.
        The total duration is preserved by compensating adjustments across clips.
        """
        if not beats or len(clips) <= 1:
            return clips

        tolerance = (
            self.req.beat_sync.tolerance_sec
            if self.req.beat_sync
            else 0.5
        )

        adjusted = list(clips)
        # Compute cumulative transition times (where each boundary falls)
        boundaries: list[float] = []
        cursor = 0.0
        for i, clip in enumerate(adjusted):
            cursor += clip.duration
            if i < len(adjusted) - 1:
                boundaries.append(cursor)

        # Snap each boundary to the nearest beat
        snapped = []
        total_shift = 0.0
        for i, boundary in enumerate(boundaries):
            snapped_time = snap_to_beat(boundary, beats, tolerance)
            shift = snapped_time - boundary
            snapped.append(snapped_time)
            total_shift += shift

        # Apply shifts: adjust clip durations so boundaries hit beats
        # Each boundary shift is absorbed by the clips on either side
        for i, (boundary, snapped_time) in enumerate(zip(boundaries, snapped)):
            shift = snapped_time - boundary
            # Add shift duration to the clip BEFORE the boundary
            new_dur = adjusted[i].duration + shift
            if new_dur < 1.0:
                # Don't make clips shorter than 1 second
                continue
            adjusted[i] = ClipInfo(
                path=adjusted[i].path,
                duration=new_dur,
                has_audio=adjusted[i].has_audio,
                transition=adjusted[i].transition,
                transition_duration=adjusted[i].transition_duration,
            )
            # Subtract shift from the clip AFTER the boundary
            if i + 1 < len(adjusted):
                next_dur = adjusted[i + 1].duration - shift
                if next_dur < 1.0:
                    continue
                adjusted[i + 1] = ClipInfo(
                    path=adjusted[i + 1].path,
                    duration=next_dur,
                    has_audio=adjusted[i + 1].has_audio,
                    transition=adjusted[i + 1].transition,
                    transition_duration=adjusted[i + 1].transition_duration,
                )

        logger.info(
            "Beat-aligned %d clips, %d/%d boundaries snapped to beats",
            len(adjusted),
            sum(1 for s in snapped if abs(s - boundaries[snapped.index(s)]) > 0.01),
            len(snapped),
        )
        return adjusted

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
    2.5. Beat detection (if BGM + beat_sync enabled)
    3. Prepare background clips (normalise video / Ken Burns image)
    3.5. Quality gate check on all clips
    4. Compose each segment (chroma-key avatar overlaid on background)
    5. Concatenate segment clips with transitions
    6. Burn subtitles (if any)
    7. Mix BGM with ducking (if any)
    8. Final H.264 encode
    9. Upload to storage
    """

    TOTAL_STAGES = 11

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
        self._beat_info: Optional[BeatInfo] = None

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

        # ── Stage 2.5: Beat detection for rhythm-synced segments ────────────
        beat_times: list[float] = []
        if self.req.beat_sync and self.req.beat_sync.enabled and self.req.audio_track:
            self._progress(3, "Анализируем ритм BGM")
            bgm_local = self._path("bgm_source")
            await self.storage.download(self.req.audio_track.storage_key, bgm_local)
            self._beat_info = await asyncio.get_event_loop().run_in_executor(
                None, detect_beats, bgm_local,
            )
            source = (
                self._beat_info.onset_timestamps
                if self.req.beat_sync.use_onsets
                else self._beat_info.timestamps
            )
            beat_times = source
            logger.info(
                "Layout beat sync: %d beats at %.1f BPM",
                len(beat_times), self._beat_info.bpm,
            )
        else:
            self._progress(3, "Beat sync пропущен")

        # ── Compute segment timings (beat-aligned if beats available) ───────
        if beat_times:
            weights = compute_beat_aligned_segment_weights(
                total_duration=total_duration,
                num_segments=len(self.req.segments),
                beats=beat_times,
            )
            seg_timings: list[tuple[float, float]] = []
            cursor = 0.0
            for i, seg in enumerate(self.req.segments):
                dur = total_duration * weights[i]
                seg_timings.append((cursor, dur))
                cursor += dur
            logger.info("Beat-aligned segment weights: %s", [round(w, 3) for w in weights])
        else:
            total_weight = sum(seg.weight for seg in self.req.segments)
            seg_timings = []
            cursor = 0.0
            for seg in self.req.segments:
                dur = total_duration * (seg.weight / total_weight)
                seg_timings.append((cursor, dur))
                cursor += dur

        logger.info(
            "Avatar duration=%.1fs, %d segments, weights normalised",
            total_duration, len(self.req.segments),
        )

        # ── Stage 4: Prepare background clips ─────────────────────────────
        self._progress(4, "Готовим фоновые клипы")
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

        # ── Stage 5: Quality gate ──────────────────────────────────────────
        if not self.req.skip_quality_gate:
            self._progress(5, "Проверяем качество клипов")
            qa_clips = [
                (bg_prepared_list[i], self.req.backgrounds[self.req.segments[i].bg_index].type, i)
                for i in range(len(self.req.segments))
            ]
            report = await asyncio.get_event_loop().run_in_executor(
                None, run_quality_gate, qa_clips,
            )
            if not report.passed:
                critical = [i for i in report.issues if i.severity == "critical"]
                logger.warning(
                    "Quality gate FAILED for layout job %s: %d critical — proceeding",
                    self.req.job_id, len(critical),
                )
        else:
            self._progress(5, "Quality gate пропущен")

        # ── Stage 6: Compose each segment ─────────────────────────────────
        self._progress(6, f"Композитим {len(self.req.segments)} сегментов")

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

        # ── Stage 7: Concatenate segments ──────────────────────────────────
        self._progress(7, f"Склеиваем {len(clips)} сегментов")
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

                # Also adjust duck zones for xfade overlap (same transform)
                if self.req.audio_track and self.req.audio_track.duck_zones:
                    from app.models import AudioDuckZone
                    self.req.audio_track.duck_zones = [
                        AudioDuckZone(
                            start_sec=round(_adjust_time(z.start_sec), 2),
                            end_sec=round(_adjust_time(z.end_sec), 2),
                            duck_volume=z.duck_volume,
                        )
                        for z in self.req.audio_track.duck_zones
                    ]
                if self.req.word_timestamps:
                    self.req.word_timestamps = [
                        {"word": w.get("word", ""), "start": round(_adjust_time(w.get("start", 0)), 3), "end": round(_adjust_time(w.get("end", 0)), 3)}
                        for w in self.req.word_timestamps
                    ]

        # ── Stage 8: Burn subtitles ───────────────────────────────────────
        current = combined
        if self.req.subtitles:
            self._progress(8, "Сжигаем субтитры")
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
            self._progress(8, "Субтитров нет, пропускаем")

        # ── Stage 9: Mix BGM with ducking ──────────────────────────────────
        if self.req.audio_track:
            self._progress(9, "Микшируем фоновую музыку (с ducking)")
            bgm_local = self._path("bgm_source")
            if not os.path.exists(bgm_local):
                await self.storage.download(self.req.audio_track.storage_key, bgm_local)
            bgm_mixed = self._path("bgm_mixed.mp4")
            at = self.req.audio_track

            duck_zones = None
            if at.duck_zones:
                duck_zones = [(z.start_sec, z.end_sec) for z in at.duck_zones]
            elif self.req.word_timestamps:
                duck_zones = self._compute_duck_zones_from_words(
                    self.req.word_timestamps,
                )

            await asyncio.get_event_loop().run_in_executor(
                None,
                fx.mix_bgm_ducking,
                current, bgm_local, bgm_mixed,
                at.volume,
                at.duck_zones[0].duck_volume if at.duck_zones else 0.04,
                duck_zones,
                at.duck_fade_ms,
                at.fade_in_sec, at.fade_out_sec,
                self.threads,
            )
            current = bgm_mixed
        else:
            self._progress(9, "Фоновой музыки нет, пропускаем")

        # ── Stage 10: Final encode ─────────────────────────────────────────
        self._progress(10, "Финальная кодировка (H.264)")
        final = self._path("final.mp4")
        await asyncio.get_event_loop().run_in_executor(
            None, fx.final_encode,
            current, final,
            s.width, s.height, s.fps,
            s.crf, s.preset, s.audio_bitrate,
            s.max_bitrate, s.bufsize,
            self.threads,
        )

        # ── Stage 11: Upload ───────────────────────────────────────────────
        self._progress(11, f"Загружаем → {self.req.output_key}")
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

    def _compute_duck_zones_from_words(
        self,
        words: list[dict],
        min_gap_sec: float = 0.5,
    ) -> list[tuple[float, float]]:
        """
        Convert word-level timestamps into duck zones (speech-active ranges).

        Groups consecutive words into continuous speech segments. Gaps shorter
        than min_gap_sec are bridged (natural pauses between words). Each
        resulting segment is a duck zone where BGM volume should be lowered.
        """
        if not words:
            return []

        zones: list[tuple[float, float]] = []
        seg_start = words[0].get("start", 0)
        seg_end = words[0].get("end", 0)

        for w in words[1:]:
            w_start = w.get("start", 0)
            w_end = w.get("end", 0)

            if w_start - seg_end < min_gap_sec:
                seg_end = w_end
            else:
                zones.append((seg_start, seg_end))
                seg_start = w_start
                seg_end = w_end

        zones.append((seg_start, seg_end))
        return zones

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
