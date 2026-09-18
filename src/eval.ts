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
        if (!obs.alignedWithEvent || obs.phase !== "pre_event") continue;
        if (obs.directionalReturn60s === null) continue;
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
};

function aggregate(observations: WalletObservation[]): Map<string, WalletAggregate> {
  const byWallet = new Map<string, WalletAggregate>();

  for (const obs of observations) {
    const state = byWallet.get(obs.wallet) ?? {
      wallet: obs.wallet,
      events: new Set<string>(),
      tokens: new Set<string>(),
      hits: 0,
      total: 0,
      leads: [],
    };

    state.events.add(obs.eventId);
    state.tokens.add(obs.token);
    state.total += 1;
    if ((obs.directionalReturn60s ?? 0) > 0) state.hits += 1;
    state.leads.push(obs.leadSeconds);
    byWallet.set(obs.wallet, state);
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

  // Base rate: every aligned pre-event trade on VALID, candidates or not.
  const validBase = validObs.filter((obs) => (obs.directionalReturn60s ?? 0) > 0).length;
  const baseRate = validObs.length > 0 ? validBase / validObs.length : null;

  // Out-of-sample score for each candidate.
  const validAgg = aggregate(validObs);
  const rows = candidates
    .map((candidate) => {
      const valid = validAgg.get(candidate.wallet);
      return {
        wallet: candidate.wallet,
        trainEvents: candidate.events.size,
        trainTokens: candidate.tokens.size,
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
