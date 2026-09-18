/** File-backed storage for append-only research observations and reports. */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { WalletObservation } from "./types";
import { config } from "./config";
import { LeaderAccumulator } from "./analysis";

/** Ensure the research output directory exists. */
export async function initStorage(): Promise<{
  eventsPath: string;
  observationsPath: string;
  leadersPath: string;
}> {
  await mkdir(config.output.dir, { recursive: true });

  return {
    eventsPath: `${config.output.dir}/${config.output.events}`,
    observationsPath: `${config.output.dir}/${config.output.observations}`,
    leadersPath: `${config.output.dir}/${config.output.leaders}`,
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
