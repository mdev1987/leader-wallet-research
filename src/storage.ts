/** File-backed storage for append-only research observations and reports. */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { TokenCandidate, WalletObservation } from "./types";
import { config } from "./config";
import { LeaderAccumulator } from "./analysis";

/** Ensure the research output directory exists. */
export async function initStorage(): Promise<{
  eventsPath: string;
  observationsPath: string;
  leadersPath: string;
  candidatesPath: string;
}> {
  await mkdir(config.output.dir, { recursive: true });

  return {
    eventsPath: `${config.output.dir}/${config.output.events}`,
    observationsPath: `${config.output.dir}/${config.output.observations}`,
    leadersPath: `${config.output.dir}/${config.output.leaders}`,
    candidatesPath: `${config.output.dir}/candidates.json`,
  };
}

/** Append one JSON object as one JSONL record. */
export async function appendJsonl(
  filePath: string,
  value: unknown,
): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

/** Load previous event IDs to make restarts idempotent. */
export async function loadEventIds(filePath: string): Promise<Set<string>> {
  const text = await readFile(filePath, "utf8").catch(() => "");
  const ids = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line) as { id?: string };
      if (event.id) ids.add(event.id);
    } catch {
      console.warn("[warn] skipped malformed event record");
    }
  }

  return ids;
}

/** Event IDs that already have at least one observation row. */
export async function loadObservedEventIds(filePath: string): Promise<Set<string>> {
  const text = await readFile(filePath, "utf8").catch(() => "");
  const ids = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    try {
      const obs = JSON.parse(line) as { eventId?: string };
      if (obs.eventId) ids.add(obs.eventId);
    } catch {
      // Malformed rows are skipped by loadObservations too.
    }
  }

  return ids;
}

/** Persist the active token universe so restarts keep a warm watchlist. */
export async function saveCandidates(
  filePath: string,
  candidates: TokenCandidate[],
): Promise<void> {
  await writeFile(filePath, JSON.stringify(candidates), "utf8").catch((error) => {
    console.warn(
      `[warn] could not save candidates: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/** Restore the watchlist; entries get fresh timestamps (see caller). */
export async function loadCandidates(filePath: string): Promise<TokenCandidate[]> {
  const text = await readFile(filePath, "utf8").catch(() => "");
  if (!text.trim()) return [];

  try {
    const raw = JSON.parse(text) as Array<Record<string, unknown>>;
    return raw
      .filter((item) => typeof item.address === "string" && item.address.length > 20)
      .map((item) => ({
        address: String(item.address),
        symbol: String(item.symbol ?? ""),
        name: String(item.name ?? item.symbol ?? ""),
        liquidityUsd: Number(item.liquidityUsd ?? 0),
        volume1hUsd: Number(item.volume1hUsd ?? 0),
        trade1hCount: Number(item.trade1hCount ?? 0),
      }));
  } catch {
    console.warn("[warn] skipped malformed candidates file");
    return [];
  }
}

/** Restore wallet statistics from prior observation JSONL. */
export async function loadObservations(
  filePath: string,
  accumulator: LeaderAccumulator,
): Promise<number> {
  const text = await readFile(filePath, "utf8").catch(() => "");
  let count = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    try {
      accumulator.add(JSON.parse(line) as WalletObservation);
      count += 1;
    } catch {
      console.warn("[warn] skipped malformed observation record");
    }
  }

  return count;
}

/** Write the current human-readable leader-wallet report. */
export async function writeLeaderReport(
  filePath: string,
  accumulator: LeaderAccumulator,
): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        methodology: {
          eventWindow: `-${config.analysis.preSec}s to +${config.analysis.postSec}s around event start`,
          pumpDumpMove: `${config.event.movePct}% over ${config.event.moveSec}s`,
          acceleration: `${config.event.accelerationPct}% over ${config.event.accelerationSec}s`,
          forwardBasis:
            "candle-to-candle USD closes; dump-sell 60s returns sign-flipped so + means price fell",
          forwardBases:
            "candle = Birdeye 1s USD; dex = DexScreener spot-sample USD fallback during Birdeye cooldowns",
          volumeShare:
            "trade SOL / same-side event-window SOL volume; size-adjusted return = directional * (1 - share), primary sort key",
          directionConsistency:
            "a wallet's event counts only when its dominant side there is >= 80% (pool/MM legs are ~50/50 and never qualify)",
          minLeaderEvents: config.report.minLeaderEvents,
          minLeaderTokens: config.report.minLeaderTokens,
        },
        wallets: accumulator.report(),
      },
      null,
      2,
    ),
    "utf8",
  );
}
