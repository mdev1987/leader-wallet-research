/**
 * Birdeye REST client.
 *
 * Discovery uses the V3 token-list endpoint. Price-event detection uses the
 * V3 1-second OHLCV endpoint so the event detector can focus on short moves.
 */

import { api, config } from "../config";
import type { Candle, TokenCandidate } from "../types";
import { sleep, toNumber } from "../utils";

const BASE_URL = "https://public-api.birdeye.so";

class RateLimiter {
  private nextAllowedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const delay = Math.max(0, this.nextAllowedAt - Date.now());
    if (delay > 0) await sleep(delay);
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }
}

const limiter = new RateLimiter(config.birdeye.minIntervalMs);

/** Thrown when Birdeye signals rate / compute-unit limits. Retriable. */
export class BirdeyeRateLimitError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;

  constructor(status: number, message: string, retryAfterMs: number) {
    super(message);
    this.name = "BirdeyeRateLimitError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRateLimitError(error: unknown): error is BirdeyeRateLimitError {
  return error instanceof BirdeyeRateLimitError;
}

function parseRetryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const headerSec = header ? Number(header) : NaN;
  if (Number.isFinite(headerSec) && headerSec >= 0) {
    return Math.min(headerSec * 1000, config.birdeye.maxRetryDelayMs);
  }
  // Exponential backoff with jitter: 2s, 4s, 8s, ... capped.
  const backoff =
    config.birdeye.baseRetryDelayMs * 2 ** Math.min(attempt, 4);
  return Math.min(
    backoff + Math.floor(Math.random() * 500),
    config.birdeye.maxRetryDelayMs,
  );
}

/** True for 429 plus Birdeye's 400 CU-limit responses. */
function isRetriableResponse(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  return (
    status === 400 &&
    /compute units|too many requests|rate limit/i.test(bodyText)
  );
}

async function requestJson<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= config.birdeye.maxRetries; attempt++) {
    await limiter.wait();

    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "X-API-KEY": api.birdeyeKey!,
        "x-chain": "solana",
      },
    });

    if (response.ok) {
      const json = (await response.json()) as T & {
        success?: boolean;
        message?: string;
      };

      if (json.success === false) {
        const message = json.message ?? "unknown error";
        if (/compute units|too many requests|rate limit/i.test(message)) {
          const delay = Math.min(
            config.birdeye.baseRetryDelayMs * 2 ** Math.min(attempt, 4),
            config.birdeye.maxRetryDelayMs,
          );
          lastError = new BirdeyeRateLimitError(400, `Birdeye error: ${message}`, delay);
          await sleep(delay);
          continue;
        }
        throw new Error(`Birdeye error: ${message}`);
      }

      return json;
    }

    const bodyText = await response.text().catch(() => "");

    if (
      isRetriableResponse(response.status, bodyText) &&
      attempt < config.birdeye.maxRetries
    ) {
      const delay = parseRetryAfterMs(response, attempt);
      lastError = new BirdeyeRateLimitError(
        response.status,
        `Birdeye HTTP ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`,
        delay,
      );
      console.warn(
        `[ratelimit] Birdeye ${response.status} on ${path} ` +
          `(attempt ${attempt + 1}/${config.birdeye.maxRetries + 1}), ` +
          `retrying in ${(delay / 1000).toFixed(1)}s`,
      );
      await sleep(delay);
      continue;
    }

    if (isRetriableResponse(response.status, bodyText)) {
      throw new BirdeyeRateLimitError(
        response.status,
        `Birdeye HTTP ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`,
        parseRetryAfterMs(response, attempt),
      );
    }

    throw new Error(
      `Birdeye HTTP ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`,
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Birdeye request failed after retries");
}

/** Discover a small, high-activity Solana token universe. */
export async function discoverTokens(): Promise<TokenCandidate[]> {
  const response = await requestJson<{
    data?: {
      items?: Array<Record<string, unknown>>;
    };
  }>("/defi/v3/token/list", {
    sort_by: "volume_1h_change_percent",
    sort_type: "desc",
    min_liquidity: String(config.discovery.minLiquidityUsd),
    min_volume_1h_usd: String(config.discovery.minVolume1hUsd),
    min_trade_1h_count: String(config.discovery.minTrade1hCount),
    limit: "100",
  });

  return (response.data?.items ?? [])
    .map((item) => ({
      address: String(item.address ?? ""),
      symbol: String(item.symbol ?? ""),
      name: String(item.name ?? item.symbol ?? ""),
      liquidityUsd: toNumber(item.liquidity),
      volume1hUsd: toNumber(item.volume_1h_usd),
      trade1hCount: toNumber(item.trade_1h_count),
    }))
    .filter((token) => token.address.length > 20)
    .slice(0, config.discovery.maxActiveTokens);
}

/** Fetch 1-second OHLCV candles for one token. */
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
    time_from: String(timeFrom),
    time_to: String(timeTo),
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
