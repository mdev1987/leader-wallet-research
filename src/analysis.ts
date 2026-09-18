/**
 * Pure research logic: event detection, transaction parsing and wallet metrics.
 *
 * No network calls or file IO belong here. Keeping this layer pure makes it
 * easy to replay the same analysis against historical CSV/JSONL data later.
 */

import { config } from "./config";
import type {
  Candle,
  DetectedEvent,
  EventType,
  RawTransaction,
  TokenCandidate,
  Trade,
  TradeSide,
  WalletObservation,
  WalletStats,
} from "./types";
import { median, pctChange, pubkeyOf } from "./utils";

/** Return the last candle at or before a timestamp. */
export function candleAtOrBefore(
  candles: Candle[],
  timestamp: number,
): Candle | null {
  let result: Candle | null = null;

  for (const candle of candles) {
    if (candle.unixTime > timestamp) break;
    result = candle;
  }

  return result;
}

/** Return the first candle at or after a timestamp. */
export function candleAtOrAfter(
  candles: Candle[],
  timestamp: number,
): Candle | null {
  for (const candle of candles) {
    if (candle.unixTime >= timestamp) return candle;
  }
  return null;
}

function meanVolume(candles: Candle[], from: number, to: number): number {
  const values = candles
    .filter((candle) => candle.unixTime >= from && candle.unixTime <= to)
    .map((candle) => candle.volumeUsd)
    .filter((value) => value > 0);

  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Detect the latest local pump or dump from 1-second candles. */
export function detectLatestEvent(
  token: TokenCandidate,
  candles: Candle[],
): DetectedEvent | null {
  if (
    candles.length <
    config.event.moveSec + config.event.accelerationSec + 10
  ) {
    return null;
  }

  const end = candles[candles.length - 1];
  if (!end) return null;

  const moveStart = candleAtOrBefore(
    candles,
    end.unixTime - config.event.moveSec,
  );
  const accelerationStart = candleAtOrBefore(
    candles,
    end.unixTime - config.event.accelerationSec,
  );

  if (!moveStart || !accelerationStart) return null;

  const movePct = pctChange(moveStart.close, end.close);
  const accelerationPct = pctChange(accelerationStart.close, end.close);

  const recentVolume = meanVolume(
    candles,
    end.unixTime - config.event.accelerationSec + 1,
    end.unixTime,
  );
  const baselineVolume = meanVolume(
    candles,
    end.unixTime - 4 * config.event.moveSec,
    end.unixTime - config.event.accelerationSec,
  );

  const volumeAcceleration =
    baselineVolume > 0 ? recentVolume / baselineVolume : 0;

  const pump =
    movePct >= config.event.movePct &&
    accelerationPct >= config.event.accelerationPct;

  const dump =
    movePct <= -config.event.movePct &&
    accelerationPct <= -config.event.accelerationPct;

  if (!pump && !dump) return null;

  const type: EventType = pump ? "pump" : "dump";

  return {
    id: `${token.address}:${type}:${moveStart.unixTime}`,
    token,
    type,
    detectedAt: end.unixTime,
    startTime: moveStart.unixTime,
    endTime: end.unixTime,
    movePct,
    accelerationPct,
    volumeAcceleration,
  };
}

/**
 * Wrapped-SOL mint. Jupiter and several other routers settle the SOL leg in
 * WSOL token accounts instead of native SOL, so a parser that only watches
 * native balance changes systematically misses those trades.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Combined SOL-leg change for one account, in lamports.
 *
 * Sums the native SOL balance change with the owner's WSOL token balance
 * change (WSOL has 9 decimals, so raw units are lamports). Returns null when
 * the native balances are unavailable. Positive = wallet gained SOL.
 */
function solLegDeltaLamports(
  tx: RawTransaction,
  wallet: string,
  walletIndex: number,
): number | null {
  const preSol = tx.meta.preBalances[walletIndex];
  const postSol = tx.meta.postBalances[walletIndex];
  if (preSol === undefined || postSol === undefined) return null;

  let delta = postSol - preSol;

  const wsolDeltas = tokenDeltasByOwner(tx, WSOL_MINT);
  const wsol = wsolDeltas.get(wallet);
  if (wsol && wsol.delta !== 0n) {
    delta += Number(wsol.delta);
  }

  return delta;
}

function tokenDeltasByOwner(
  tx: RawTransaction,
  tokenMint: string,
): Map<string, { delta: bigint; decimals: number }> {
  const result = new Map<string, { delta: bigint; decimals: number }>();

  for (const balance of tx.meta.preTokenBalances ?? []) {
    if (balance.mint !== tokenMint || !balance.owner) continue;

    const current = result.get(balance.owner) ?? {
      delta: 0n,
      decimals: balance.uiTokenAmount.decimals,
    };

    current.delta -= BigInt(balance.uiTokenAmount.amount);
    current.decimals = balance.uiTokenAmount.decimals;
    result.set(balance.owner, current);
  }

  for (const balance of tx.meta.postTokenBalances ?? []) {
    if (balance.mint !== tokenMint || !balance.owner) continue;

    const current = result.get(balance.owner) ?? {
      delta: 0n,
      decimals: balance.uiTokenAmount.decimals,
    };

    current.delta += BigInt(balance.uiTokenAmount.amount);
    current.decimals = balance.uiTokenAmount.decimals;
    result.set(balance.owner, current);
  }

  return result;
}

/**
 * Extract conservative buy/sell records from one transaction.
 *
 * BUY: target token balance increases while the SOL leg (native + WSOL)
 * decreases. SELL: target token balance decreases while the SOL leg
 * increases.
 *
 * Every owner with a target-token balance change is evaluated, not just the
 * fee payer, so routed swaps where the trader differs from the fee payer are
 * still attributed. This deliberately avoids guessing when the balance
 * changes do not form a clear opposite-direction pair.
 */
/**
 * Why a transaction (or one of its token legs) produced no trade.
 * Used by src/diagnose.ts to histogram parse coverage; the hot path passes
 * no callback and behaves exactly as before.
 */
export type ParseSkipReason =
  | "bad_tx"
  | "no_account_keys"
  | "zero_token_delta"
  | "owner_not_in_account_keys"
  | "missing_sol_balances"
  | "zero_sol_delta"
  | "same_direction_legs"
  | "fee_consumed_amount"
  | "invalid_trade";

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

  const feePayer = accountKeys[0];
  const tokenDeltas = tokenDeltasByOwner(tx, tokenMint);
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

    const solDelta = solLegDeltaLamports(tx, wallet, walletIndex);
    if (solDelta === null) {
      onSkip?.("missing_sol_balances");
      continue;
    }
    if (solDelta === 0) {
      onSkip?.("zero_sol_delta");
      continue;
    }

    const fee = wallet === feePayer ? tx.meta.fee : 0;

    let side: TradeSide;
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
    const tokenAmount = Number(rawTokenAmount) / 10 ** tokenInfo.decimals;
    const solAmount = solLamports / 1e9;
    const signature = tx.transaction.signatures?.[0];

    if (!signature || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
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
    });
  }

  return trades;
}

