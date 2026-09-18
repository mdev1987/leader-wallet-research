/**
 * Out-of-sample wallet evaluation.
 *
 * Candidates are selected only from the earlier event period. Validation uses
 * later events so the report measures whether the observed wallet/event
 * relationship persists outside the period used to select the wallet.
 */

import { config } from "../config";
import type { WalletEventStats, WalletReport } from "../types";
import { median } from "../utils";
import { isInfrastructureWalletType } from "./labels";

export function evaluateWallets(eventStats: WalletEventStats[]) {
  const ordered = [...eventStats]
    .sort((a, b) => (a.firstAlignedTradeTime ?? Infinity) - (b.firstAlignedTradeTime ?? Infinity));

  const eventTimes = new Map<string, number>();
  for (const entry of ordered) {
    const current = eventTimes.get(entry.eventId);
    if (current === undefined || entry.eventTime < current) {
      eventTimes.set(entry.eventId, entry.eventTime);
    }
  }

  const events = [...eventTimes.entries()].sort((a, b) => a[1] - b[1]);
  const cut = Math.max(1, Math.floor(events.length * config.eval.trainFrac));
  const trainIds = new Set(events.slice(0, cut).map(([id]) => id));

  const train = ordered.filter((entry) => trainIds.has(entry.eventId));
  const valid = ordered.filter((entry) => !trainIds.has(entry.eventId));

  const trainGrouped = groupByWallet(train);
  const candidates = [...trainGrouped.entries()]
    .map(([wallet, entries]) => ({
      wallet,
      entries: entries.filter((entry) => !isInfrastructureWalletType(entry.walletType)),
    }))
    .filter(({ entries }) => {
      const aligned = entries.filter((entry) => entry.alignedTradeCount > 0);
      const eventCount = new Set(aligned.map((entry) => entry.eventId)).size;
      const tokenCount = new Set(aligned.map((entry) => entry.token)).size;
      return (
        eventCount >= config.report.minWalletEvents &&
        tokenCount >= config.report.minWalletTokens
      );
    });

  const candidateSet = new Set(candidates.map((candidate) => candidate.wallet));
  const validCandidate = valid.filter(
    (entry) => candidateSet.has(entry.wallet) && !isInfrastructureWalletType(entry.walletType),
  );
  const validAligned = valid.filter(
    (entry) => entry.alignedTradeCount > 0 && !isInfrastructureWalletType(entry.walletType),
  );

  const baseHit = validAligned.filter((entry) => entry.positive60 === true).length;

  // Only candidates with enough independent validation events contribute to
  // the candidate validation rate. This wires minValidationEvents into the
  // evaluation instead of silently leaving it unused.
  const validEventsByCandidate = new Map<string, Set<string>>();
  for (const entry of validCandidate) {
    if (entry.alignedTradeCount <= 0) continue;
    const set = validEventsByCandidate.get(entry.wallet) ?? new Set<string>();
    set.add(entry.eventId);
    validEventsByCandidate.set(entry.wallet, set);
  }

  const validationQualifiedWallets = new Set(
    [...validEventsByCandidate.entries()]
      .filter(([, ids]) => ids.size >= config.report.minValidationEvents)
      .map(([wallet]) => wallet),
  );

  const qualifiedValidCandidate = validCandidate.filter(
    (entry) =>
      entry.alignedTradeCount > 0 &&
      validationQualifiedWallets.has(entry.wallet),
  );

  const candidateHit = qualifiedValidCandidate.filter(
    (entry) => entry.positive60 === true,
  ).length;
  const candidateCount = qualifiedValidCandidate.length;

  const rows = candidates.map(({ wallet, entries }) => {
    const validation = valid.filter(
      (entry) =>
        entry.wallet === wallet &&
        entry.alignedTradeCount > 0 &&
        !isInfrastructureWalletType(entry.walletType),
    );
    const training = entries.filter((entry) => entry.alignedTradeCount > 0);

    return {
      wallet,
      trainEvents: new Set(training.map((entry) => entry.eventId)).size,
      trainTokens: new Set(training.map((entry) => entry.token)).size,
      trainHitRate: hitRate(training),
      trainMedianLeadSeconds: median(
        training
          .map((entry) => entry.firstAlignedLeadSeconds)
          .filter((value): value is number => value !== null),
      ),
      trainBuyLeadSec: sideLead(
        training.filter((entry) => entry.eventType === "pump"),
        "buy",
      ),
      trainSellLeadSec: sideLead(
        training.filter((entry) => entry.eventType === "dump"),
        "sell",
      ),
      trainBuyDirectional: sideHorizons(
        training.filter((entry) => entry.eventType === "pump"),
        "buy",
      ),
      trainSellDirectional: sideHorizons(
        training.filter((entry) => entry.eventType === "dump"),
        "sell",
      ),
      validEvents: new Set(validation.map((entry) => entry.eventId)).size,
      validTokens: new Set(validation.map((entry) => entry.token)).size,
      validationEligible:
        new Set(validation.map((entry) => entry.eventId)).size >=
        config.report.minValidationEvents,
      validHitRate: hitRate(validation),
      validMedianLeadSeconds: median(
        validation
          .map((entry) => entry.firstAlignedLeadSeconds)
          .filter((value): value is number => value !== null),
      ),
      validBuyLeadSec: sideLead(
        validation.filter((entry) => entry.eventType === "pump"),
        "buy",
      ),
      validSellLeadSec: sideLead(
        validation.filter((entry) => entry.eventType === "dump"),
        "sell",
      ),
      validBuyDirectional: sideHorizons(
        validation.filter((entry) => entry.eventType === "pump"),
        "buy",
      ),
      validSellDirectional: sideHorizons(
        validation.filter((entry) => entry.eventType === "dump"),
        "sell",
      ),
    };
  }).sort((a, b) => {
    const ah = a.validHitRate ?? -1;
    const bh = b.validHitRate ?? -1;
    if (ah !== bh) return bh - ah;
    return (b.validEvents ?? 0) - (a.validEvents ?? 0);
  });

  const baseRate = validAligned.length > 0 ? baseHit / validAligned.length : null;
  const candidateRate = candidateCount > 0 ? candidateHit / candidateCount : null;

  return {
    generatedAt: new Date().toISOString(),
    methodology: {
      split: "time-ordered wallet-event split at 70/30",
      evidenceUnit: "one wallet-event, not one trade",
      leaderWindow: `up to ${config.analysis.preSec}s before accelerationStart`,
      hit: "wallet-event has a positive median directional 60s return across its aligned pre-event trades",
      mixedWallets: "retained; side consistency is reported, not used as a hard exclusion",
      infrastructure: "pool/router/program wallet-events are retained in raw data but excluded from candidate and validation evidence",
      crashEvents: "excluded from research observations",
      validationMinimumEvents: config.report.minValidationEvents,
    },
    events: {
      total: events.length,
      train: trainIds.size,
      validation: events.length - trainIds.size,
    },
    observations: {
      total: ordered.length,
      train: train.length,
      validation: valid.length,
    },
    baseValidationHitRate: baseRate,
    validationQualifiedWallets: validationQualifiedWallets.size,
    candidateValidationHitRate: candidateRate,
    lift: baseRate !== null && candidateRate !== null && baseRate > 0
      ? candidateRate / baseRate
      : null,
    candidates: rows,
  };
}

