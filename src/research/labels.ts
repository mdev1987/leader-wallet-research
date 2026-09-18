/**
 * Deterministic wallet labeling.
 *
 * Pair-address labels come from the DexScreener token-pairs response captured
 * for the event token. Known-program labels are configured explicitly. No
 * low-consistency or mixed-side heuristic is allowed to auto-promote a wallet
 * to market-maker/pool status; behavioral consistency remains a soft signal.
 */

import type { WalletLabel, WalletType, WalletTypeReason } from "../types";

export type KnownProgramMap = ReadonlyMap<string, "router" | "program">;

/** Wallet labels treated as infrastructure rather than trader evidence. */
export const INFRASTRUCTURE_WALLET_TYPES: ReadonlySet<WalletType> = new Set([
  "pool",
  "router",
  "program",
]);

/** True when the label identifies infrastructure that should not be promoted as a leader. */
export function isInfrastructureWalletType(type: WalletType | undefined): boolean {
  return type !== undefined && INFRASTRUCTURE_WALLET_TYPES.has(type);
}

export type WalletLabelContext = {
  poolAddresses: ReadonlySet<string>;
  knownPrograms?: KnownProgramMap;
  behavioralOverride?: WalletType;
};

export function classifyWallet(
  wallet: string,
  isSigner: boolean | undefined,
  context: WalletLabelContext,
): WalletLabel {
  if (context.poolAddresses.has(wallet)) {
    return { type: "pool", reason: "pair-address" };
  }

  const known = context.knownPrograms?.get(wallet);
  if (known) {
    return { type: known, reason: "known-program" };
  }

  if (context.behavioralOverride) {
    return { type: context.behavioralOverride, reason: "behavioral" };
  }

  // A signer that owns the target token is a trader candidate, but this is
  // intentionally weaker than an explicit pair/program label.
  if (isSigner === true) {
    return { type: "trader", reason: "default" };
  }

  return { type: "unknown", reason: "default" };
}

export function behavioralHint(
  buyCount: number,
  sellCount: number,
): "buy-dominant" | "sell-dominant" | "mixed-sides" | null {
  const total = buyCount + sellCount;
  if (total === 0) return null;
  if (buyCount === sellCount) return "mixed-sides";
  return buyCount > sellCount ? "buy-dominant" : "sell-dominant";
}
