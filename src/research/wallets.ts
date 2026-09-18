/**
 * Wallet-level and wallet-event aggregation.
 *
 * One wallet-event is the basic evidence unit. Phase-aware volume splits encode
 * accumulate -> accelerate -> breakout -> distribute behavior without making
 * a mixed-side heuristic into a hard filter.
 */

import type {
  PhaseTradeCount,
  PhaseVolume,
  WalletEventStats,
  WalletObservation,
  WalletReport,
  WalletType,
  WalletTypeReason,
} from "../types";
import { median } from "../utils";
import { config } from "../config";
import { behavioralHint as getBehavioralHint, isInfrastructureWalletType } from "./labels";

type Phase = "pre_event" | "acceleration" | "breakout";

function emptyPhaseVolumes(): Record<Phase, PhaseVolume> {
  return {
    pre_event: { buy: 0, sell: 0 },
    acceleration: { buy: 0, sell: 0 },
    breakout: { buy: 0, sell: 0 },
  };
}

function emptyPhaseCounts(): Record<Phase, PhaseTradeCount> {
  return {
    pre_event: { buy: 0, sell: 0 },
    acceleration: { buy: 0, sell: 0 },
    breakout: { buy: 0, sell: 0 },
  };
}

function selectStableLabel(rows: WalletObservation[]): {
  type: WalletType;
  reason: WalletTypeReason;
} {  const priority: WalletType[] = ["pool", "router", "program", "trader", "unknown"];
  for (const type of priority) {
    const row = rows.find((candidate) => candidate.walletType === type);
    if (row) {
      return {
        type,
        reason: row.walletTypeReason ?? "default",
      };
    }
  }
  return { type: "unknown", reason: "default" };
}