/** Build one trade observation relative to a detected pump/dump event. */
export function buildObservation(
  event: DetectedEvent,
  trade: Trade,
  candles: Candle[],
  opts?: { maxCandleGapSec?: number },
): WalletObservation | null {
  const leadSeconds = event.startTime - trade.timestamp;

  if (
    leadSeconds < -config.analysis.postSec ||
    leadSeconds > config.analysis.preSec
  ) {
    return null;
  }

  const phase =
    trade.timestamp <= event.startTime ? "pre_event" : "breakout";

  const alignedWithEvent =
    (event.type === "pump" && trade.side === "buy") ||
    (event.type === "dump" && trade.side === "sell");

  const forward: Record<string, number | null> = {};

  // Forward returns are candle-to-candle in the candle denomination (USD).
  // Never mix trade.priceSol (SOL/token) with candle closes — that unit
  // mismatch produced garbage ~+10000% returns in earlier runs.
  const base = candleAtOrBefore(candles, trade.timestamp);

  // Replay candles synthesized from sparse trades can have multi-minute
  // gaps; without a tolerance a "+60s" label could be computed from a candle
  // printed much later. Live 1s candles pass no tolerance (Infinity).
  const maxGapSec = opts?.maxCandleGapSec ?? Number.POSITIVE_INFINITY;

  for (const offset of config.analysis.forwardOffsetsSec) {
    const target = trade.timestamp + offset;
    const future = candleAtOrAfter(candles, target);

    const baseFresh =
      base !== null && trade.timestamp - base.unixTime <= maxGapSec;
    const futureFresh =
      future !== null && future.unixTime - target <= maxGapSec;

    forward[String(offset)] =
      base !== null && future !== null && baseFresh && futureFresh
        ? pctChange(base.close, future.close)
        : null;
  }

  const raw60 = forward["60"] ?? null;

  // Directional: a good pump-buy rides the price UP, a good dump-sell
  // rides it DOWN, so dump forwards are sign-flipped. Without the flip,
  // successful dump-sells scored negative and never counted as hits.
  const directionalReturn60s =
    alignedWithEvent && raw60 !== null
      ? event.type === "dump"
        ? -raw60
        : raw60
      : null;

  return {
    eventId: event.id,
    token: event.token.address,
    symbol: event.token.symbol,
    eventType: event.type,
    eventStart: event.startTime,
    tradeTime: trade.timestamp,
    wallet: trade.wallet,
    side: trade.side,
    phase,
    alignedWithEvent,
    leadSeconds,
    solAmount: trade.solAmount,
    tokenAmount: trade.tokenAmount,
    tradePriceSol: trade.priceSol,
    forward,
    forwardBasis: "candle",
    directionalReturn60s,
    // Filled in later by withVolumeShare once the event totals are known.
    sideVolumeSol: null,
    volumeShare: null,
    signature: trade.signature,
  };
}

