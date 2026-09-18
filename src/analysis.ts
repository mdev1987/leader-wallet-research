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
 * BUY: target token balance increases while native SOL decreases.
 * SELL: target token balance decreases while native SOL increases.
 *
 * This deliberately avoids guessing when the balance changes do not form a
 * clear opposite-direction pair.
 */
export function parseTrades(
  tx: RawTransaction,
  tokenMint: string,
): Trade[] {
  if (tx.meta.err !== null || tx.blockTime === null) return [];

  const accountKeys = tx.transaction.message.accountKeys.map(pubkeyOf);
  if (accountKeys.length === 0) return [];

  const feePayer = accountKeys[0];
  const tokenDeltas = tokenDeltasByOwner(tx, tokenMint);
  const trades: Trade[] = [];

  for (const [wallet, tokenInfo] of tokenDeltas) {
    if (tokenInfo.delta === 0n) continue;

    const walletIndex = accountKeys.indexOf(wallet);
    if (walletIndex < 0) continue;

    const preSol = tx.meta.preBalances[walletIndex];
    const postSol = tx.meta.postBalances[walletIndex];
    if (preSol === undefined || postSol === undefined) continue;

    const solDelta = postSol - preSol;
    if (solDelta === 0) continue;

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
      continue;
    }

    if (solLamports <= 0) continue;

    const rawTokenAmount =
      tokenInfo.delta < 0n ? -tokenInfo.delta : tokenInfo.delta;
    const tokenAmount = Number(rawTokenAmount) / 10 ** tokenInfo.decimals;
    const solAmount = solLamports / 1e9;
    const signature = tx.transaction.signatures?.[0];

    if (!signature || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
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

  for (const offset of config.analysis.forwardOffsetsSec) {
    const future = candleAtOrAfter(
      candles,
      trade.timestamp + offset,
    );

    forward[String(offset)] = future
      ? pctChange(trade.priceSol, future.close)
      : null;
  }

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
    directionalReturn60s:
      alignedWithEvent && forward["60"] !== null
        ? forward["60"]
        : null,
    signature: trade.signature,
  };
}

/** Maintain wallet-level statistics across many event observations. */
export class LeaderAccumulator {
  private readonly byWallet = new Map<
    string,
    {
      wallet: string;
      eventIds: Set<string>;
      tokens: Set<string>;
      leadSeconds: number[];
      directional60: number[];
      alignedBuyEvents: number;
      alignedSellEvents: number;
    }
  >();

  /** Add one aligned, pre-event observation. */
  add(observation: WalletObservation): void {
    if (!observation.alignedWithEvent) return;
    if (observation.phase !== "pre_event") return;
    if (observation.directionalReturn60s === null) return;

    const state = this.byWallet.get(observation.wallet) ?? {
      wallet: observation.wallet,
      eventIds: new Set<string>(),
      tokens: new Set<string>(),
      leadSeconds: [],
      directional60: [],
      alignedBuyEvents: 0,
      alignedSellEvents: 0,
    };

    state.eventIds.add(observation.eventId);
    state.tokens.add(observation.token);
    state.leadSeconds.push(observation.leadSeconds);
    state.directional60.push(observation.directionalReturn60s);

    if (observation.eventType === "pump") {
      state.alignedBuyEvents += 1;
    } else {
      state.alignedSellEvents += 1;
    }

    this.byWallet.set(observation.wallet, state);
  }

  /** Return reusable leader candidates after minimum sample filters. */
  report(): WalletStats[] {
    return [...this.byWallet.values()]
      .map((state): WalletStats => ({
        wallet: state.wallet,
        leaderEvents: state.eventIds.size,
        uniqueTokens: state.tokens.size,
        alignedBuyEvents: state.alignedBuyEvents,
        alignedSellEvents: state.alignedSellEvents,
        medianLeadSeconds: median(state.leadSeconds),
        medianDirectionalReturn60s: median(state.directional60),
        positiveDirectional60Rate:
          state.directional60.length === 0
            ? null
            : state.directional60.filter((value) => value > 0).length /
              state.directional60.length,
        observations: state.directional60.length,
        tokens: [...state.tokens],
      }))
      .filter(
        (row) =>
          row.leaderEvents >= config.report.minLeaderEvents &&
          row.uniqueTokens >= config.report.minLeaderTokens,
      )
      .sort((a, b) => {
        const aReturn = a.medianDirectionalReturn60s ?? -Infinity;
        const bReturn = b.medianDirectionalReturn60s ?? -Infinity;
        if (aReturn !== bReturn) return bReturn - aReturn;
        return b.leaderEvents - a.leaderEvents;
      });
  }
}
