/**
 * Birdeye client used for two research jobs:
 * 1. Discover a small candidate universe of actively moving Solana tokens.
 * 2. Fetch 1-second USD OHLCV for local pump/dump event detection.
 *
 * Birdeye is deliberately the only price/event source in the live worker.
 * DexScreener is not used for event timing because its keyless spot endpoint is
 * much coarser than the 1s OHLCV needed for this research.
 */

import { config } from "../config";
import type { Candle, TokenCandidate } from "../types";
import { sleep, toNumber } from "../utils";

const BASE_URL = "https://public-api.birdeye.so";

export class BirdeyeError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly quotaExhausted: boolean;

  constructor(
    status: number,
    message: string,
    retryAfterMs: number,
    quotaExhausted = false,
  ) {
    super(message);
    this.name = "BirdeyeError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.quotaExhausted = quotaExhausted;
  }
}

export function isBirdeyeRateLimit(error: unknown): error is BirdeyeError {
  return error instanceof BirdeyeError;
}

class RateLimiter {
  private nextAllowedAt = 0;

  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const delay = Math.max(0, this.nextAllowedAt - Date.now());
    if (delay > 0) await sleep(delay);
    this.nextAllowedAt = Date.now() + this.intervalMs;
  }
}

const limiter = new RateLimiter(config.birdeye.minIntervalMs);

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, config.birdeye.maxRetryMs);
  }

  return Math.min(
    config.birdeye.baseRetryMs * 2 ** Math.min(attempt, 4),
    config.birdeye.maxRetryMs,
  );
}

function isQuotaMessage(text: string): boolean {
  return /compute units|quota/i.test(text);
}

function requireApiKey(): string {
  if (!config.api.birdeyeKey) throw new Error("Missing BIRDEYE_API_KEY");
  return config.api.birdeyeKey;
}

async function requestJson<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  for (let attempt = 0; attempt <= config.birdeye.maxRetries; attempt += 1) {
    await limiter.wait();

    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "X-API-KEY": requireApiKey(),
        "x-chain": "solana",
      },
    });

    if (response.ok) {
      const json = (await response.json()) as T & {
        success?: boolean;
        message?: string;
      };

      if (json.success === false) {
        const message = json.message ?? "Birdeye request failed";
        if (/rate limit|too many requests|compute units/i.test(message)) {
          if (isQuotaMessage(message)) {
            throw new BirdeyeError(
              response.status,
              message,
              config.birdeye.quotaCooldownMs,
              true,
            );
          }

          const delay = Math.min(
            config.birdeye.baseRetryMs * 2 ** Math.min(attempt, 4),
            config.birdeye.maxRetryMs,
          );
          if (attempt < config.birdeye.maxRetries) {
            await sleep(delay);
            continue;
          }
          throw new BirdeyeError(response.status, message, delay);
        }
        throw new Error(`Birdeye error: ${message}`);
      }

      return json;
    }

    const body = await response.text().catch(() => "");
    const limited = response.status === 429 || /rate limit|too many requests/i.test(body);

    if (limited && attempt < config.birdeye.maxRetries) {
      const delay = retryDelay(response, attempt);
      await sleep(delay);
      continue;
    }

    throw new BirdeyeError(
      response.status,
      `Birdeye HTTP ${response.status}: ${body.slice(0, 300) || response.statusText}`,
      retryDelay(response, attempt),
      isQuotaMessage(body),
    );
  }

  throw new Error("Birdeye request exhausted retries");
}

/** Discover a compact Solana token universe using activity/momentum filters. */
export async function discoverTokens(): Promise<TokenCandidate[]> {
  const response = await requestJson<{
    data?: {
      items?: Array<Record<string, unknown>>;
      has_next?: boolean;
      next_scroll_id?: string;
    };
  }>("/defi/v3/token/list/scroll", {
    sort_by: config.discovery.sortBy,
    sort_type: config.discovery.sortType,
    min_liquidity: String(config.discovery.minLiquidityUsd),
    min_volume_1h_usd: String(config.discovery.minVolume1hUsd),
    min_trade_1h_count: String(config.discovery.minTrade1hCount),
    limit: String(config.discovery.limit),
  });

  return (response.data?.items ?? [])
    .map((item) => ({
      address: String(item.address ?? ""),
      symbol: String(item.symbol ?? ""),
      name: String(item.name ?? item.symbol ?? ""),
      liquidityUsd: toNumber(item.liquidity),
      volume1hUsd: toNumber(item.volume_1h_usd),
      trade1hCount: toNumber(item.trade_1h_count),
      recentListingTime: toNumber(item.recent_listing_time, NaN),
    }))
    .filter(
      (token) =>
        token.address.length > 20 &&
        token.liquidityUsd >= config.discovery.minLiquidityUsd &&
        token.volume1hUsd >= config.discovery.minVolume1hUsd,
    )
    .slice(0, config.discovery.maxTokens);
}

/** Fetch 1-second USD OHLCV for a token and return chronologically sorted candles. */
export async function fetchCandles(
  address: string,
  timeFrom: number,
  timeTo: number,
): Promise<Candle[]> {
  const response = await requestJson<{
    data?: {
      items?: Array<{
        unix_time: number;
        o: number;
        h: number;
        l: number;
        c: number;
        v?: number;
        v_usd?: number;
      }>;
    };
  }>("/defi/v3/ohlcv", {
    address,
    type: "1s",
    currency: "usd",
    time_from: String(Math.floor(timeFrom)),
    time_to: String(Math.floor(timeTo)),
    mode: "range",
    padding: "false",
  });

  return (response.data?.items ?? [])
    .map((item) => ({
      unixTime: toNumber(item.unix_time),
      open: toNumber(item.o),
      high: toNumber(item.h),
      low: toNumber(item.l),
      close: toNumber(item.c),
      volumeUsd: toNumber(item.v_usd ?? item.v),
    }))
    .filter((candle) => candle.unixTime > 0 && candle.close > 0)
    .sort((a, b) => a.unixTime - b.unixTime);
}
