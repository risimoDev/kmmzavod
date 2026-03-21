/**
 * AI provider cost estimation.
 *
 * All costs in USD.  1 credit = $0.01 USD — use `creditsFromUsd()` to convert.
 * Rates are approximate and should be updated when providers change pricing.
 */

// ── GPTunnel / OpenAI gpt-4o (via GPTunnel proxy) ────────────────────────────
export const GPTUNNEL_INPUT_PER_1K_TOKENS  = 0.005;  // $5  / 1M input tokens
export const GPTUNNEL_OUTPUT_PER_1K_TOKENS = 0.015;  // $15 / 1M output tokens

// ── OpenAI gpt-4o (legacy, kept for backward compat) ─────────────────────────
export const OPENAI_INPUT_PER_1K_TOKENS  = 0.005;
export const OPENAI_OUTPUT_PER_1K_TOKENS = 0.015;

// ── HeyGen avatar video ───────────────────────────────────────────────────────
export const HEYGEN_USD_PER_SEC = 0.10;

// ── Runway text-to-video ─────────────────────────────────────────────────────
export const RUNWAY_USD_PER_SEC = 0.05;

// ── Kling text-to-video (legacy) ─────────────────────────────────────────────
export const KLING_USD_PER_SEC = 0.06;

// ── Image generation ─────────────────────────────────────────────────────────
export const IMAGE_COST_RUNWAY    = 0.05;   // Runway per image
export const IMAGE_COST_FAL       = 0.04;   // fal.ai flux per image
export const IMAGE_COST_REPLICATE = 0.05;   // Replicate SDXL per image
export const IMAGE_COST_COMFYUI   = 0.01;   // self-hosted marginal cost

// ── Credit conversion ─────────────────────────────────────────────────────────
export const CREDITS_PER_USD = 100;         // 1 credit = $0.01

export function creditsFromUsd(costUsd: number): number {
  return Math.max(1, Math.ceil(costUsd * CREDITS_PER_USD));
}

// ── Cost calculators ──────────────────────────────────────────────────────────

export function gptunnelCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens  / 1_000) * GPTUNNEL_INPUT_PER_1K_TOKENS
       + (completionTokens / 1_000) * GPTUNNEL_OUTPUT_PER_1K_TOKENS;
}

export function openAiCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens  / 1_000) * OPENAI_INPUT_PER_1K_TOKENS
       + (completionTokens / 1_000) * OPENAI_OUTPUT_PER_1K_TOKENS;
}

export function heygenCostUsd(durationSec: number): number {
  return durationSec * HEYGEN_USD_PER_SEC;
}

export function runwayCostUsd(durationSec: number): number {
  return durationSec * RUNWAY_USD_PER_SEC;
}

export function klingCostUsd(durationSec: number): number {
  return durationSec * KLING_USD_PER_SEC;
}

export function imageGenCostUsd(provider: string): number {
  if (provider === 'runway')    return IMAGE_COST_RUNWAY;
  if (provider === 'replicate') return IMAGE_COST_REPLICATE;
  if (provider === 'comfyui')   return IMAGE_COST_COMFYUI;
  return IMAGE_COST_FAL;
}
