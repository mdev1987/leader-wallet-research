/**
 * DBotX discovery provider.
 *
 * Used when Birdeye token-list discovery is plan-blocked. Supplies the
 * candidate *universe* only — event timing stays on Birdeye 1s OHLCV and
 * attribution on Helius, so the single-price-source research policy holds.
 *
 * Two feeds are merged per cycle: hot pools (trade activity) and surging
 * meme pools (recent market-cap expansion). Each costs 10 DBotX credits,
 * so one discovery cycle costs ~20 credits.
 */

import { config } from "../config";
import type { TokenCandidate } from "../types";
import { sleep, toNumber } from "../utils";
import { fetchSolPriceUsd } from "./debot";

const BASE_URL = "https://api-data-v1.dbotx.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export class DbotxError extends Error {
  readonly status: number;
  /** True for credential/plan blocks: retrying cannot help. */
  readonly auth: boolean;

  constructor(status: number, message: string, auth = false) {
    super(message);
    this.name = "DbotxError";
    this.status = status;
    this.auth = auth;
  }
}

export function isDbotxAuthError(error: unknown): error is DbotxError {
  return error instanceof DbotxError && error.auth;
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

const limiter = new RateLimiter(config.dbotx.minIntervalMs);

export type DbotxPool = Record<string, unknown>;

function requireApiKey(): string {
  const key = config.api.dbotxKey;
  if (!key) throw new DbotxError(0, "Missing DBOTX_API_KEY", true);
  return key;
}

async function getPools(path: string, params: Record<string, string>): Promise<DbotxPool[]> {
  await limiter.wait();

  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": requireApiKey() },
    signal: AbortSignal.timeout(config.http.requestTimeoutMs),
  });

  if (response.status === 401 || response.status === 403) {
    throw new DbotxError(response.status, "DBotX key rejected (plan tier?)", true);
  }
  if (!response.ok) {
    throw new DbotxError(response.status, `DBotX HTTP ${response.status}: ${response.statusText}`);
  }

  const json = (await response.json()) as { err?: boolean; res?: unknown };
  if (json.err === true || !Array.isArray(json.res)) {
    throw new DbotxError(response.status, "DBotX error response");
  }
  return json.res.filter((row): row is DbotxPool => !!row && typeof row === "object");
}

/** Hot pools sorted by 1h trade activity. */
export function fetchHotPools(): Promise<DbotxPool[]> {
  return getPools("/kline/hot", {
    chain: "solana",
    sortBy: "buyAndSellTimes",
    sort: "-1",
    interval: "1h",
  });
}

/** Meme pools with recent market-cap expansion. Empty when nothing surges. */
export function fetchSurgingPools(): Promise<DbotxPool[]> {
  return getPools("/kline/meme", {
    chain: "solana",
    sortBy: "marketCapChange5m",
    sort: "-1",
    interval: "1h",
    status: "surging",
  });
}

type SolPriceCache = { price: number; at: number };
let solPriceCache: SolPriceCache | null = null;

/**
 * SOL/USD for reserve conversion: Debot price_state first, keyless
 * DexScreener as fallback, cached 1h. Context/filter use only — never event
 * timing. NaN when unavailable, in which case liquidity falls back to 0 and
 * the reserve filter decides.
 */
export async function getSolPriceUsd(): Promise<number> {
  if (solPriceCache && Date.now() - solPriceCache.at < 3_600_000) {
    return solPriceCache.price;
  }

  try {
    const price = await fetchSolPriceUsd();
    solPriceCache = { price, at: Date.now() };
    return price;
  } catch (error) {
    console.warn(
      `[dbotx] Debot SOL price failed, trying DexScreener: ${error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100)}`,
    );
  }

  try {
    const response = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(config.http.requestTimeoutMs),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pairs = (await response.json()) as Array<{ priceUsd?: string | null }>;
    const price = toNumber(pairs[0]?.priceUsd, NaN);
    if (Number.isFinite(price) && price > 0) {
      solPriceCache = { price, at: Date.now() };
      return price;
    }
  } catch (error) {
    console.warn(
      `[dbotx] SOL price lookup failed: ${error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100)}`,
    );
  }
  return solPriceCache?.price ?? NaN;
}

/**
 * Map one DBotX pool row to a candidate. Returns null when the row is
 * unusable or fails the configured universe filters. Field shapes vary
 * between feeds, so every access is defensive with explicit fallbacks.
 */
export function toCandidate(
  pool: DbotxPool,
  solPriceUsd: number,
  nowMs: number,
): TokenCandidate | null {
  const address = String(pool.token ?? pool.mint ?? "");
  if (address.length <= 20) return null;

  const marketCap = toNumber(pool.marketCap, 0);
  const holders = toNumber(pool.holders, 0);
  const solReserve = toNumber(pool.solReserve ?? pool.currencyReserve, 0);
  const createdAt = toNumber(pool.tokenCreatedAt ?? pool.createdAt, 0);
  const ageHours = createdAt > 0 ? (nowMs - createdAt) / 3_600_000 : Infinity;

  if (marketCap < config.dbotx.minMarketCapUsd) return null;
  if (holders < config.dbotx.minHolders) return null;
  if (solReserve < config.dbotx.minSolReserve) return null;
  if (ageHours > config.dbotx.maxAgeHours) return null;

  const pairAddress = String(pool.pair ?? pool.id ?? "");

  return {
    address,
    symbol: String(pool.symbol ?? address.slice(0, 8)),
    name: String(pool.name ?? pool.symbol ?? address.slice(0, 8)),
    liquidityUsd: Number.isFinite(solPriceUsd) && solPriceUsd > 0
      ? solReserve * solPriceUsd
      : 0,
    // DBotX volume units are ambiguous across feeds; trade counts are not.
    volume1hUsd: toNumber(pool.buyAndSellVolume1h, 0),
    trade1hCount: toNumber(pool.buyAndSellTimes1h ?? pool.buyAndSellTimes, 0),
    ...(pairAddress.length > 20 ? { pairAddress } : {}),
  };
}

/**
 * One discovery cycle across both feeds: fetch, map, filter, dedupe
 * (hot first), cap. Throws on transport/auth failure; empty feeds are a
 * normal quiet-market result, not an error.
 */
export async function discoverDbotxTokens(): Promise<TokenCandidate[]> {
  const [hot, surging] = await Promise.all([fetchHotPools(), fetchSurgingPools()]);
  const solPriceUsd = await getSolPriceUsd();
  const nowMs = Date.now();
  const seen = new Set<string>();
  const candidates: TokenCandidate[] = [];

  for (const pool of [...hot, ...surging]) {
    const token = toCandidate(pool, solPriceUsd, nowMs);
    if (!token || seen.has(token.address)) continue;
    seen.add(token.address);
    candidates.push(token);
    if (candidates.length >= config.discovery.maxTokens) break;
  }

  console.log(
    `[discovery] dbotx hot=${hot.length} surging=${surging.length} ` +
      `qualified=${candidates.length}`,
  );
  return candidates;
}
