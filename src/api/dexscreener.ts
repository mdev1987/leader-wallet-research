/**
 * Keyless DexScreener metadata client.
 *
 * This client is intentionally metadata-only: token-pairs is used to obtain
 * deterministic pair addresses for wallet labeling. It never supplies event
 * timestamps, forward returns, or other price labels.
 */

import type { TokenPairMetadata } from "../types";

const BASE_URL = "https://api.dexscreener.com";
const CHAIN = "solana";

export class DexscreenerMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DexscreenerMetadataError";
  }
}

/** Fetch all token pairs for one Solana mint with one keyless request. */
export async function fetchTokenPairs(tokenAddress: string): Promise<TokenPairMetadata[]> {
  const url = `${BASE_URL}/token-pairs/v1/${CHAIN}/${tokenAddress}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });

  if (!response.ok) {
    throw new DexscreenerMetadataError(
      `DexScreener HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const rows = (await response.json()) as unknown;
  if (!Array.isArray(rows)) return [];

  const result: TokenPairMetadata[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const pairAddress = typeof value.pairAddress === "string" ? value.pairAddress : "";
    if (!pairAddress) continue;

    const liquidity =
      value.liquidity && typeof value.liquidity === "object"
        ? (value.liquidity as Record<string, unknown>)
        : null;

    result.push({
      pairAddress,
      dexId: typeof value.dexId === "string" ? value.dexId : "",
      liquidityUsd:
        liquidity && typeof liquidity.usd === "number" ? liquidity.usd : null,
      baseTokenAddress:
        value.baseToken && typeof value.baseToken === "object"
          ? String((value.baseToken as Record<string, unknown>).address ?? "")
          : null,
      quoteTokenAddress:
        value.quoteToken && typeof value.quoteToken === "object"
          ? String((value.quoteToken as Record<string, unknown>).address ?? "")
          : null,
    });
  }

  return result;
}
