"""Uniqueness recipes, file hygiene and similarity measurement for variants.

A *recipe* is every per-variant lever derived deterministically from the seed:
visual reframing, colour, motion, timing, audio pitch/EQ, encoder settings and
container metadata. The same seed reproduces the same file; different seeds
give copies that differ in picture, sound AND file structure.

A *signature* is a compact fingerprint of a rendered file:
  • visual — dHash (16×16 = 256 bits) of 8 frames spread over the video;
  • audio  — Haitsma–Kalker style bits (sign of energy differences between
             adjacent frequency bands over time).
Distances are normalised Hamming distances (0 = identical, ~0.5 = unrelated),
used to check each copy against the source and against its siblings.
"""

from __future__ import annotations

import math
import random
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services import ffmpeg as fx

# ── Recipe ────────────────────────────────────────────────────────────────────

# Realistic capture devices (make, model). Picked per variant so copies never
# share one suspicious profile.
DEVICE_POOL = [
    ("Apple", "iPhone 13"), ("Apple", "iPhone 14"), ("Apple", "iPhone 14 Pro"),
    ("Apple", "iPhone 15"), ("Apple", "iPhone 15 Pro"), ("Apple", "iPhone 16"),
    ("samsung", "SM-S911B"), ("samsung", "SM-S921B"), ("samsung", "SM-A546E"),
    ("Google", "Pixel 7"), ("Google", "Pixel 8"), ("Xiaomi", "23049PCD8G"),
]


@dataclass
class Recipe:
    level: str
    # visual
    zoom: float = 1.04            # punch-in factor (≥1)
    bias_x: float = 0.5           # crop position 0..1 after the punch-in
    bias_y: float = 0.5
    rotate_deg: float = 0.0
    mirror: bool = False
    gamma: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    hue_deg: float = 0.0
    grain: int = 0                # ffmpeg noise strength
    vignette: bool = False
    sharpen: float = 0.0          # unsharp luma amount (negative = soften)
    ken_burns: float = 0.0        # extra zoom drift over the clip
    frame_layout: bool = False    # video scaled into a blurred copy of itself
    frame_scale: float = 0.92
    # timing
    speed: float = 1.0            # playback speed (video + audio, pitch-preserved)
    trim_head: float = 0.0
    trim_tail: float = 0.0
    # audio
    pitch_semitones: float = 0.0
    eq_low_db: float = 0.0
    eq_mid_db: float = 0.0
    eq_high_db: float = 0.0
    # encoder
    crf: int = 22
    preset: str = "veryfast"
    gop: int = 60
    bframes: int = 2
    audio_bitrate: str = "160k"
    sample_rate: int = 44100
    # container
    make: str = "Apple"
    model: str = "iPhone 15"
    creation_time: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def make_recipe(seed: int, level: str = "maximum", *, allow_mirror: bool = False,
                frame_layout: str = "auto") -> Recipe:
    """Deterministic per-variant recipe. ``level``: standard | maximum.
    ``frame_layout``: off | on | auto (auto = sometimes, maximum only)."""
    rng = random.Random(seed * 2654435761 % (2 ** 32))
    strong = level == "maximum"
    r = Recipe(level=level)

    r.zoom = round(rng.uniform(1.04, 1.10) if strong else rng.uniform(1.02, 1.05), 4)
    # Offset the crop away from dead centre (keeps the subject, moves the frame).
    r.bias_x = round(rng.uniform(0.2, 0.8), 3)
    r.bias_y = round(rng.uniform(0.25, 0.75), 3)
    r.rotate_deg = round(rng.choice([-1, 1]) * rng.uniform(0.4, 1.4), 2) if strong else 0.0
    r.mirror = allow_mirror and rng.random() < 0.5
    r.gamma = round(rng.uniform(0.95, 1.06) if strong else rng.uniform(0.98, 1.03), 3)
    r.contrast = round(rng.uniform(0.95, 1.07) if strong else rng.uniform(0.98, 1.03), 3)
    r.saturation = round(rng.uniform(0.9, 1.14) if strong else rng.uniform(0.96, 1.05), 3)
    r.hue_deg = round(rng.uniform(-6, 6), 2) if strong else 0.0
    r.grain = rng.choice([3, 4, 5, 6]) if strong else rng.choice([0, 2, 3])
    r.vignette = strong and rng.random() < 0.5
    r.sharpen = round(rng.choice([-0.4, -0.2, 0.3, 0.5]), 2) if strong else 0.0
    r.ken_burns = round(rng.uniform(0.01, 0.035), 4) if strong else 0.0
    r.frame_layout = frame_layout == "on" or (frame_layout == "auto" and strong and rng.random() < 0.3)
    r.frame_scale = round(rng.uniform(0.86, 0.94), 3)

    r.speed = round(rng.uniform(0.95, 1.06) if strong else rng.uniform(0.98, 1.03), 4)
    r.trim_head = round(rng.uniform(0.15, 0.6) if strong else rng.uniform(0.0, 0.3), 2)
    r.trim_tail = round(rng.uniform(0.0, 0.4), 2)

    r.pitch_semitones = round(rng.choice([-1, 1]) * rng.uniform(0.25, 0.6), 2) if strong else 0.0
    r.eq_low_db = round(rng.uniform(-2.5, 2.5), 1)
    r.eq_mid_db = round(rng.uniform(-1.5, 2.0), 1)
    r.eq_high_db = round(rng.uniform(-2.5, 2.0), 1)

    r.crf = rng.choice([20, 21, 22, 23])
    r.preset = rng.choice(["veryfast", "faster", "fast"])
    r.gop = rng.choice([30, 48, 60, 72, 90])
    r.bframes = rng.choice([1, 2, 3])
    r.audio_bitrate = rng.choice(["128k", "160k", "192k"])
    r.sample_rate = rng.choice([44100, 48000])

    r.make, r.model = rng.choice(DEVICE_POOL)
    ago = timedelta(minutes=rng.randint(20, 72 * 60))
    r.creation_time = (datetime.now(timezone.utc) - ago).strftime("%Y-%m-%dT%H:%M:%S.000000Z")
    return r


