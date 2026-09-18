/**
 * Train/valid evaluation for leader-wallet candidates.
 *
 * Answers: do wallets that led past pumps also lead future ones?
 *
 * Method: order all events by start time, use the earliest trainFrac as the
 * training split (candidate selection with the live promotion thresholds)
 * and the latest events as the validation split (out-of-sample hit rates).
 * Time-ordering avoids lookahead leakage: the future never trains the past.
 *
 * Hit = aligned pre-event trade whose 60s directional return is positive.
 * Accepts both "candle" (live) and "trade" (replay) forward bases; the basis
 * mix is reported so unit differences stay visible.
 *
 * Usage:
 *   bun run src/eval.ts [--obs data/wallet_observations.jsonl]
 *     [--replay data/replay_observations.jsonl] [--train-frac 0.7]
 *     [--out data/eval_report.json]
 */

import { readFile, writeFile } from "node:fs/promises";
import { config } from "./config";
import type { WalletObservation } from "./types";
import { median } from "./utils";

const ACCEPTED_BASES = new Set(["candle", "trade"]);

function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] ?? fallback;
}

async function loadObservations(paths: string[]): Promise<WalletObservation[]> {
  const observations: WalletObservation[] = [];

  for (const path of paths) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) {
      console.warn(`[warn] missing file, skipped: ${path}`);
      continue;
    }

    let kept = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as WalletObservation;
        // Pre-event rows only (leadership = positioning before the move),
        // with a trusted basis. Unaligned rows shape each wallet-event's
        // side mix (pool detection); aligned rows with a directional return
        // score. Legacy-basis rows are dropped.
        if (obs.phase !== "pre_event") continue;
        if (!obs.forwardBasis || !ACCEPTED_BASES.has(obs.forwardBasis)) continue;
        observations.push(obs);
        kept += 1;
      } catch {
        // Skip malformed rows; counted implicitly by kept.
      }
    }
    console.log(`loaded ${kept} usable observations from ${path}`);
  }

  return observations;
}

type WalletAggregate = {
  wallet: string;
  events: Set<string>;
  tokens: Set<string>;
  hits: number;
  total: number;
  leads: number[];
  mixedEvents: number;
};

/**
 * Group observations by wallet, keeping only directionally consistent
 * wallet-events (same >=80% rule as the live accumulator). Consistency is
 * judged on pre-event positioning: pool/MM legs look one-sided among aligned
 * rows but ~50/50 overall, so only the full pre-event mix excludes them.
 */
