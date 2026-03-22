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

/** GPTunnel proxy – GPT-4o input: $5 / 1 M tokens → $0.005 / 1 K tokens */
const GPTUNNEL_INPUT_PER_1K = 0.005;
/** GPTunnel proxy – GPT-4o output: $15 / 1 M tokens → $0.015 / 1 K tokens */
const GPTUNNEL_OUTPUT_PER_1K = 0.015;

/** HeyGen avatar video: ~$0.03 per second */
const HEYGEN_PER_SEC = 0.03;
/** HeyGen minimum charge per API call */
const HEYGEN_MIN_USD = 0.10;

/** Runway Gen-3 Turbo: $0.05 per second (5 s = $0.25, 10 s = $0.50) */
const RUNWAY_PER_SEC = 0.05;

/** fal.ai flux-pro: $0.055 per image */
const FAL_PER_IMAGE = 0.055;
/** Replicate SDXL: $0.006 per image */
const REPLICATE_PER_IMAGE = 0.006;
/** ComfyUI (self-hosted): $0 per image */
const COMFYUI_PER_IMAGE = 0;

/** Platform credit conversion: 1 credit = $0.001 */
const USD_PER_CREDIT = 0.001;

// ── Cost calculators ──────────────────────────────────────────────────────────

/**
 * Estimate cost of a GPT-4o call routed through GPTunnel.
 *
 * Pricing (as of 2024-Q4):
 * - Input:  $0.005 per 1 K tokens ($5 / 1 M)
 * - Output: $0.015 per 1 K tokens ($15 / 1 M)
 *
 * @see https://gptunnel.ru — GPTunnel proxy documentation
 * @see https://openai.com/api/pricing — OpenAI model pricing
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
 * Estimate cost of a Runway Gen-3 Turbo video clip.
 *
 * Pricing (as of 2024-Q4):
 * - $0.05 per second (turbo mode)
 * - 5 s clip = $0.25, 10 s clip = $0.50
 *
 * @see https://docs.runwayml.com — Runway API documentation
 *
 * @param durationSec Duration of the clip in seconds
 * @returns Cost in USD
 */
export function runwayCostUsd(durationSec: number): number {
  return durationSec * RUNWAY_PER_SEC;
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
 * | runway     | (→ fal)      | $0.055      |
 *
 * @see https://fal.ai/pricing — fal.ai pricing
 * @see https://replicate.com/pricing — Replicate pricing
 *
 * @param provider Image generation provider identifier
 * @returns Cost in USD
 */
export function imageGenCostUsd(provider: 'fal' | 'replicate' | 'comfyui' | 'runway'): number {
  switch (provider) {
    case 'fal':       return FAL_PER_IMAGE;
    case 'replicate': return REPLICATE_PER_IMAGE;
    case 'comfyui':   return COMFYUI_PER_IMAGE;
    case 'runway':    return FAL_PER_IMAGE; // fallback to fal pricing
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
