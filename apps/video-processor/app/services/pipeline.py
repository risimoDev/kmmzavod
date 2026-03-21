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
    SceneItem,
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
                # Trim to requested duration (don't extend beyond source)
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