function aggregate(observations: WalletObservation[]): Map<string, WalletAggregate> {
  const mix = new Map<string, Map<string, { buy: number; sell: number }>>();
  const scored = new Map<string, Map<string, WalletObservation[]>>();

  for (const obs of observations) {
    let byWallet = mix.get(obs.eventId);
    if (!byWallet) {
      byWallet = new Map<string, { buy: number; sell: number }>();
      mix.set(obs.eventId, byWallet);
    }
    const counts = byWallet.get(obs.wallet) ?? { buy: 0, sell: 0 };
    if (obs.side === "buy") counts.buy += 1;
    else counts.sell += 1;
    byWallet.set(obs.wallet, counts);

    if (!obs.alignedWithEvent || obs.phase !== "pre_event") continue;
    if (obs.directionalReturn60s === null) continue;

    let scoredByWallet = scored.get(obs.eventId);
    if (!scoredByWallet) {
      scoredByWallet = new Map<string, WalletObservation[]>();
      scored.set(obs.eventId, scoredByWallet);
    }
    const list = scoredByWallet.get(obs.wallet) ?? [];
    list.push(obs);
    scoredByWallet.set(obs.wallet, list);
  }

  const byWallet = new Map<string, WalletAggregate>();

  const noteMixed = (wallet: string): WalletAggregate => {
    const state = byWallet.get(wallet) ?? {
      wallet,
      events: new Set<string>(),
      tokens: new Set<string>(),
      hits: 0,
      total: 0,
      leads: [],
      mixedEvents: 0,
    };
    state.mixedEvents += 1;
    byWallet.set(wallet, state);
    return state;
  };

  for (const [eventId, walletMap] of mix) {
    for (const [wallet, counts] of walletMap) {
      const total = counts.buy + counts.sell;
      const consistency =
        total === 0 ? 0 : Math.max(counts.buy, counts.sell) / total;

      if (consistency < config.report.minDirectionConsistency) {
        noteMixed(wallet);
        continue;
      }

      const list = scored.get(eventId)?.get(wallet) ?? [];
      if (list.length === 0) continue;

      const state = byWallet.get(wallet) ?? {
        wallet,
        events: new Set<string>(),
        tokens: new Set<string>(),
        hits: 0,
        total: 0,
        leads: [],
        mixedEvents: 0,
      };

      for (const obs of list) {
        state.events.add(obs.eventId);
        state.tokens.add(obs.token);
        state.total += 1;
        if ((obs.directionalReturn60s ?? 0) > 0) state.hits += 1;
        state.leads.push(obs.leadSeconds);
      }
      byWallet.set(wallet, state);
    }
  }

  return byWallet;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const obsPaths = [
    argValue(args, "--obs", "data/wallet_observations.jsonl"),
    argValue(args, "--replay", "data/replay_observations.jsonl"),
  ];
  const trainFrac = Number(argValue(args, "--train-frac", String(config.eval.trainFrac)));
  const outPath = argValue(args, "--out", "data/eval_report.json");

  if (!Number.isFinite(trainFrac) || trainFrac <= 0 || trainFrac >= 1) {
    throw new Error(`invalid --train-frac: ${argValue(args, "--train-frac", "")}`);
  }

  const observations = await loadObservations(obsPaths);
  if (observations.length === 0) throw new Error("no usable observations found");

  // Time-ordered split on events (not rows): the newest events validate.
  const eventStart = new Map<string, number>();
  for (const obs of observations) {
    const prev = eventStart.get(obs.eventId);
    if (prev === undefined || obs.eventStart < prev) {
      eventStart.set(obs.eventId, obs.eventStart);
    }
  }
  const orderedEvents = [...eventStart.entries()].sort((a, b) => a[1] - b[1]);
  const cutIndex = Math.max(1, Math.floor(orderedEvents.length * trainFrac));
  const trainEvents = new Set(orderedEvents.slice(0, cutIndex).map(([id]) => id));

  const trainObs = observations.filter((obs) => trainEvents.has(obs.eventId));
  const validObs = observations.filter((obs) => !trainEvents.has(obs.eventId));
  console.log(
    `events=${orderedEvents.length} train=${trainEvents.size} ` +
      `valid=${orderedEvents.length - trainEvents.size} ` +
      `trainObs=${trainObs.length} validObs=${validObs.length}`,
  );

  // Candidate selection on TRAIN only, with live promotion thresholds.
  const trainAgg = aggregate(trainObs);
  const candidates = [...trainAgg.values()].filter(
    (state) =>
      state.events.size >= config.report.minLeaderEvents &&
      state.tokens.size >= config.report.minLeaderTokens,
  );
  const candidateWallets = new Set(candidates.map((c) => c.wallet));

  // Base rate: every scoreable aligned pre-event trade on VALID,
  // candidates or not (the "follow every aligned trade" naive baseline).
  const validScored = validObs.filter(
    (obs) =>
      obs.alignedWithEvent &&
      obs.phase === "pre_event" &&
      obs.directionalReturn60s !== null,
  );
  const validBase = validScored.filter((obs) => (obs.directionalReturn60s ?? 0) > 0).length;
  const baseRate = validScored.length > 0 ? validBase / validScored.length : null;

  // Out-of-sample score for each candidate.
  const validAgg = aggregate(validObs);
  const rows = candidates
    .map((candidate) => {
      const valid = validAgg.get(candidate.wallet);
      return {
        wallet: candidate.wallet,
        trainEvents: candidate.events.size,
        trainTokens: candidate.tokens.size,
        trainMixedFiltered: candidate.mixedEvents,
        trainHitRate: candidate.total > 0 ? candidate.hits / candidate.total : null,
        trainMedianLeadSeconds: median(candidate.leads),
        validObs: valid?.total ?? 0,
        validHitRate:
          valid && valid.total > 0 ? valid.hits / valid.total : null,
        validMedianLeadSeconds: valid ? median(valid.leads) : null,
      };
    })
    .sort((a, b) => b.validObs - a.validObs);

  const scored = rows.filter((row) => row.validHitRate !== null);
  const weightedHits = scored.reduce(
    (sum, row) => sum + (row.validHitRate ?? 0) * row.validObs,
    0,
  );
  const weightedTotal = scored.reduce((sum, row) => sum + row.validObs, 0);
  const candidateRate = weightedTotal > 0 ? weightedHits / weightedTotal : null;

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      split: `time-ordered events, trainFrac=${trainFrac}`,
      candidateThresholds: {
        minLeaderEvents: config.report.minLeaderEvents,
        minLeaderTokens: config.report.minLeaderTokens,
      },
      hit: "aligned pre-event trade with directional60 > 0",
      directionConsistency:
        "wallet-events below 80% dominant side excluded from candidates (pool/MM legs)",
      bases: [...ACCEPTED_BASES],
    },
    events: {
      total: orderedEvents.length,
      train: trainEvents.size,
      valid: orderedEvents.length - trainEvents.size,
    },
    observations: { total: observations.length, train: trainObs.length, valid: validObs.length },
    baseValidHitRate: baseRate,
    candidateValidHitRate: candidateRate,
    lift:
      baseRate !== null && candidateRate !== null && baseRate > 0
        ? candidateRate / baseRate
        : null,
    candidates: rows,
  };

  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log(
    `\ncandidates=${rows.length} baseValidHit=${baseRate?.toFixed(3) ?? "n/a"} ` +
      `candidateValidHit=${candidateRate?.toFixed(3) ?? "n/a"} ` +
      `lift=${report.lift?.toFixed(2) ?? "n/a"}x -> ${outPath}`,
  );
  for (const row of rows.slice(0, 20)) {
    console.log(
      `${row.wallet.slice(0, 8)} trainEv=${row.trainEvents} ` +
        `trainTok=${row.trainTokens} trainHit=${row.trainHitRate?.toFixed(2) ?? "n/a"} ` +
        `validN=${row.validObs} validHit=${row.validHitRate?.toFixed(2) ?? "n/a"}`,
    );
  }
}

await main();