function groupByWallet(entries: WalletEventStats[]): Map<string, WalletEventStats[]> {
  const grouped = new Map<string, WalletEventStats[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.wallet) ?? [];
    list.push(entry);
    grouped.set(entry.wallet, list);
  }
  return grouped;
}

function hitRate(entries: WalletEventStats[]): number | null {
  const aligned = entries.filter((entry) => entry.alignedTradeCount > 0);
  if (aligned.length === 0) return null;
  return aligned.filter((entry) => entry.positive60 === true).length / aligned.length;
}

function sideLead(
  entries: WalletEventStats[],
  side: "buy" | "sell",
): number | null {
  const values = entries.map((entry) =>
    side === "buy" ? entry.firstBuyLeadSeconds : entry.firstSellLeadSeconds,
  );
  return median(
    values.filter((value): value is number => value !== null),
  );
}

function sideHorizons(
  entries: WalletEventStats[],
  side: "buy" | "sell",
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const offset of config.analysis.forwardOffsetsSec) {
    const key = String(offset);
    out[key] = median(
      entries
        .map((entry) =>
          side === "buy" ? entry.buyDirectional[key] : entry.sellDirectional[key],
        )
        .filter((value): value is number => value !== null),
    );
  }
  return out;
}

/** Select the most useful final report rows without inventing a composite score. */
export function topWallets(rows: WalletReport[], limit = config.report.topWallets): WalletReport[] {
  return rows.slice(0, limit);
}
