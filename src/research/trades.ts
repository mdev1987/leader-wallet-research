/**
 * Convert Helius full transactions into conservative wallet trade records.
 *
 * The parser intentionally uses token balance deltas plus the combined native
 * SOL/WSOL delta. It is a robust first-pass attribution method, but its price
 * is labeled `balance-delta` because SOL can move for unrelated instructions.
 */

import type { RawTransaction, Trade } from "../types";
import { pubkeyOf } from "../utils";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

function tokenDeltasByOwner(
  tx: RawTransaction,
  mint: string,
): Map<string, { delta: bigint; decimals: number }> {
  const result = new Map<string, { delta: bigint; decimals: number }>();

  for (const entry of tx.meta.preTokenBalances ?? []) {
    if (entry.mint !== mint || !entry.owner) continue;
    const current = result.get(entry.owner) ?? {
      delta: 0n,
      decimals: entry.uiTokenAmount.decimals,
    };
    current.delta -= BigInt(entry.uiTokenAmount.amount);
    current.decimals = entry.uiTokenAmount.decimals;
    result.set(entry.owner, current);
  }

  for (const entry of tx.meta.postTokenBalances ?? []) {
    if (entry.mint !== mint || !entry.owner) continue;
    const current = result.get(entry.owner) ?? {
      delta: 0n,
      decimals: entry.uiTokenAmount.decimals,
    };
    current.delta += BigInt(entry.uiTokenAmount.amount);
    current.decimals = entry.uiTokenAmount.decimals;
    result.set(entry.owner, current);
  }

  return result;
}

function solLegDeltaLamports(
  tx: RawTransaction,
  walletIndex: number,
  wallet: string,
): number | null {
  const preSol = tx.meta.preBalances[walletIndex];
  const postSol = tx.meta.postBalances[walletIndex];
  if (preSol === undefined || postSol === undefined) return null;

  let delta = postSol - preSol;

  const wsol = tokenDeltasByOwner(tx, WSOL_MINT).get(wallet);
  if (wsol && wsol.delta !== 0n) {
    delta += Number(wsol.delta);
  }

  return delta;
}

/**
 * Why a transaction (or one of its token legs) produced no trade.
 * Used by src/diagnose.ts to histogram parse coverage; the hot path passes
 * no callback and behaves exactly as before.
 */
export type ParseSkipReason =
  | "bad_tx"
  | "no_account_keys"
  | "no_signature"
  | "zero_token_delta"
  | "owner_not_in_account_keys"
  | "missing_sol_balances"
  | "zero_sol_delta"
  | "same_direction_legs"
  | "fee_consumed_amount"
  | "invalid_trade";

/** Parse all target-token owners that have a clear opposing SOL leg. */
export function parseTrades(
  tx: RawTransaction,
  tokenMint: string,
  onSkip?: (reason: ParseSkipReason) => void,
): Trade[] {
  if (tx.meta.err !== null || tx.blockTime === null) {
    onSkip?.("bad_tx");
    return [];
  }

  const accountKeys = tx.transaction.message.accountKeys.map(pubkeyOf);
  if (accountKeys.length === 0) {
    onSkip?.("no_account_keys");
    return [];
  }

  const signature = tx.transaction.signatures?.[0];
  if (!signature) {
    onSkip?.("no_signature");
    return [];
  }

  const tokenDeltas = tokenDeltasByOwner(tx, tokenMint);
  const feePayer = accountKeys[0];
  const trades: Trade[] = [];

  for (const [wallet, tokenInfo] of tokenDeltas) {
    if (tokenInfo.delta === 0n) {
      onSkip?.("zero_token_delta");
      continue;
    }

    const walletIndex = accountKeys.indexOf(wallet);
    if (walletIndex < 0) {
      onSkip?.("owner_not_in_account_keys");
      continue;
    }

    const solDelta = solLegDeltaLamports(tx, walletIndex, wallet);
    if (solDelta === null) {
      onSkip?.("missing_sol_balances");
      continue;
    }
    if (solDelta === 0) {
      onSkip?.("zero_sol_delta");
      continue;
    }

    // Only the fee payer's SOL leg needs explicit transaction-fee correction.
    const fee = wallet === feePayer ? tx.meta.fee : 0;

    let side: "buy" | "sell";
    let solLamports: number;

    if (tokenInfo.delta > 0n && solDelta < 0) {
      side = "buy";
      solLamports = -solDelta - fee;
    } else if (tokenInfo.delta < 0n && solDelta > 0) {
      side = "sell";
      solLamports = solDelta + fee;
    } else {
      onSkip?.("same_direction_legs");
      continue;
    }

    if (solLamports <= 0) {
      onSkip?.("fee_consumed_amount");
      continue;
    }

    const rawTokenAmount =
      tokenInfo.delta < 0n ? -tokenInfo.delta : tokenInfo.delta;
    const tokenAmount =
      Number(rawTokenAmount) / 10 ** tokenInfo.decimals;
    const solAmount = solLamports / 1e9;

    if (!(tokenAmount > 0) || !(solAmount > 0)) {
      onSkip?.("invalid_trade");
      continue;
    }

    trades.push({
      token: tokenMint,
      timestamp: tx.blockTime,
      side,
      wallet,
      tokenAmount,
      solAmount,
      priceSol: solAmount / tokenAmount,
      signature,
      slot: tx.slot,
      priceQuality: "balance-delta",
      isSigner: wallet === feePayer,
    });
  }

  return trades;
}