/** Total SOL bought/sold across a set of event-window trades. */
export function sideVolumesSol(trades: Trade[]): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;

  for (const trade of trades) {
    if (trade.side === "buy") buy += trade.solAmount;
    else sell += trade.solAmount;
  }

  return { buy, sell };
}

/**
 * Attach the trade's share of its side's event-window SOL volume.
 *
 * A wallet whose own trade is most of the side volume mechanically moved the
 * pool; a wallet with a small share followed by a favorable move is stronger
 * evidence of leadership. Rows written before this field existed keep nulls.
 */
export function withVolumeShare(
  observation: WalletObservation,
  sideVolumeSol: number,
): WalletObservation {
  if (!(sideVolumeSol > 0)) {
    return { ...observation, sideVolumeSol: null, volumeShare: null };
  }

  return {
    ...observation,
    sideVolumeSol,
    volumeShare: observation.solAmount / sideVolumeSol,
  };
}

/**
 * One leadership-relevant observation kept for wallet scoring.
 */
type LeaderEntry = {
  eventId: string;
  token: string;
  eventType: EventType;
  side: TradeSide;
  leadSeconds: number;
  directional60: number;
  volumeShare: number | null;
  sizeAdjusted60: number | null;
};

/**
 * Maintain wallet-level statistics across many event observations.
 *
 * A wallet's event only counts toward leadership when its trades there are
 * directionally consistent (dominant side >= minDirectionConsistency).
 * Liquidity-pool and market-maker legs take both sides of every swap by
 * construction (~50/50), so they can never qualify — while genuine
 * accumulators and distributors pass.
 *
 * @param acceptedBases forward-return bases treated as self-consistent.
 * Defaults to live Birdeye-candle rows only; the replay harness passes
 * ["trade"] for trade-price-synthesized candles. Legacy rows with a missing
 * or unknown basis are always ignored.
 */
export class LeaderAccumulator {
  private readonly byWallet = new Map<
    string,
    {
      wallet: string;
      entries: LeaderEntry[];
      /** ALL of the wallet's event activity (both sides, any phase). */
      sideMix: Map<string, { buy: number; sell: number }>;
    }
  >();

  constructor(private readonly acceptedBases: readonly string[] = ["candle"]) {}