# ── Filter chains from a recipe ───────────────────────────────────────────────

def _even(n: float) -> int:
    n = int(round(n))
    return n - (n % 2)


def video_filter(r: Recipe, width: int, height: int, fps: int, duration: float) -> str:
    """Video chain for one input labelled [0:v] → ends in yuv420p at width×height.
    Returned as a filtergraph body WITHOUT input/output labels for the main path
    (frame layout uses its own split, so it returns a complete labelled graph)."""
    z = max(1.0, r.zoom)
    sw, sh = _even(width * z), _even(height * z)
    parts = [
        f"scale={sw}:{sh}:force_original_aspect_ratio=increase:flags=lanczos",
        f"crop={width}:{height}:(in_w-{width})*{r.bias_x:.3f}:(in_h-{height})*{r.bias_y:.3f}",
    ]
    if r.ken_burns > 0 and duration > 0:
        k = r.ken_burns
        parts.append(
            f"scale=w='trunc(iw*(1+{k:.4f}*t/{duration:.3f})/2)*2':"
            f"h='trunc(ih*(1+{k:.4f}*t/{duration:.3f})/2)*2':eval=frame,crop={width}:{height}"
        )
    if abs(r.rotate_deg) > 0.01:
        rad = abs(r.rotate_deg) * math.pi / 180.0
        # Scale needed so the rotated frame still covers the whole canvas:
        # s ≥ cosθ + (long/short)·sinθ (portrait 1.4° → ~4.3%).
        cover = math.cos(rad) + (max(width, height) / min(width, height)) * math.sin(rad) + 0.004
        sign = 1 if r.rotate_deg > 0 else -1
        parts.append(f"rotate={sign * rad:.5f}:fillcolor=black,"
                     f"scale={_even(width * cover)}:{_even(height * cover)},crop={width}:{height}")
    if r.mirror:
        parts.append("hflip")
    parts.append(f"eq=gamma={r.gamma}:contrast={r.contrast}:saturation={r.saturation}")
    if abs(r.hue_deg) > 0.05:
        parts.append(f"hue=h={r.hue_deg}")
    if r.sharpen:
        parts.append(f"unsharp=5:5:{r.sharpen}:5:5:0")
    if r.grain:
        parts.append(f"noise=alls={r.grain}:allf=t")
    if r.vignette:
        parts.append("vignette=PI/6")
    if abs(r.speed - 1.0) > 0.0005:
        parts.append(f"setpts=PTS/{r.speed:.5f}")
    parts.append(f"fps={fps}")
    chain = ",".join(parts)
    if not r.frame_layout:
        return f"[0:v]{chain},format=yuv420p[vout]"
    # Frame layout: sharp video scaled down over a blurred, darkened copy of itself.
    fw, fh = _even(width * r.frame_scale), _even(height * r.frame_scale)
    return (
        f"[0:v]{chain},split=2[fg0][bg0];"
        f"[bg0]boxblur=24:2,eq=brightness=-0.08:saturation=0.8[bg];"
        f"[fg0]scale={fw}:{fh}[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vout]"
    )


