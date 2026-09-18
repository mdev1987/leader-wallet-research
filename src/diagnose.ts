/**
 * Helius parser coverage diagnostic for a narrow token/event window.
 *
 * Usage:
 *   bun run src/diagnose.ts --token <mint> --start <unix> --end <unix> [--limit 200]
 */

import { fetchTransactionsForAddress } from "./api/helius";
import { parseTrades, type ParseSkipReason } from "./research/trades";

function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const token = argValue(args, "--token", "");
  const start = Number(argValue(args, "--start", "NaN"));
  const end = Number(argValue(args, "--end", "NaN"));
  const limit = Number(argValue(args, "--limit", "200"));

  if (!token) throw new Error("missing --token <mint>");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("invalid --start/--end");
  }

  const maxTransactions = Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : 200;

  const txs = await fetchTransactionsForAddress(token, start, end, {
    maxTransactions,
  });

  const skips = new Map<ParseSkipReason, number>();
  const skipExamples = new Map<ParseSkipReason, string>();
  let trades = 0;
  for (const tx of txs.slice(0, Math.max(1, Math.floor(limit)))) {
    trades += parseTrades(tx, token, (reason) => {
      skips.set(reason, (skips.get(reason) ?? 0) + 1);
      if (!skipExamples.has(reason)) {
        const sig = tx.transaction.signatures?.[0];
        if (sig) skipExamples.set(reason, sig);
      }
    }).length;
  }

  const totalSkips = [...skips.values()].reduce((sum, count) => sum + count, 0);
  console.log(`rawTransactions=${txs.length} limit=${maxTransactions}`);
  console.log(`parsedTrades=${trades} skipEvents=${totalSkips}`);
  for (const [reason, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = totalSkips > 0 ? ((count / totalSkips) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${reason}: ${count} (${pct}%) e.g. ${skipExamples.get(reason) ?? "-"}`,
    );
  }
}

await main();
