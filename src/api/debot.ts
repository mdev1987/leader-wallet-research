/**
 * Debot community-signal discovery provider.
 *
 * Keyless channel-activity ranking (5m sustained + 1m ignition windows):
 * tokens drawing community call attention right now, with market cap,
 * liquidity, volume, holder and swap counts plus smart-wallet presence.
 * Only duration=5m/1m are supported upstream; others return code 1.
 *
 * Supplies the candidate *universe* only — event timing stays on Birdeye 1s
 * OHLCV and attribution on Helius, so the single-price-source policy holds.
 * Ordered before DBotX in the provider chain: it is free (saves DBotX
 * credits when it yields) and its attention + smart-wallet fields match the
 * research goal more closely than raw new-token flow.
 */

import { config } from "../config";
import type { TokenCandidate } from "../types";
import { sleep, toNumber } from "../utils";

const BASE_URL = "https://debot.ai";
const CHAIN = "solana";

export class DebotError extends Error {
  readonly status: number;
  /** True for credential/plan blocks: retrying cannot help. */
  readonly auth: boolean;

  constructor(status: number, message: string, auth = false) {
    super(message);
    this.name = "DebotError";
    this.status = status;
    this.auth = auth;
  }
}

export function isDebotAuthError(error: unknown): error is DebotError {
  return error instanceof DebotError && error.auth;
}

class RateLimiter {
  private nextAllowedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const delay = Math.max(0, this.nextAllowedAt - Date.now());
    if (delay > 0) await sleep(delay);
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }
}

const limiter = new RateLimiter(config.debot.minIntervalMs);

export type DebotRankedToken = Record<string, unknown>;

function marketInfo(pool: DebotRankedToken): Record<string, unknown> {
  const info = pool.market_info;
  return !!info && typeof info === "object" ? (info as Record<string, unknown>) : {};
}

function pairLiquidity(pool: DebotRankedToken): number {
  const summary = pool.pair_summary_info;
  if (!summary || typeof summary !== "object") return 0;
  return toNumber((summary as Record<string, unknown>).liquidity, 0);
}

/** Channel-activity ranking for one chain. Only duration=5m/1m are supported upstream. */
export async function fetchActivityRank(
  limit: number,
  duration: "5m" | "1m" = "5m",
): Promise<DebotRankedToken[]> {
  await limiter.wait();

  const url =
    `${BASE_URL}/api/community/signal/channel/activity/rank` +
    `?chain=${CHAIN}&limit=${Math.max(1, Math.floor(limit))}&duration=${duration}`;

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(config.http.requestTimeoutMs),
  });

  if (response.status === 401 || response.status === 403 || response.status === 429) {
    throw new DebotError(response.status, `Debot HTTP ${response.status}`, response.status !== 429);
  }
  if (!response.ok) {
    throw new DebotError(response.status, `Debot HTTP ${response.status}: ${response.statusText}`);
  }

  const json = (await response.json()) as {
    code?: number;
    description?: string;
    data?: unknown;
  };
  if (json.code !== 0 || !Array.isArray(json.data)) {
    throw new DebotError(
      response.status,
      `Debot error: ${String(json.description ?? "unexpected response")}`.slice(0, 200),
    );
  }
  return json.data.filter((row): row is DebotRankedToken => !!row && typeof row === "object");
}

/**
 * Map one ranked row to a candidate, or null when unusable/filtered.
 * All units are native to the response (USD market cap/liquidity/volume);
 * every access is defensive because row shapes vary.
 */
export function toCandidate(pool: DebotRankedToken, nowMs: number): TokenCandidate | null {
  const address = String(pool.address ?? "");
  if (address.length <= 20) return null;

  const info = marketInfo(pool);
  const marketCap = toNumber(info.mkt_cap, 0);
  const holders = toNumber(info.holders, 0);
  const liquidity = pairLiquidity(pool);
  const createdAt = toNumber(pool.creation_timestamp, 0);
  const ageHours = createdAt > 0 ? (nowMs - createdAt * 1000) / 3_600_000 : Infinity;

  if (marketCap < config.debot.minMarketCapUsd) return null;
  if (holders < config.debot.minHolders) return null;
  if (liquidity < config.debot.minLiquidityUsd) return null;
  if (ageHours > config.debot.maxAgeHours) return null;

  const pairAddress = String(pool.pair ?? "");

  return {
    address,
    symbol: String(pool.symbol ?? address.slice(0, 8)),
    name: String(pool.name ?? pool.symbol ?? address.slice(0, 8)),
    liquidityUsd: liquidity,
    // 5m-window volume/swaps: best activity proxy available, not 1h figures.
    volume1hUsd: toNumber(info.volume, 0),
    trade1hCount: toNumber(info.swaps, 0),
    ...(pairAddress.length > 20 ? { pairAddress } : {}),
  };
}

/**
 * One discovery cycle over the activity ranking. Empty when nothing passes
 * the filters — a quiet market is normal, the chain falls through.
 */
/**
 * Merge two ranking windows, 5m (sustained attention) first, then 1m-only
 * additions (fresh ignition). Pure function: dedupes by mint, keeps order.
 */
export function mergeRankings(
  sustained: DebotRankedToken[],
  ignition: DebotRankedToken[],
): DebotRankedToken[] {
  const seen = new Set<string>();
  const merged: DebotRankedToken[] = [];
  for (const row of [...sustained, ...ignition]) {
    const address = String(row.address ?? "");
    if (address.length <= 20 || seen.has(address)) continue;
    seen.add(address);
    merged.push(row);
  }
  return merged;
}

/** Current SOL/USD reference for reserve conversion (context use only). */
export async function fetchSolPriceUsd(): Promise<number> {
  const response = await fetch(`${BASE_URL}/api/market/price_state`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(config.http.requestTimeoutMs),
  });
  if (!response.ok) throw new DebotError(response.status, `Debot HTTP ${response.status}`);
  const json = (await response.json()) as {
    code?: number;
    data?: Record<string, { close?: string }>;
  };
  const price = toNumber(json.data?.SOLUSDT?.close, NaN);
  if (!Number.isFinite(price) || price <= 0) {
    throw new DebotError(response.status, "Debot price_state missing SOLUSDT");
  }
  return price;
}

export async function discoverDebotTokens(): Promise<TokenCandidate[]> {
  const sustained = await fetchActivityRank(config.discovery.maxTokens * 2, "5m");
  const ignition = await fetchActivityRank(config.discovery.maxTokens, "1m");
  const rows = mergeRankings(sustained, ignition);
  const nowMs = Date.now();
  const seen = new Set<string>();
  const candidates: TokenCandidate[] = [];

  for (const pool of rows) {
    const token = toCandidate(pool, nowMs);
    if (!token || seen.has(token.address)) continue;
    seen.add(token.address);
    candidates.push(token);
    if (candidates.length >= config.discovery.maxTokens) break;
  }

  console.log(
    `[discovery] debot ranked5m=${sustained.length} ranked1m=${ignition.length} ` +
      `merged=${rows.length} qualified=${candidates.length}`,
  );
  return candidates;
}