def audio_filter(r: Recipe) -> str:
    """Audio chain: pitch shift (asetrate+atempo), speed, EQ, resample."""
    parts = ["aformat=sample_rates=44100:channel_layouts=stereo"]
    tempo = r.speed
    if abs(r.pitch_semitones) > 0.01:
        ratio = 2 ** (r.pitch_semitones / 12.0)
        parts.append(f"asetrate={44100 * ratio:.1f}")
        parts.append("aresample=44100")
        tempo = tempo / ratio          # undo the duration change of asetrate
    if abs(tempo - 1.0) > 0.0005:
        parts.append(f"atempo={tempo:.5f}")
    parts.append(f"equalizer=f=120:width_type=o:width=1.5:g={r.eq_low_db}")
    parts.append(f"equalizer=f=1800:width_type=o:width=1.5:g={r.eq_mid_db}")
    parts.append(f"equalizer=f=7500:width_type=o:width=1.5:g={r.eq_high_db}")
    parts.append(f"aresample={r.sample_rate}")
    return ",".join(parts)


def encoder_args(r: Recipe, threads: int) -> list[str]:
    return [
        "-c:v", "libx264", "-preset", r.preset, "-crf", str(r.crf),
        "-g", str(r.gop), "-bf", str(r.bframes),
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", r.audio_bitrate, "-ar", str(r.sample_rate), "-ac", "2",
        "-threads", str(threads),
    ]


def hygiene_args(r: Recipe) -> list[str]:
    """Container/bitstream hygiene: no x264 SEI (version + full settings string),
    no Lavf/Lavc encoder tags, no inherited metadata; one plausible device
    profile and capture time per variant."""
    apple = r.make == "Apple"
    device = (
        ["-metadata", f"com.apple.quicktime.make={r.make}",
         "-metadata", f"com.apple.quicktime.model={r.model}",
         "-metadata", f"com.apple.quicktime.creationdate={r.creation_time[:19]}+0300"]
        if apple else
        ["-metadata", f"com.android.manufacturer={r.make}",
         "-metadata", f"com.android.model={r.model}"]
    )
    return [
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-bsf:v", "filter_units=remove_types=6",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        # Empty value deletes the stream-level "Lavc libx264" encoder tag.
        "-metadata:s:v:0", "encoder=", "-metadata:s:a:0", "encoder=",
        "-metadata:s:v:0", f"handler_name={'Core Media Video' if apple else 'VideoHandle'}",
        "-metadata:s:a:0", f"handler_name={'Core Media Audio' if apple else 'SoundHandle'}",
        "-metadata", f"creation_time={r.creation_time}",
        *device,
        "-movflags", "+faststart+use_metadata_tags",
    ]


# ── Signatures & distances ────────────────────────────────────────────────────

VIS_FRAMES = 8
VIS_W, VIS_H = 17, 16          # dHash: 16 comparisons per row × 16 rows = 256 bits


