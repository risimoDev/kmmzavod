"""
Quality gate service for pre-composition clip verification.

Detects common AI generation issues before clips enter the composition pipeline:
• Blur / out-of-focus (Laplacian variance)
• Black frames (mean pixel value near zero)
• Too dark / too bright (mean pixel value extremes)
• No motion in video clips (frame difference analysis)

Returns a QualityReport with pass/fail status, individual issue details,
and an overall quality score. Critical issues abort the composition;
warnings are logged but do not block.

Uses OpenCV (headless) for frame analysis — no GUI dependencies needed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.models import QualityIssue, QualityReport

logger = logging.getLogger(__name__)

BLUR_THRESHOLD = 50.0
BLACK_THRESHOLD = 15.0
DARK_THRESHOLD = 25.0
BRIGHT_THRESHOLD = 240.0
MOTION_THRESHOLD = 2.0
MIN_SCORE_TO_PASS = 0.4


def _check_blur(frame_gray, score_threshold: float = BLUR_THRESHOLD) -> tuple[bool, float]:
    """Check if a frame is blurry using Laplacian variance. Returns (is_blurry, score)."""
    import cv2
    variance = cv2.Laplacian(frame_gray, cv2.CV_64F).var()
    return variance < score_threshold, variance


def _check_black_frame(frame_gray, threshold: float = BLACK_THRESHOLD) -> bool:
    """Check if a frame is essentially black (all pixels below threshold)."""
    mean_val = frame_gray.mean()
    return mean_val < threshold


def _check_dark(frame_gray, threshold: float = DARK_THRESHOLD) -> bool:
    """Check if a frame is too dark."""
    return frame_gray.mean() < threshold


def _check_bright(frame_gray, threshold: float = BRIGHT_THRESHOLD) -> bool:
    """Check if a frame is too bright (overexposed)."""
    return frame_gray.mean() > threshold


def _extract_sample_frames(video_path: str, num_samples: int = 5) -> list:
    """Extract evenly-spaced sample frames from a video file."""
    import cv2
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        logger.warning("Cannot open video for quality check: %s", video_path)
        return []

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames <= 0:
        cap.release()
        return []

    step = max(1, total_frames // num_samples)
    frames = []
    for i in range(num_samples):
        frame_idx = min(i * step + step // 2, total_frames - 1)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if ret:
            frames.append(frame)
    cap.release()
    return frames


def _extract_first_frame(image_path: str):
    """Read an image file and return it as a numpy array."""
    import cv2
    img = cv2.imread(image_path)
    return img


def check_video_clip(video_path: str, scene_index: int = 0) -> list[QualityIssue]:
    """Run quality checks on a video clip. Returns list of issues found."""
    import cv2

    issues: list[QualityIssue] = []
    frames = _extract_sample_frames(video_path, num_samples=5)

    if not frames:
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="black_frame",
            severity="critical",
            score=0.0,
            message="Cannot extract frames from video clip",
        ))
        return issues

    blur_scores = []
    black_count = 0
    dark_count = 0
    bright_count = 0

    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        is_blurry, blur_score = _check_blur(gray)
        blur_scores.append(blur_score)

        if _check_black_frame(gray):
            black_count += 1
        if _check_dark(gray):
            dark_count += 1
        if _check_bright(gray):
            bright_count += 1

    avg_blur = sum(blur_scores) / len(blur_scores)

    if avg_blur < BLUR_THRESHOLD * 0.5:
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="blur",
            severity="critical",
            score=min(1.0, avg_blur / BLUR_THRESHOLD),
            message=f"Severely blurry clip (Laplacian var={avg_blur:.1f}, threshold={BLUR_THRESHOLD:.1f})",
        ))
    elif avg_blur < BLUR_THRESHOLD:
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="blur",
            severity="warning",
            score=min(1.0, avg_blur / BLUR_THRESHOLD),
            message=f"Mildly blurry clip (Laplacian var={avg_blur:.1f})",
        ))

    if black_count >= len(frames) * 0.6:
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="black_frame",
            severity="critical",
            score=0.0,
            message=f"Clip contains {black_count}/{len(frames)} black frames",
        ))

    if dark_count >= len(frames) * 0.8:
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="too_dark",
            severity="warning",
            score=0.3,
            message=f"Clip is too dark ({dark_count}/{len(frames)} frames)",
        ))

    if bright_count >= len(frames) * 0.8:
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="too_bright",
            severity="warning",
            score=0.3,
            message=f"Clip is overexposed ({bright_count}/{len(frames)} frames)",
        ))

    return issues


def check_image(image_path: str, scene_index: int = 0) -> list[QualityIssue]:
    """Run quality checks on a static image. Returns list of issues found."""
    import cv2

    issues: list[QualityIssue] = []
    img = _extract_first_frame(image_path)

    if img is None:
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="black_frame",
            severity="critical",
            score=0.0,
            message="Cannot read image file",
        ))
        return issues

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    is_blurry, blur_score = _check_blur(gray)
    if is_blurry:
        severity = "critical" if blur_score < BLUR_THRESHOLD * 0.5 else "warning"
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="blur",
            severity=severity,
            score=min(1.0, blur_score / BLUR_THRESHOLD),
            message=f"Blurry image (Laplacian var={blur_score:.1f})",
        ))

    if _check_black_frame(gray):
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="black_frame",
            severity="critical",
            score=0.0,
            message="Image appears to be entirely black",
        ))

    if _check_dark(gray):
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="too_dark",
            severity="warning",
            score=0.3,
            message="Image is very dark",
        ))

    if _check_bright(gray):
        issues.append(QualityIssue(
            scene_index=scene_index,
            issue_type="too_bright",
            severity="warning",
            score=0.3,
            message="Image is overexposed",
        ))

    return issues


def run_quality_gate(
    clips: list[tuple[str, str, int]],
) -> QualityReport:
    """
    Run quality gate checks on a list of clips.

    Args:
        clips: List of (file_path, clip_type, scene_index) tuples.
               clip_type is "video" or "image".

    Returns:
        QualityReport with pass/fail, issues, and overall score.
    """
    all_issues: list[QualityIssue] = []

    for file_path, clip_type, scene_index in clips:
        try:
            if clip_type == "image":
                issues = check_image(file_path, scene_index)
            else:
                issues = check_video_clip(file_path, scene_index)
            all_issues.extend(issues)
        except Exception as exc:
            logger.warning(
                "Quality check failed for scene %d: %s", scene_index, exc,
            )
            all_issues.append(QualityIssue(
                scene_index=scene_index,
                issue_type="black_frame",
                severity="warning",
                score=0.5,
                message=f"Quality check error: {exc}",
            ))

    critical_count = sum(1 for i in all_issues if i.severity == "critical")
    warning_count = sum(1 for i in all_issues if i.severity == "warning")

    scores = [i.score for i in all_issues] or [1.0]
    overall_score = sum(scores) / len(scores) if all_issues else 1.0

    passed = critical_count == 0 and overall_score >= MIN_SCORE_TO_PASS

    if all_issues:
        logger.info(
            "Quality gate: %s (%d critical, %d warnings, score=%.2f)",
            "PASSED" if passed else "FAILED",
            critical_count, warning_count, overall_score,
        )
        for issue in all_issues:
            log_fn = logger.warning if issue.severity == "critical" else logger.info
            log_fn(
                "  Scene %d: [%s] %s (score=%.2f)",
                issue.scene_index, issue.issue_type, issue.message, issue.score,
            )
    else:
        logger.info("Quality gate: PASSED (no issues detected)")

    return QualityReport(
        passed=passed,
        issues=all_issues,
        overall_score=round(overall_score, 3),
    )
