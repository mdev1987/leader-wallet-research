/**
 * Offline evaluator for an existing wallet_events.jsonl file.
 *
 * Usage:
 *   bun run src/eval.ts [--input data/wallet_events.jsonl]
 *
 * This command is intentionally independent of the APIs, so historical files
 * can be re-scored after changing thresholds without spending API quota.
 */

import { config } from "./config";
import { aggregateWalletEvents } from "./research/wallets";
import { evaluateWallets } from "./research/scoring";
import { loadObservations, path, replaceJson } from "./storage";

function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = argValue(args, "--input", path("observations"));
  const output = argValue(args, "--out", path("evaluation"));

  const observations = await loadObservations(input);
  if (observations.length === 0) {
    throw new Error(`no observations found: ${input}`);
  }

  const walletEvents = aggregateWalletEvents(observations);
  const report = evaluateWallets(walletEvents);
  await replaceJson(output, report);

  console.log(
    `observations=${observations.length} walletEvents=${walletEvents.length} -> ${output}`,
  );
}

await main();