def _visual_bits(path: str, duration: float) -> list[int]:
    if duration <= 0:
        return []
    rate = VIS_FRAMES / max(duration, 0.5)
    cmd = [fx._bin("ffmpeg"), "-v", "error", "-i", path,
           "-vf", f"fps={rate:.5f},scale={VIS_W}:{VIS_H}:flags=area,format=gray",
           "-frames:v", str(VIS_FRAMES), "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, timeout=180).stdout
    size = VIS_W * VIS_H
    bits: list[int] = []
    for f in range(len(raw) // size):
        px = raw[f * size:(f + 1) * size]
        for y in range(VIS_H):
            row = px[y * VIS_W:(y + 1) * VIS_W]
            bits.extend(1 if row[x] > row[x + 1] else 0 for x in range(VIS_W - 1))
    return bits


def _audio_bits(path: str, max_sec: float = 60.0) -> list[int]:
    """Haitsma–Kalker-style bits on 16 log-spaced bands, 0.1 s hop."""
    try:
        import numpy as np
    except Exception:  # noqa: BLE001
        return []
    sr = 8000
    cmd = [fx._bin("ffmpeg"), "-v", "error", "-i", path, "-t", f"{max_sec}", "-vn",
           "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, timeout=180).stdout
    if len(raw) < sr:  # < 0.5 s of audio
        return []
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    win, hop = 1024, 800
    n = (len(x) - win) // hop
    if n < 3:
        return []
    window = np.hanning(win).astype(np.float32)
    frames = np.stack([x[i * hop:i * hop + win] * window for i in range(n)])
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    freqs = np.fft.rfftfreq(win, 1 / sr)
    edges = np.geomspace(250, 3800, 18)
    bands = np.stack([spec[:, (freqs >= edges[b]) & (freqs < edges[b + 1])].sum(axis=1)
                      for b in range(17)], axis=1)
    e = np.log(bands + 1e-6)
    d = (e[1:, :-1] - e[1:, 1:]) - (e[:-1, :-1] - e[:-1, 1:])
    return (d > 0).astype(np.uint8).flatten().tolist()


def _pack(bits: list[int]) -> str:
    out = []
    for i in range(0, len(bits), 4):
        nib = bits[i:i + 4] + [0] * (4 - len(bits[i:i + 4]))
        out.append(f"{nib[0] << 3 | nib[1] << 2 | nib[2] << 1 | nib[3]:x}")
    return "".join(out)


def _unpack(hexs: str) -> list[int]:
    bits: list[int] = []
    for ch in hexs:
        v = int(ch, 16)
        bits.extend([(v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1])
    return bits


def signature(path: str) -> dict[str, str]:
    """Compact fingerprint {visual, audio} (hex strings) of a media file."""
    dur = fx.probe(path).duration
    out = {"visual": "", "audio": ""}
    try:
        out["visual"] = _pack(_visual_bits(path, dur))
    except Exception:  # noqa: BLE001
        pass
    try:
        out["audio"] = _pack(_audio_bits(path))
    except Exception:  # noqa: BLE001
        pass
    return out


def _ber(a: str, b: str) -> float | None:
    if not a or not b:
        return None
    ba, bb = _unpack(a), _unpack(b)
    n = min(len(ba), len(bb))
    if n == 0:
        return None
    return sum(x != y for x, y in zip(ba[:n], bb[:n])) / n


AUDIO_BANDS = 16  # bits per audio frame (17 bands → 16 differences)


def _audio_ber_aligned(a: str, b: str) -> float | None:
    """Audio BER under the best time alignment: search offset (±1 s) and tempo
    (0.93–1.07) like a real fingerprint matcher would — so a mere speed change
    does not masquerade as 'completely different audio'."""
    if not a or not b:
        return None
    try:
        import numpy as np
    except Exception:  # noqa: BLE001
        return _ber(a, b)
    A = np.array(_unpack(a), dtype=np.uint8)
    B = np.array(_unpack(b), dtype=np.uint8)
    A = A[: len(A) // AUDIO_BANDS * AUDIO_BANDS].reshape(-1, AUDIO_BANDS)
    B = B[: len(B) // AUDIO_BANDS * AUDIO_BANDS].reshape(-1, AUDIO_BANDS)
    if len(A) < 20 or len(B) < 20:
        return _ber(a, b)
    best = 1.0
    idx = np.arange(len(A))
    for k in np.arange(0.93, 1.0701, 0.01):
        for off in range(-10, 11):
            j = np.round(idx * k).astype(int) + off
            ok = (j >= 0) & (j < len(B))
            if ok.sum() < 20:
                continue
            ber = float((A[idx[ok]] != B[j[ok]]).mean())
            best = min(best, ber)
    return best


def distance(a: dict[str, str], b: dict[str, str]) -> dict[str, float | None]:
    """Normalised distances 0..1 (×2 so ~0.5 BER of unrelated content → ~1.0).
    Audio is compared under the best offset/tempo alignment (worst case for us)."""
    v = _ber(a.get("visual", ""), b.get("visual", ""))
    au = _audio_ber_aligned(a.get("audio", ""), b.get("audio", ""))
    return {
        "visual": None if v is None else round(min(1.0, v * 2), 3),
        "audio": None if au is None else round(min(1.0, au * 2), 3),
    }