function medianOf(values: Array<number | null | undefined>): number | null {
  return median(
    values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
}

/** Per-horizon medians over one side's aligned rows. */
function sideHorizons(
  rows: WalletObservation[],
  side: "buy" | "sell",
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const sideRows = rows.filter((row) => row.side === side);
  for (const offset of config.analysis.forwardOffsetsSec) {
    const key = String(offset);
    out[key] = medianOf(sideRows.map((row) => row.directionalReturns[key]));
  }
  return out;
}

/** Aggregate observations into one row per wallet per event. */
export function aggregateWalletEvents(
  observations: WalletObservation[],
): WalletEventStats[] {
  const byKey = new Map<string, WalletObservation[]>();

  for (const observation of observations) {
    const key = `${observation.wallet}:${observation.eventId}`;
    const rows = byKey.get(key) ?? [];
    rows.push(observation);
    byKey.set(key, rows);
  }

  const result: WalletEventStats[] = [];

  for (const rows of byKey.values()) {
    const first = rows[0];
    if (!first) continue;

    const ordered = [...rows].sort((a, b) => a.tradeTime - b.tradeTime);
    const preEvent = ordered.filter((row) => row.phase === "pre_event");
    const aligned = preEvent.filter((row) => row.alignedWithEvent);

    const buys = ordered.filter((row) => row.side === "buy");
    const sells = ordered.filter((row) => row.side === "sell");
    const buyCount = buys.length;
    const sellCount = sells.length;
    const totalCount = buyCount + sellCount;
    const sideConsistency =
      totalCount > 0 ? Math.max(buyCount, sellCount) / totalCount : 0;

    const firstAligned = aligned[0];
    const lastAligned = aligned.at(-1);
    const directional60 = aligned
      .map((row) => row.directionalReturns["60"])
      .filter((value): value is number => value !== null && Number.isFinite(value));

    const phaseVolumes = emptyPhaseVolumes();
    const phaseTradeCounts = emptyPhaseCounts();
    for (const row of ordered) {
      const phase = phaseVolumes[row.phase];
      const counts = phaseTradeCounts[row.phase];
      phase[row.side] += row.solAmount;
      counts[row.side] += 1;
    }

    const entryRows = buys.filter(
      (row) =>
        row.candlePriceUsdAtTrade !== null &&
        row.candlePriceUsdAtTrade !== undefined &&
        Number.isFinite(row.candlePriceUsdAtTrade),
    );
    const entryTokenAmount = entryRows.reduce((sum, row) => sum + row.tokenAmount, 0);
    const avgEntryPriceUsd =
      entryTokenAmount > 0
        ? entryRows.reduce(
            (sum, row) => sum + (row.candlePriceUsdAtTrade as number) * row.tokenAmount,
            0,
          ) / entryTokenAmount
        : null;

    const exitRows = sells.filter(
      (row) =>
        row.candlePriceUsdAtTrade !== null &&
        row.candlePriceUsdAtTrade !== undefined &&
        Number.isFinite(row.candlePriceUsdAtTrade),
    );
    const exitTokenAmount = exitRows.reduce((sum, row) => sum + row.tokenAmount, 0);
    const avgExitPriceUsd =
      exitTokenAmount > 0
        ? exitRows.reduce(
            (sum, row) => sum + (row.candlePriceUsdAtTrade as number) * row.tokenAmount,
            0,
          ) / exitTokenAmount
        : null;

    const label = selectStableLabel(ordered);
    const behavioralHint = getBehavioralHint(buyCount, sellCount);

    const buyVolumeSol = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellVolumeSol = sells.reduce((sum, row) => sum + row.solAmount, 0);
    const buyTimes = buys.map((row) => row.tradeTime);
    const buyLeads = buys.map((row) => row.accelerationStart - row.tradeTime);
    const sellLeads = sells.map((row) => row.accelerationStart - row.tradeTime);

    result.push({
      wallet: first.wallet,
      eventId: first.eventId,
      eventTime: first.accelerationStart,
      token: first.token,
      symbol: first.symbol,
      eventType: first.eventType,
      firstAlignedTradeTime: firstAligned?.tradeTime ?? null,
      lastAlignedTradeTime: lastAligned?.tradeTime ?? null,
      firstAlignedLeadSeconds: firstAligned?.leadSeconds ?? null,
      firstBuyLeadSeconds: buyLeads.length > 0 ? Math.max(...buyLeads) : null,
      firstSellLeadSeconds: sellLeads.length > 0 ? Math.max(...sellLeads) : null,
      firstBuyOffsetSec:
        buyTimes.length > 0 ? Math.min(...buyTimes) - first.accelerationStart : null,
      lastBuyOffsetSec:
        buyTimes.length > 0 ? Math.max(...buyTimes) - first.accelerationStart : null,
      netVolumeSol: buyVolumeSol - sellVolumeSol,
      preBreakoutTradeCount: ordered.filter(
        (row) => row.tradeTime <= first.breakoutStart,
      ).length,
      buyDirectional: sideHorizons(aligned, "buy"),
      sellDirectional: sideHorizons(aligned, "sell"),
      eventLiquidityUsd: first.eventLiquidityUsd ?? 0,
      alignedTradeCount: aligned.length,
      alignedVolumeSol: aligned.reduce((sum, row) => sum + row.solAmount, 0),
      buyVolumeSol,
      sellVolumeSol,
      buyCount,
      sellCount,
      sideConsistency,
      earliestTradeTime: ordered[0]?.tradeTime ?? null,
      latestTradeTime: ordered.at(-1)?.tradeTime ?? null,
      maxDirectional60: directional60.length ? Math.max(...directional60) : null,
      medianDirectional60: median(directional60),
      positive60:
        directional60.length > 0
          ? (median(directional60) ?? 0) > 0
          : null,
      medianVolumeShare: median(
        aligned
          .map((row) => row.sideVolumeShare)
          .filter((value) => Number.isFinite(value)),
      ),
      walletType: label.type,
      walletTypeReason: label.reason,
      behavioralHint,
      phaseVolumes,
      phaseTradeCounts,
      avgEntryPriceUsd,
      avgExitPriceUsd,
      entryTokenAmount,
      exitTokenAmount,
    });
  }

  return result.sort((a, b) =>
    a.firstAlignedTradeTime === null
      ? 1
      : b.firstAlignedTradeTime === null
        ? -1
        : a.firstAlignedTradeTime - b.firstAlignedTradeTime,
  );
}

/** Median across wallet-events of one side's per-event horizon median. */
function reportHorizons(
  entries: WalletEventStats[],
  side: "buy" | "sell",
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const offset of config.analysis.forwardOffsetsSec) {
    const key = String(offset);
    out[key] = medianOf(
      entries.map((entry) =>
        side === "buy" ? entry.buyDirectional[key] : entry.sellDirectional[key],
      ),
    );
  }
  return out;
}

