/**
 * Variant uniqueness scoring — TS mirror of apps/video-processor
 * services/uniqueness.py `distance()` (keep the two in sync).
 *
 * Signatures are hex bit-strings: visual = 8 frames × 256-bit dHash, audio =
 * 16 bits per 0.1 s frame. Distances are normalised Hamming (×2, capped at 1):
 * re-encode ≈ 0.01, tempo-only ≈ 0.4 (audio), pitch shift ≈ 0.9, unrelated ≈ 1.
 */

export interface Signature { visual?: string; audio?: string }
export interface Dist { visual: number | null; audio: number | null }

const AUDIO_BANDS = 16;

function unpack(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length * 4);
  for (let i = 0; i < hex.length; i++) {
    const v = parseInt(hex[i], 16);
    out[i * 4] = (v >> 3) & 1;
    out[i * 4 + 1] = (v >> 2) & 1;
    out[i * 4 + 2] = (v >> 1) & 1;
    out[i * 4 + 3] = v & 1;
  }
  return out;
}

function ber(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const A = unpack(a);
  const B = unpack(b);
  const n = Math.min(A.length, B.length);
  if (!n) return null;
  let d = 0;
  for (let i = 0; i < n; i++) if (A[i] !== B[i]) d++;
  return d / n;
}

/** Audio BER under the best offset (±1 s) / tempo (0.93–1.07) alignment. */
function audioBerAligned(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const A = unpack(a);
  const B = unpack(b);
  const na = Math.floor(A.length / AUDIO_BANDS);
  const nb = Math.floor(B.length / AUDIO_BANDS);
  if (na < 20 || nb < 20) return ber(a, b);
  let best = 1;
  for (let k = 0.93; k <= 1.0701; k += 0.01) {
    for (let off = -10; off <= 10; off++) {
      let diff = 0;
      let cnt = 0;
      for (let i = 0; i < na; i++) {
        const j = Math.round(i * k) + off;
        if (j < 0 || j >= nb) continue;
        for (let bit = 0; bit < AUDIO_BANDS; bit++) {
          if (A[i * AUDIO_BANDS + bit] !== B[j * AUDIO_BANDS + bit]) diff++;
        }
        cnt += AUDIO_BANDS;
      }
      if (cnt >= 20 * AUDIO_BANDS) best = Math.min(best, diff / cnt);
    }
  }
  return best;
}

export function distance(a: Signature, b: Signature): Dist {
  const v = ber(a.visual, b.visual);
  const au = audioBerAligned(a.audio, b.audio);
  return {
    visual: v === null ? null : Math.round(Math.min(1, v * 2) * 1000) / 1000,
    audio: au === null ? null : Math.round(Math.min(1, au * 2) * 1000) / 1000,
  };
}

/** 0..100: how far a copy is from a reference (visual weighted 60 %, audio 40 %). */
export function uniquenessScore(d: Dist | null | undefined): number | null {
  if (!d || (d.visual === null && d.audio === null)) return null;
  const v = d.visual === null ? null : Math.min(1, d.visual / 0.5);
  const a = d.audio === null ? null : Math.min(1, d.audio / 0.6);
  if (v === null) return Math.round(a! * 100);
  if (a === null) return Math.round(v * 100);
  return Math.round((0.6 * v + 0.4 * a) * 100);
}

/** Copy is too close to the source (≈ re-encode) or to a sibling copy. */
export function isWeak(vsSource: Dist | null | undefined, nearest: Dist | null | undefined): string | null {
  if (vsSource && vsSource.visual !== null && vsSource.visual < 0.1 && (vsSource.audio === null || vsSource.audio < 0.2)) {
    return 'почти не отличается от исходника';
  }
  if (nearest && nearest.visual !== null && nearest.visual < 0.05 && (nearest.audio === null || nearest.audio < 0.1)) {
    return 'почти копия другого варианта';
  }
  return null;
}