  /** Add one observation. Unaligned rows shape the side mix but never score. */
  add(observation: WalletObservation): void {
    // Leadership is judged on pre-event positioning only: what a wallet does
    // after the event starts is exit timing, a separate skill. (A buy-early,
    // sell-into-strength wallet must not be marked mixed by its breakout
    // sells — while pool legs mirror both sides before the event too.)
    if (observation.phase !== "pre_event") return;
    // Drop legacy rows whose forwards mixed SOL trade prices with USD
    // candle closes (forwardBasis missing or not an accepted basis).
    if (
      !observation.forwardBasis ||
      !this.acceptedBases.includes(observation.forwardBasis)
    ) {
      return;
    }

    const state = this.byWallet.get(observation.wallet) ?? {
      wallet: observation.wallet,
      entries: [],
      sideMix: new Map<string, { buy: number; sell: number }>(),
    };

    // Every row counts toward the event's side mix — including the
    // opposite-side mirror legs pools leave on every swap.
    const mix = state.sideMix.get(observation.eventId) ?? { buy: 0, sell: 0 };
    if (observation.side === "buy") mix.buy += 1;
    else mix.sell += 1;
    state.sideMix.set(observation.eventId, mix);

    if (!observation.alignedWithEvent) {
      this.byWallet.set(observation.wallet, state);
      return;
    }
    if (observation.phase !== "pre_event") {
      this.byWallet.set(observation.wallet, state);
      return;
    }
    if (observation.directionalReturn60s === null) {
      this.byWallet.set(observation.wallet, state);
      return;
    }

    // Down-weight returns the wallet likely caused itself: a trade that was
    // most of its side's event volume mechanically moved the pool, while a
    // small trade followed by a favorable move suggests others followed.
    // Rows without a share (written before volumeShare existed) contribute
    // to the raw return only, so old data is never silently re-scored.
    const share = observation.volumeShare;
    let volumeShare: number | null = null;
    let sizeAdjusted60: number | null = null;
    if (share !== null && share !== undefined && Number.isFinite(share)) {
      volumeShare = Math.min(Math.max(share, 0), 1);
      sizeAdjusted60 = observation.directionalReturn60s * (1 - volumeShare);
    }

    state.entries.push({
      eventId: observation.eventId,
      token: observation.token,
      eventType: observation.eventType,
      side: observation.side,
      leadSeconds: observation.leadSeconds,
      directional60: observation.directionalReturn60s,
      volumeShare,
      sizeAdjusted60,
    });

    this.byWallet.set(observation.wallet, state);
  }

  /** Return reusable leader candidates after minimum sample filters. */
  report(): WalletStats[] {
    const rows: WalletStats[] = [];

    for (const state of this.byWallet.values()) {
      const byEvent = new Map<string, LeaderEntry[]>();
      for (const entry of state.entries) {
        const list = byEvent.get(entry.eventId) ?? [];
        list.push(entry);
        byEvent.set(entry.eventId, list);
      }

      let mixedFiltered = 0;
      const qualified: LeaderEntry[] = [];
      const tokens = new Set<string>();
      let alignedBuyEvents = 0;
      let alignedSellEvents = 0;

      for (const [eventId, entries] of byEvent) {
        // Consistency is judged on pre-event positioning: a pool leg looks
        // one-sided among aligned rows (its mirror sells are unaligned for
        // pumps) but ~50/50 across all its pre-event rows.
        const mix = state.sideMix.get(eventId) ?? { buy: 0, sell: 0 };
        const total = mix.buy + mix.sell;
        const consistency =
          total === 0
            ? 0
            : Math.max(mix.buy, mix.sell) / total;

        if (consistency < config.report.minDirectionConsistency) {
          mixedFiltered += 1;
          continue;
        }

        for (const entry of entries) {
          qualified.push(entry);
          tokens.add(entry.token);
        }
        if (entries[0]?.eventType === "pump") alignedBuyEvents += 1;
        else alignedSellEvents += 1;
      }

      if (
        byEvent.size - mixedFiltered < config.report.minLeaderEvents ||
        tokens.size < config.report.minLeaderTokens
      ) {
        continue;
      }

      const directionals = qualified.map((e) => e.directional60);
      const shares = qualified
        .map((e) => e.volumeShare)
        .filter((s): s is number => s !== null);
      const adjusted = qualified
        .map((e) => e.sizeAdjusted60)
        .filter((s): s is number => s !== null);

      rows.push({
        wallet: state.wallet,
        leaderEvents: byEvent.size - mixedFiltered,
        uniqueTokens: tokens.size,
        alignedBuyEvents,
        alignedSellEvents,
        medianLeadSeconds: median(qualified.map((e) => e.leadSeconds)),
        medianDirectionalReturn60s: median(directionals),
        medianVolumeShare: median(shares),
        medianSizeAdjustedReturn60s: median(adjusted),
        positiveDirectional60Rate:
          directionals.length === 0
            ? null
            : directionals.filter((value) => value > 0).length / directionals.length,
        observations: qualified.length,
        mixedEventsFiltered: mixedFiltered,
        tokens: [...tokens],
      });
    }

    return rows.sort((a, b) => {
      // Prefer wallets whose favorable moves they did NOT buy themselves:
      // size-adjusted return first, raw directional as fallback for rows
      // that predate volumeShare.
      const aScore =
        a.medianSizeAdjustedReturn60s ?? a.medianDirectionalReturn60s ?? -Infinity;
      const bScore =
        b.medianSizeAdjustedReturn60s ?? b.medianDirectionalReturn60s ?? -Infinity;
      if (aScore !== bScore) return bScore - aScore;
      return b.leaderEvents - a.leaderEvents;
    });
  }
}
