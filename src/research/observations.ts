/**
 * Convert event-local trades into wallet observations.
 *
 * Each observation is intentionally tied to an event and preserves the exact
 * trade timestamp. The leader report later aggregates observations into one
 * wallet-event record so a hyperactive wallet cannot win simply by producing
 * many rows inside one event.
 */

import { config } from "../config";
import type {
  Candle,
  DetectedEvent,
  Trade,
  TradePhase,
  WalletLabel,
  WalletObservation,
} from "../types";
import { classifyWallet } from "./labels";
import { candleAtOrAfter, candleAtOrBefore } from "./events";
import { pctChange } from "../utils";

/** Build an event-relative observation for one trade. */
export function buildObservation(
  event: DetectedEvent,
  trade: Trade,
  candles: Candle[],
  basis: WalletObservation["forwardBasis"],
  labelContext?: Parameters<typeof classifyWallet>[2],
): WalletObservation | null {
  if (event.type === "crash") return null;

  const leadSeconds = event.accelerationStart - trade.timestamp;
  // Keep the whole event path (acceleration + breakout) plus a short post-event
  // tail. The leadership score still uses pre-event aligned trades only, but
  // phase-aware features need access to later breakout/distribution trades.
  const postObservationSec =
    Math.max(0, event.confirmedAt - event.accelerationStart) +
    config.analysis.postSec;
  if (
    leadSeconds < -postObservationSec ||
    leadSeconds > config.analysis.preSec
  ) {
    return null;
  }

  const phase: TradePhase =
    trade.timestamp <= event.accelerationStart
      ? "pre_event"
      : trade.timestamp <= event.breakoutStart
        ? "acceleration"
        : "breakout";

  const alignedWithEvent =
    (event.type === "pump" && trade.side === "buy") ||
    (event.type === "dump" && trade.side === "sell");

  const forward: Record<string, number | null> = {};
  const directionalReturns: Record<string, number | null> = {};
  const base = candleAtOrBefore(candles, trade.timestamp);
  const candlePriceUsdAtTrade =
    basis === "market-usd" && base !== null ? base.close : null;

  const label: WalletLabel = classifyWallet(
    trade.wallet,
    trade.isSigner,
    labelContext ?? { poolAddresses: new Set<string>() },
  );

  for (const offset of config.analysis.forwardOffsetsSec) {
    const target = trade.timestamp + offset;
    const future = candleAtOrAfter(candles, target);

    const baseFresh =
      base !== null && trade.timestamp - base.unixTime <= config.analysis.maxCandleGapSec;
    const futureFresh =
      future !== null && future.unixTime - target <= config.analysis.maxCandleGapSec;

    const value =
      base && future && baseFresh && futureFresh
        ? pctChange(base.close, future.close)
        : null;

    forward[String(offset)] = value;
    directionalReturns[String(offset)] =
      alignedWithEvent && value !== null
        ? event.type === "dump"
          ? -value
          : value
        : null;
  }

  const sideVolumeSol = 0;

  return {
    eventId: event.id,
    eventTime: event.accelerationStart,
    token: event.token.address,
    symbol: event.token.symbol,
    eventType: event.type,
    accelerationStart: event.accelerationStart,
    breakoutStart: event.breakoutStart,
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
    forwardBasis: basis,
    directionalReturns,
    sideVolumeSol,
    sideVolumeShare: 0,
    signature: trade.signature,
    candlePriceUsdAtTrade,
    eventLiquidityUsd: event.token.liquidityUsd ?? 0,
    walletType: label.type,
    walletTypeReason: label.reason,
    behavioralHint: null,
  };
}

/** Attach the trade's share of its event-side SOL volume. */
export function attachVolumeShare(
  observation: WalletObservation,
  sideVolumeSol: number,
): WalletObservation {
  const share = sideVolumeSol > 0 ? observation.solAmount / sideVolumeSol : 0;
  return {
    ...observation,
    sideVolumeSol,
    sideVolumeShare: Math.min(Math.max(share, 0), 1),
  };
}

/** Calculate event-window buy/sell volume. */
export function sideVolumes(
  trades: Trade[],
): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;
  for (const trade of trades) {
    if (trade.side === "buy") buy += trade.solAmount;
    else sell += trade.solAmount;
  }
  return { buy, sell };
}
