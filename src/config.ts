/** Central configuration for discovery, event detection, analysis and storage. */

export const config = {
  discovery: {
    everyMs: 5 * 60_000,
    maxTokens: 10,
    candidateTtlMs: 15 * 60_000,
    minLiquidityUsd: 25_000,
    minVolume1hUsd: 50_000,
    minTrade1hCount: 300,
    limit: 50,
    sortBy: "volume_1h_change_percent",
    sortType: "desc",
  },

  dbotx: {
    // Fallback discovery universe when Birdeye token-list is plan-blocked.
    // One cycle = hot + surging (~20 credits). Filters are intentionally
    // lenient: the feed skews to newborn thin tokens, the event detector
    // (continuous-window + discontinuity guard) does the real selection,
    // and DBotX omits holders/marketCap on most rows.
    enabled: true,
    minIntervalMs: 1_500,
    minMarketCapUsd: 0,
    minHolders: 0,
    minSolReserve: 0.1,
    maxAgeHours: 168,
  },

  debot: {
    // Keyless community-signal ranking (5m attention window). Ordered before
    // DBotX: free, and attention + smart-wallet presence match the research
    // goal better than raw new-token flow. Native USD units throughout.
    enabled: true,
    minIntervalMs: 2_000,
    minMarketCapUsd: 10_000,
    minHolders: 100,
    minLiquidityUsd: 5_000,
    maxAgeHours: 168,
  },

  birdeye: {
    minIntervalMs: 3_000,
    scanEveryMs: 20_000,
    maxRetries: 4,
    baseRetryMs: 2_000,
    maxRetryMs: 30_000,
    rateLimitCooldownMs: 90_000,
    quotaCooldownMs: 30 * 60_000,
    candleLookbackSec: 5 * 60,
    candleFetchPaddingSec: 10,
  },

  event: {
    moveSec: 60,
    accelerationSec: 15,
    minMovePct: 12,
    minAccelerationPct: 3,
    crashPct: 60,
    // Live Birdeye candles should be truly 1-second data. A larger replay
    // bridge is configured separately below because compact trade exports are sparse.
    maxCandleGapSec: 2,
    // Reject implausible one-second price jumps before classifying an event.
    // This protects research labels from balance-delta price artifacts.
    maxOneSecondMovePct: 50,
    // Inspect a short pre-event window before the proposed start so an
    // isolated bad sample cannot become the event's starting price.
    discontinuityLookbackSec: 15,
    breakoutFraction: 0.75,
    cooldownSec: 5 * 60,
    searchBackSec: 75,
    volumeBaselineSec: 120,
    volumeRecentSec: 15,
  },

  replay: {
    // Compact Helius trade exports are sparse. Carry the last trade price
    // forward for gaps up to this many seconds when reconstructing replay candles.
    maxCandleGapSec: 15,
  },

  analysis: {
    // Pre-event window used for leadership evidence.
    preSec: 180,
    // Post-confirmation tail. The full acceleration/breakout interval is always
    // included automatically by buildObservation before this tail.
    postSec: 30,
    forwardOffsetsSec: [5, 15, 30, 60],
    maxCandleGapSec: 3,
  },

  walletLabels: {
    // Add only explicitly verified program IDs. Pair addresses are populated
    // automatically per event from DexScreener token-pairs.
    knownPrograms: {} as Record<string, "router" | "program">,
  },

  report: {
    minWalletEvents: 3,
    minWalletTokens: 2,
    minValidationEvents: 2,
    topWallets: 100,
  },

  eval: {
    trainFrac: 0.7,
    // Wallet-shuffled null + bootstrap resamples. Seeded so reports are
    // reproducible. Cheap (O(valid entries) per resample); raise for
    // smoother tails once the dataset is large.
    permutationCount: 1000,
    randomSeed: 42,
  },

  storage: {
    dir: "./data",
    events: "events.jsonl",
    observations: "wallet_observations.jsonl",
    walletEvents: "wallet_events.jsonl",
    leaders: "leader_wallets.json",
    evaluation: "eval_report.json",
    candidates: "candidates.json",
  },

  api: {
    birdeyeKey: process.env.BIRDEYE_API_KEY,
    heliusKey: process.env.HELIUS_API_KEY,
    dbotxKey: process.env.DBOTX_API_KEY,
  },

  http: {
    // No fetch in this codebase may hang forever: a tarpitted response
    // stalls the worker loop silently (no log, no restart). Timeouts turn
    // stalls into visible, retriable errors.
    requestTimeoutMs: 30_000,
  },
} as const;
