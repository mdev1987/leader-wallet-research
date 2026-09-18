/**
 * Out-of-sample wallet evaluation.
 *
 * Candidates are selected only from the earlier event period. Validation uses
 * later events so the report measures whether the observed wallet/event
 * relationship persists outside the period used to select the wallet.
 *
 * v5 adds the actual significance test: a wallet-shuffled permutation null
 * for the candidate validation rate (labels shuffled across validation
 * wallet-events, event structure intact) plus bootstrap percentile intervals
 * for candidate and base rates. With thousands of wallets, some validate well
 * by chance; beating 50% is not evidence, beating the null is.
 */

import { config } from "../config";
import type { WalletEventStats, WalletReport } from "../types";
import { median, mulberry32, shuffleInPlace } from "../utils";
import { isInfrastructureWalletType } from "./labels";

export type PermutationNull = {
  resamples: number;
  seed: number;
  /** Wallets whose validation evidence was tested (fixed real selection). */
  testedWallets: number;
  observedRate: number | null;
  nullMean: number | null;
  nullSd: number | null;
  nullP95: number | null;
  /** P(null rate >= observed), with +1 pseudocount. Null when untestable. */
  pValue: number | null;
  candidateCI95: [number, number] | null;
  baseCI95: [number, number] | null;
  skipped: string | null;
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], avg: number): number | null {
  if (values.length < 2) return null;
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(sortedAscending: number[], pct: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = (pct / 100) * (sortedAscending.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sortedAscending[lower];
  const high = sortedAscending[upper];
  if (low === undefined || high === undefined) return null;
  return low + (high - low) * (rank - lower);
}

/**
 * Wallet-shuffled null for the candidate validation rate.
 *
 * Shuffles wallet labels across ALL scored validation entries (candidates
 * and background alike), then scores the entries randomly assigned to the
 * fixed real candidate set. Event structure, returns and counts stay intact;
 * only the wallet->performance link is broken. Train selection is never
 * re-run inside the null: we test THESE candidates, not the procedure.
 * Returns null when there is nothing to test (no candidates or no evidence).
 */
function permutationNull(
  scoredValid: WalletEventStats[],
  candidateWallets: ReadonlySet<string>,
  trainCandidateCount: number,
  resamples: number,
  seed: number,
): PermutationNull {
  const skipped = (reason: string): PermutationNull => ({
    resamples,
    seed,
    testedWallets: candidateWallets.size,
    observedRate: null,
    nullMean: null,
    nullSd: null,
    nullP95: null,
    pValue: null,
    candidateCI95: null,
    baseCI95: null,
    skipped: reason,
  });

  const pool = scoredValid.filter((entry) => entry.alignedTradeCount > 0);
  if (pool.length === 0) return skipped("no scored validation entries");
  if (trainCandidateCount === 0) return skipped("no candidates selected on train");
  if (candidateWallets.size === 0) {
    return skipped("candidates exist but none has 2+ validation events yet");
  }

  const labels = pool.map((entry) => entry.wallet);
  const hits = pool.map((entry) => (entry.positive60 === true ? 1 : 0));

  let observedHit = 0;
  let observedTotal = 0;
  for (let i = 0; i < pool.length; i += 1) {
    if (!candidateWallets.has(labels[i] ?? "")) continue;
    observedTotal += 1;
    observedHit += hits[i] ?? 0;
  }
  if (observedTotal === 0) return skipped("candidates have no validation evidence");
  const observedRate = observedHit / observedTotal;

  const rand = mulberry32(seed);
  const nullRates: number[] = [];
  for (let iter = 0; iter < resamples; iter += 1) {
    const shuffled = shuffleInPlace([...labels], rand);
    let hit = 0;
    let total = 0;
    for (let i = 0; i < shuffled.length; i += 1) {
      if (!candidateWallets.has(shuffled[i] ?? "")) continue;
      total += 1;
      hit += hits[i] ?? 0;
    }
    if (total > 0) nullRates.push(hit / total);
  }
  if (nullRates.length === 0) return skipped("null resampling produced no evidence");

  const avg = mean(nullRates) ?? 0;
  const sorted = [...nullRates].sort((a, b) => a - b);
  const atLeastObserved = nullRates.filter((rate) => rate >= observedRate).length;

  return {
    resamples,
    seed,
    testedWallets: candidateWallets.size,
    observedRate,
    nullMean: avg,
    nullSd: standardDeviation(nullRates, avg),
    nullP95: percentile(sorted, 95),
    // +1 pseudocount: P(null >= observed) never claims exactly zero.
    pValue: (1 + atLeastObserved) / (1 + nullRates.length),
    candidateCI95: null, // filled by caller (needs candidate-only pool)
    baseCI95: null, // filled by caller (needs full background pool)
    skipped: null,
  };
}

/** Bootstrap percentile interval for a hit rate over scored entries. */
function bootstrapCI(
  scored: WalletEventStats[],
  resamples: number,
  seed: number,
): [number, number] | null {
  const pool = scored.filter((entry) => entry.alignedTradeCount > 0);
  if (pool.length === 0) return null;

  const hits = pool.map((entry) => (entry.positive60 === true ? 1 : 0));
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const rates: number[] = [];

  for (let iter = 0; iter < resamples; iter += 1) {
    let hit = 0;
    for (let i = 0; i < pool.length; i += 1) {
      hit += hits[Math.floor(rand() * pool.length)] ?? 0;
    }
    rates.push(hit / pool.length);
  }

  rates.sort((a, b) => a - b);
  const lo = percentile(rates, 2.5);
  const hi = percentile(rates, 97.5);
  if (lo === null || hi === null) return null;
  return [lo, hi];
}

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

  // v5 significance: the reported candidate rate is computed over
  // validation-qualified candidates, so the null tests exactly that set
  // against the full validation background (not just other candidates).
  const nullResult = permutationNull(
    validAligned,
    validationQualifiedWallets,
    candidateSet.size,
    config.eval.permutationCount,
    config.eval.randomSeed,
  );
  nullResult.candidateCI95 = bootstrapCI(
    qualifiedValidCandidate,
    config.eval.permutationCount,
    config.eval.randomSeed,
  );
  nullResult.baseCI95 = bootstrapCI(
    validAligned,
    config.eval.permutationCount,
    config.eval.randomSeed,
  );

  return {
    generatedAt: new Date().toISOString(),
    methodology: {
      split: "time-ordered wallet-event split at 70/30",
      evidenceUnit: "one wallet-event, not one trade",
      leaderWindow: `up to ${config.analysis.preSec}s before accelerationStart`,
      hit: "wallet-event has a positive median directional 60s return across its aligned pre-event trades",
      mixedWallets: "retained; side consistency is reported, not used as a hard exclusion",
      infrastructure: "pool/router/program wallet-events are retained in raw data but excluded from candidate and validation evidence",
      significance: "wallet-shuffled permutation null over validation wallet-events (fixed train selection); bootstrap percentile CIs; seeded RNG",
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
    permutation: nullResult,
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
