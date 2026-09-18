/**
 * Parse-coverage diagnostic: fetch a bounded sample of raw Helius
 * transactions for a token window and histogram why each transaction (or
 * token leg) did or did not produce a trade.
 *
 * Usage:
 *   bun run src/diagnose.ts --token <mint> --start <unix> --end <unix>
 *     [--limit 200]
 *
 * Read-only against the Helius API; writes nothing.
 */

import { fetchTransactionsForAddress } from "./api/helius";
import { parseTrades, type ParseSkipReason } from "./analysis";

function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] ?? fallback;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const token = argValue(args, "--token", "");
  const start = Number(argValue(args, "--start", ""));
  const end = Number(argValue(args, "--end", ""));
  const limit = Number(argValue(args, "--limit", "200"));

  if (!token) throw new Error("missing required --token <mint>");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("missing or invalid --start/--end unix timestamps");
  }

  const transactions = await fetchTransactionsForAddress(token, start, end, {
    maxTransactions: Number.isFinite(limit) && limit > 0 ? limit : 200,
  });
  console.log(`fetched ${transactions.length} raw transactions`);

  const skips = new Map<ParseSkipReason, number>();
  const skipExamples = new Map<ParseSkipReason, string>();
  let trades = 0;

  for (const tx of transactions) {
    const parsed = parseTrades(tx, token, (reason) => {
      skips.set(reason, (skips.get(reason) ?? 0) + 1);
      if (!skipExamples.has(reason)) {
        const sig = tx.transaction.signatures?.[0];
        if (sig) skipExamples.set(reason, sig);
      }
    });
    trades += parsed.length;
  }

  const totalSkips = [...skips.values()].reduce((sum, n) => sum + n, 0);
  console.log(`trades=${trades} skip-events=${totalSkips}`);
  for (const [reason, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = totalSkips > 0 ? ((count / totalSkips) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${reason}: ${count} (${pct}%) e.g. ${skipExamples.get(reason) ?? "-"}`,
    );
  }
}

await main();
