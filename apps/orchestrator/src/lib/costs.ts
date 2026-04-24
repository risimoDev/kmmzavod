/**
 * AI provider cost estimation utilities.
 *
 * All helper functions return cost in **USD**.
 * Use {@link creditsFromUsd} to convert USD → internal platform credits.
 *
 * 1 credit = $0.001 USD (i.e. 1 000 credits = $1).
 *
 * Rates are approximate and should be updated when providers change pricing.
 *
 * @module costs
 */

// ── Rate constants ────────────────────────────────────────────────────────────

/** GPTunnel proxy – claude-4.6-sonnet input: $3 / 1 M tokens → $0.003 / 1 K tokens */
const GPTUNNEL_INPUT_PER_1K = 0.003;
/** GPTunnel proxy – claude-4.6-sonnet output: $15 / 1 M tokens → $0.015 / 1 K tokens */
const GPTUNNEL_OUTPUT_PER_1K = 0.015;

/** HeyGen avatar video: ~$0.03 per second */
const HEYGEN_PER_SEC = 0.03;
/** HeyGen minimum charge per API call */
const HEYGEN_MIN_USD = 0.10;

/** Runway Gen-4.5: $0.12 per second (1 credit = $0.01, 12 credits/sec) */
const RUNWAY_GEN45_PER_SEC = 0.12;
/** Runway Gen-4 Turbo: $0.05 per second (5 credits/sec) — image-to-video */
const RUNWAY_GEN4_TURBO_PER_SEC = 0.05;

/** Kling v1 Standard: $0.028 per second */
const KLING_PER_SEC = 0.028;

/** fal.ai flux-pro: $0.055 per image */
const FAL_PER_IMAGE = 0.055;
/** Runway gen4_image_turbo: 2 credits/image → $0.02 per image */
const RUNWAY_IMAGE_PER_IMAGE = 0.02;
/** Replicate SDXL: $0.006 per image */
const REPLICATE_PER_IMAGE = 0.006;
/** ComfyUI (self-hosted): $0 per image */
const COMFYUI_PER_IMAGE = 0;
/** Gemini (free tier): $0 per image */
const GEMINI_PER_IMAGE = 0;
/** GPTunnel gpt-image-2-medium: $0.020 per image (OpenAI gpt-image-2 medium quality) */
const GPTUNNEL_IMAGE_PER_IMAGE = 0.020;

/** Platform credit conversion: 1 credit = $0.001 */
const USD_PER_CREDIT = 0.001;

// ── Cost calculators ──────────────────────────────────────────────────────────

/**
 * Estimate cost of a claude-4.6-sonnet call routed through GPTunnel.
 *
 * Pricing (claude-4.6-sonnet as of 2025):
 * - Input:  $0.003 per 1 K tokens ($3 / 1 M)
 * - Output: $0.015 per 1 K tokens ($15 / 1 M)
 *
 * @see https://gptunnel.ru — GPTunnel proxy
 * @see https://www.anthropic.com/pricing — Anthropic model pricing
 *
 * @param promptTokens     Number of input (prompt) tokens
 * @param completionTokens Number of output (completion) tokens
 * @returns Cost in USD
 */
export function gptunnelCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000) * GPTUNNEL_INPUT_PER_1K
       + (completionTokens / 1_000) * GPTUNNEL_OUTPUT_PER_1K;
}

/**
 * Estimate cost of a HeyGen avatar video render.
 *
 * Pricing (approximate, as of 2024-Q4):
 * - ~$0.03 per second of generated video
 * - Minimum charge: $0.10 per API call
 *
 * @see https://docs.heygen.com — HeyGen API documentation
 *
 * @param durationSec Duration of the video in seconds
 * @returns Cost in USD (at least $0.10)
 */
export function heygenCostUsd(durationSec: number): number {
  return Math.max(HEYGEN_MIN_USD, durationSec * HEYGEN_PER_SEC);
}

/**
 * Estimate cost of a Runway Gen-4.5 video clip.
 *
 * Pricing (1 credit = $0.01):
 * - gen4.5:     12 credits/sec → $0.12/sec (text-to-video, highest quality)
 * - gen4_turbo:  5 credits/sec → $0.05/sec (image-to-video, 2.4× cheaper)
 *
 * @see https://docs.dev.runwayml.com/guides/pricing — Runway pricing
 *
 * @param durationSec Duration of the clip in seconds
 * @param model       Runway model: 'gen4.5' or 'gen4_turbo' (default)
 * @returns Cost in USD
 */
export function runwayCostUsd(durationSec: number, model: 'gen4.5' | 'gen4_turbo' = 'gen4_turbo'): number {
  const rate = model === 'gen4_turbo' ? RUNWAY_GEN4_TURBO_PER_SEC : RUNWAY_GEN45_PER_SEC;
  return durationSec * rate;
}

/**
 * Estimate cost of a Kling v1 Standard video clip.
 *
 * Pricing (as of 2024-Q4):
 * - $0.028 per second
 * - 5 s clip = $0.14, 10 s clip = $0.28
 *
 * @param durationSec Duration of the clip in seconds
 * @returns Cost in USD
 */
export function klingCostUsd(durationSec: number): number {
  return durationSec * KLING_PER_SEC;
}

/**
 * Estimate cost of a single image generation call.
 *
 * Per-image pricing (as of 2024-Q4):
 * | Provider   | Model        | Cost / image |
 * |------------|--------------|-------------|
 * | fal        | flux-pro     | $0.055      |
 * | replicate  | SDXL         | $0.006      |
 * | comfyui    | self-hosted  | $0.000      |
 * | runway     | gen4_image_turbo | $0.02   |
 *
 * @see https://fal.ai/pricing — fal.ai pricing
 * @see https://replicate.com/pricing — Replicate pricing
 *
 * @param provider Image generation provider identifier
 * @returns Cost in USD
 */
export function imageGenCostUsd(provider: 'fal' | 'replicate' | 'comfyui' | 'runway' | 'gemini' | 'gptunnel'): number {
  switch (provider) {
    case 'fal':       return FAL_PER_IMAGE;
    case 'replicate': return REPLICATE_PER_IMAGE;
    case 'comfyui':   return COMFYUI_PER_IMAGE;
    case 'runway':    return RUNWAY_IMAGE_PER_IMAGE;
    case 'gemini':    return GEMINI_PER_IMAGE;
    case 'gptunnel':  return GPTUNNEL_IMAGE_PER_IMAGE;
  }
}

/**
 * Convert a USD cost to internal platform credits.
 *
 * Conversion rate: **1 credit = $0.001** (1 000 credits = $1).
 *
 * Always rounds up (`Math.ceil`) so that every fractional credit is charged.
 * Returns at least 1 credit for any positive cost.
 *
 * @param usd Cost in US dollars
 * @returns Number of credits (integer, ≥ 1)
 */
export function creditsFromUsd(usd: number): number {
  return Math.max(1, Math.ceil(usd / USD_PER_CREDIT));
}
