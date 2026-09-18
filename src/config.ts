/**
 * Central configuration for the pump-window wallet research scanner.
 *
 * Keep strategy-like thresholds here so they can later be optimized without
 * changing the collection and parsing code.
 */

export const config = {
  discovery: {
    // Spaced out so a later run does not hammer Birdeye CU limits.
    everyMs: 5 * 60_000,
    maxActiveTokens: 5,
    candidateTtlMs: 15 * 60_000,
    minLiquidityUsd: 25_000,
    minVolume1hUsd: 50_000,
    minTrade1hCount: 300,
  },

  birdeye: {
    // Starter plans throttle well below 1 RPS on heavy endpoints
    // (token-list, 1s OHLCV), so default to 1 req / 2s + retries.
    minIntervalMs: 2_000,
    scanEveryMs: 30_000,
    candleLookbackSec: 3 * 60,
    maxRetries: 4,
    baseRetryDelayMs: 2_000,
    maxRetryDelayMs: 30_000,
    // After an explicit 429 / CU-limit, skip Birdeye calls for this long.
    rateLimitCooldownMs: 90_000,
    // Spent compute-unit quota: retries cannot help, so back off long and
    // let the DexScreener fallback carry detection until the budget refills.
    quotaCooldownMs: 30 * 60_000,
  },

  dex: {
    // Keyless fallback price path while Birdeye is cooling down. One batch
    // spot request per scan cycle — trivial load against the free tier.
    enabled: true,
    minIntervalMs: 2_000,
    // Spot samples are bucketed into candles of this width. Coarser than
    // Birdeye 1s candles: same detector thresholds, lower resolution.
    candleBucketSec: 30,
    // Per-token ring buffer cap (~4h at one sample per 30s cycle).
    maxSamplesPerToken: 480,
  },

  event: {
    moveSec: 60,
    movePct: 12,
    accelerationSec: 15,
    accelerationPct: 3,
    cooldownSec: 20 * 60,
  },

  analysis: {
    preSec: 180,
    postSec: 30,
    forwardOffsetsSec: [5, 15, 30, 60],
  },

  report: {
    minLeaderEvents: 3,
    minLeaderTokens: 2,
    // A wallet's event counts only when its dominant side there reaches
    // this fraction. Pool/MM legs (~50/50 by construction) never qualify.
    minDirectionConsistency: 0.8,
  },

  eval: {
    // Time-ordered train/valid split for src/eval.ts: earliest 70% of
    // events train candidate selection, latest 30% validate it.
    trainFrac: 0.7,
  },

  output: {
    dir: "./data",
    events: "events.jsonl",
    observations: "wallet_observations.jsonl",
    leaders: "leader_wallets.json",
  },
} as const;

export const api = {
  birdeyeKey: Bun.env.BIRDEYE_API_KEY,
  heliusKey: Bun.env.HELIUS_API_KEY,
};

if (!api.birdeyeKey) throw new Error("Missing BIRDEYE_API_KEY");
if (!api.heliusKey) throw new Error("Missing HELIUS_API_KEY");