/** Build a wallet report from one or more wallet-event observations. */
export function buildWalletReport(
  eventStats: WalletEventStats[],
  minEvents: number,
  minTokens: number,
): WalletReport[] {
  const grouped = new Map<string, WalletEventStats[]>();
  for (const entry of eventStats) {
    const list = grouped.get(entry.wallet) ?? [];
    list.push(entry);
    grouped.set(entry.wallet, list);
  }

  const rows: WalletReport[] = [];

  for (const [wallet, entries] of grouped) {
    const infrastructureEventsExcluded = entries.filter(
      (entry) => isInfrastructureWalletType(entry.walletType),
    ).length;
    // Preserve infrastructure rows in wallet_events.jsonl, but do not allow
    // pool/router/program evidence to become leader evidence.
    const eligibleEntries = entries.filter(
      (entry) => !isInfrastructureWalletType(entry.walletType),
    );
    const aligned = eligibleEntries.filter((entry) => entry.alignedTradeCount > 0);
    const tokens = new Set(aligned.map((entry) => entry.token));
    const pumps = aligned.filter((entry) => entry.eventType === "pump");
    const dumps = aligned.filter((entry) => entry.eventType === "dump");
    const hits = aligned.filter((entry) => entry.positive60 === true).length;

    if (aligned.length < minEvents || tokens.size < minTokens) continue;

    const walletTypes = [...new Set(aligned.map((entry) => entry.walletType ?? "unknown"))];
    const walletTypeReasons = [
      ...new Set(aligned.map((entry) => entry.walletTypeReason ?? "default")),
    ];

    rows.push({
      wallet,
      eventCount: aligned.length,
      tokenCount: tokens.size,
      pumpEvents: pumps.length,
      dumpEvents: dumps.length,
      alignedObservations: aligned.length,
      positive60Rate: aligned.length > 0 ? hits / aligned.length : null,
      medianLeadSeconds: median(
        aligned
          .map((entry) => entry.firstAlignedLeadSeconds)
          .filter((value): value is number => value !== null),
      ),
      medianBuyLeadSec: medianOf(pumps.map((entry) => entry.firstBuyLeadSeconds)),
      medianSellLeadSec: medianOf(dumps.map((entry) => entry.firstSellLeadSeconds)),
      medianDirectional60: median(
        aligned
          .map((entry) => entry.medianDirectional60)
          .filter((value): value is number => value !== null),
      ),
      buyDirectional: reportHorizons(pumps, "buy"),
      sellDirectional: reportHorizons(dumps, "sell"),
      medianVolumeShare: median(
        aligned
          .map((entry) => entry.medianVolumeShare)
          .filter((value): value is number => value !== null),
      ),
      medianTradeSol: medianOf(aligned.map((entry) => entry.alignedVolumeSol)),
      medianEventLiquidityUsd: medianOf(
        aligned.map((entry) => entry.eventLiquidityUsd).filter((value) => value > 0),
      ),
      // Mixed SOL/USD units: relative comparisons only, never dollars.
      medianTradeVsLiquidity: medianOf(
        aligned
          .filter((entry) => entry.eventLiquidityUsd > 0)
          .map((entry) => entry.alignedVolumeSol / entry.eventLiquidityUsd),
      ),
      buyEventCount: pumps.length,
      sellEventCount: dumps.length,
      events: aligned.map((entry) => entry.eventId),
      tokens: [...tokens],
      walletTypes,
      walletTypeReasons,
      infrastructureEventsExcluded,
    });
  }

  return rows.sort((a, b) => {
    const aHit = a.positive60Rate ?? -1;
    const bHit = b.positive60Rate ?? -1;
    if (aHit !== bHit) return bHit - aHit;

    const aLead = a.medianLeadSeconds ?? -Infinity;
    const bLead = b.medianLeadSeconds ?? -Infinity;
    if (aLead !== bLead) return bLead - aLead;

    return b.eventCount - a.eventCount;
  });
}
