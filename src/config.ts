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
