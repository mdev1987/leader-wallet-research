/**
 * DexScreener keyless fallback price path.
 *
 * While Birdeye is cooling down (spent quota), the worker keeps detecting
 * events and labeling forward returns from DexScreener spot samples instead
 * of stalling. One batch request per scan cycle covers every watched token —
 * trivial load against the free tier, with its own polite rate limiter so
 * the fallback can never hammer.
 *
 * Resolution caveat: samples arrive roughly once per scan cycle (~30s) and
 * are bucketed into synthetic candles, so the same detector thresholds run
 * at much coarser resolution than Birdeye 1s candles. Rows produced this way
 * carry forwardBasis "dex" (USD closes, same denomination as "candle").
 */

import { config } from "../config";
import type { Candle } from "../types";
import { median, sleep, toNumber } from "../utils";

const BASE_URL = "https://api.dexscreener.com";
const CHAIN = "solana";

class RateLimiter {
  private nextAllowedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const delay = Math.max(0, this.nextAllowedAt - Date.now());
    if (delay > 0) await sleep(delay);
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }
}

const limiter = new RateLimiter(config.dex.minIntervalMs);

export class DexscreenerError extends Error {
  readonly rateLimited: boolean;

  constructor(message: string, rateLimited = false) {
    super(message);
    this.name = "DexscreenerError";
    this.rateLimited = rateLimited;
  }
}

export type DexQuote = {
  mint: string;
  priceUsd: number;
  volumeH24Usd: number;
  liquidityUsd: number;
  pairAddress: string;
  sampledAt: number;
};

type DexPair = {
  baseToken?: { address?: string };
  priceUsd?: string | null;
  volume?: { h24?: number };
  liquidity?: { usd?: number | null };
  pairAddress?: string;
};

/** Pick the highest-liquidity pair quoting this mint as base. */
function selectPair(pairs: DexPair[], mint: string): DexPair | null {
  let best: DexPair | null = null;
  let bestLiquidity = -1;

  for (const pair of pairs) {
    if (pair.baseToken?.address !== mint) continue;
    const price = toNumber(pair.priceUsd, NaN);
    if (!Number.isFinite(price) || price <= 0) continue;
    const liquidity = toNumber(pair.liquidity?.usd, 0);
    if (liquidity > bestLiquidity) {
      bestLiquidity = liquidity;
      best = pair;
    }
  }

  return best;
}

/**
 * Batch spot quotes for up to 30 mints in ONE request.
 * Never retries: a failing fallback must degrade silently, not hammer.
 */
export async function fetchQuotes(mints: string[]): Promise<Map<string, DexQuote>> {
  const quotes = new Map<string, DexQuote>();
  if (mints.length === 0) return quotes;

  await limiter.wait();

  const response = await fetch(
    `${BASE_URL}/tokens/v1/${CHAIN}/${mints.slice(0, 30).join(",")}`,
    { headers: { accept: "application/json" } },
  );

  if (response.status === 429) {
    throw new DexscreenerError(
      `DexScreener HTTP 429: rate limited`,
      true,
    );
  }
  if (!response.ok) {
    throw new DexscreenerError(
      `DexScreener HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const pairs = (await response.json()) as DexPair[];
  const sampledAt = Math.floor(Date.now() / 1000);

  for (const mint of mints) {
    const pair = selectPair(pairs, mint);
    if (!pair) continue;
    quotes.set(mint, {
      mint,
      priceUsd: toNumber(pair.priceUsd, NaN),
      volumeH24Usd: toNumber(pair.volume?.h24, 0),
      liquidityUsd: toNumber(pair.liquidity?.usd, 0),
      pairAddress: pair.pairAddress ?? "",
      sampledAt,
    });
  }

  return quotes;
}

export type DexSample = { time: number; priceUsd: number; volumeH24Usd: number };

/**
 * In-memory ring buffer of spot samples, bucketed into synthetic candles.
 * Interval volume is approximated from rolling-h24 differences (noisy by
 * construction); the detector does not gate on volume, so this only feeds
 * the recorded volumeAcceleration context.
 */
export class DexSampler {
  private readonly samples = new Map<string, DexSample[]>();

  /** Poll every watched token; failures are logged and skipped. */
  async sample(mints: string[]): Promise<number> {
    if (!config.dex.enabled || mints.length === 0) return 0;

    let quotes: Map<string, DexQuote>;
    try {
      quotes = await fetchQuotes(mints);
    } catch (error) {
      console.warn(
        `[dex] spot poll failed: ${error instanceof Error ? error.message.slice(0, 150) : String(error).slice(0, 150)}`,
      );
      return 0;
    }

    for (const [mint, quote] of quotes) {
      const series = this.samples.get(mint) ?? [];
      series.push({
        time: quote.sampledAt,
        priceUsd: quote.priceUsd,
        volumeH24Usd: quote.volumeH24Usd,
      });
      while (series.length > config.dex.maxSamplesPerToken) series.shift();
      this.samples.set(mint, series);
    }

    return quotes.size;
  }

  /** Bucket samples into candles of config.dex.candleBucketSec width. */
  candles(mint: string, from: number, to: number): Candle[] {
    const series = (this.samples.get(mint) ?? []).filter(
      (s) => s.time >= from && s.time <= to && s.priceUsd > 0,
    );
    if (series.length === 0) return [];

    const bucketSec = config.dex.candleBucketSec;
    const buckets = new Map<number, DexSample[]>();
    for (const sample of series) {
      const bucket = Math.floor(sample.time / bucketSec) * bucketSec;
      const list = buckets.get(bucket) ?? [];
      list.push(sample);
      buckets.set(bucket, list);
    }

    const candles: Candle[] = [];
    for (const [time, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const close = median(list.map((s) => s.priceUsd));
      if (close === null || close <= 0) continue;
      const first = list[0];
      const last = list[list.length - 1];
      const intervalVolume =
        first && last
          ? Math.max(0, last.volumeH24Usd - first.volumeH24Usd)
          : 0;
      candles.push({
        unixTime: time,
        open: close,
        high: close,
        low: close,
        close,
        volumeUsd: intervalVolume,
      });
    }

    return candles;
  }

  sampleCount(mint: string): number {
    return this.samples.get(mint)?.length ?? 0;
  }
}
