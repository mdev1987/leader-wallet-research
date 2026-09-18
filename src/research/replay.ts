/**
 * Offline replay for compact Helius trade exports.
 *
 * Replay uses continuous 1-second candles made by carrying the latest trade
 * price forward for short gaps. Long gaps are left as gaps and are rejected by
 * the event detector. This avoids the previous sparse-candle timing problem.
 *
 * Usage:
 *   bun run src/replay.ts --token <mint> --trades ./trades.json|./trades.csv
 *     [--symbol VIBE] [--out data/replay]
 */

import { config } from "../config";
import type { Candle, DetectedEvent, TokenCandidate, Trade } from "../types";
import { sleep, median } from "../utils";
import { buildObservation, attachVolumeShare, sideVolumes } from "./observations";
import { detectEvents } from "./events";
import { aggregateWalletEvents, buildWalletReport } from "./wallets";

export function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const lines: string[][] = [];
  let current: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      current.push(field);
      field = "";
    } else if (char === '\n') {
      current.push(field.replace(/\r$/, ""));
      lines.push(current);
      current = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || current.length > 0) {
    current.push(field);
    lines.push(current);
  }

  const header = lines[0] ?? [];
  for (const cells of lines.slice(1)) {
    const row: Record<string, string> = {};
    header.forEach((name, i) => {
      row[name?.trim() ?? ""] = cells[i]?.trim() ?? "";
    });
    rows.push(row);
  }
  return rows;
}

export async function loadTrades(path: string, token: string): Promise<Trade[]> {
  const text = await Bun.file(path).text();
  const rawRows = path.endsWith(".csv")
    ? parseCsv(text)
    : (JSON.parse(text) as Array<Record<string, unknown>>).map((row) => {
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(row)) normalized[key] = String(value ?? "");
        return normalized;
      });

  const trades: Trade[] = [];
  for (const row of rawRows) {
    const type = row.type;
    const timestamp = Number(row.timestamp);
    const tokenAmount = Number(row.tokenAmount);
    const solAmount = Number(row.solAmount);
    const priceSol = Number(row.priceSol);
    const slot = Number(row.slot);
    if (
      (type !== "buy" && type !== "sell") ||
      !Number.isFinite(timestamp) ||
      !Number.isFinite(tokenAmount) ||
      tokenAmount <= 0 ||
      !Number.isFinite(solAmount) ||
      solAmount <= 0 ||
      !row.wallet ||
      !row.signature
    ) {
      continue;
    }

    trades.push({
      token,
      timestamp: Math.floor(timestamp),
      side: type,
      wallet: row.wallet,
      tokenAmount,
      solAmount,
      priceSol: Number.isFinite(priceSol) && priceSol > 0 ? priceSol : solAmount / tokenAmount,
      signature: row.signature,
      slot: Number.isFinite(slot) ? slot : 0,
      priceQuality: "balance-delta",
    });
  }

  // One signature should never count twice in a replay dataset.
  return [...new Map(trades.map((trade) => [trade.signature + ":" + trade.wallet, trade])).values()]
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Build a continuous 1-second series. Prices are carried forward only when the
 * gap is <= maxGapSec; a longer gap becomes a hard discontinuity for research.
 */
export function continuousCandles(
  trades: Trade[],
  maxGapSec: number = config.replay.maxCandleGapSec,
): Candle[] {
  if (trades.length === 0) return [];

  const bySecond = new Map<number, { prices: number[]; volumeSol: number }>();
  for (const trade of trades) {
    const bucket = bySecond.get(trade.timestamp) ?? { prices: [], volumeSol: 0 };
    bucket.prices.push(trade.priceSol);
    bucket.volumeSol += trade.solAmount;
    bySecond.set(trade.timestamp, bucket);
  }

  const times = [...bySecond.keys()].sort((a, b) => a - b);
  const candles: Candle[] = [];
  let previousPrice: number | null = null;
  let previousTime: number | null = null;

  for (const time of times) {
    const bucket = bySecond.get(time)!;
    const price = median(bucket.prices);
    if (price === null || price <= 0) continue;

    if (previousPrice !== null && previousTime !== null) {
      const gap = time - previousTime;
      if (gap <= maxGapSec) {
        for (let t = previousTime + 1; t < time; t += 1) {
          candles.push({
            unixTime: t,
            open: previousPrice,
            high: previousPrice,
            low: previousPrice,
            close: previousPrice,
            // No USD volume exists in the compact export; keep market-volume
            // context empty rather than pretending SOL volume is USD volume.
            volumeUsd: 0,
          });
        }
      }
    }

    candles.push({
      unixTime: time,
      open: price,
      high: price,
      low: price,
      close: price,
      // The compact export contains SOL amounts, not USD candle volume.
      volumeUsd: 0,
    });

    previousPrice = price;
    previousTime = time;
  }

  return candles.sort((a, b) => a.unixTime - b.unixTime);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tokenAddress = argValue(args, "--token", "");
  const tradesPath = argValue(args, "--trades", "./trades.json");
  const symbol = argValue(args, "--symbol", tokenAddress.slice(0, 8));
  const outputBase = argValue(args, "--out", "./data/replay");
  const maxGapSec = Number(argValue(args, "--max-gap-sec", String(config.replay.maxCandleGapSec)));
  const poolAddresses = argValue(args, "--pool-addresses", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!Number.isFinite(maxGapSec) || maxGapSec < 0 || maxGapSec > 60) {
    throw new Error(`invalid --max-gap-sec: ${maxGapSec}`);
  }

  if (!tokenAddress) throw new Error("missing --token <mint>");

  const token: TokenCandidate = {
    address: tokenAddress,
    symbol,
    name: symbol,
    liquidityUsd: 0,
    volume1hUsd: 0,
    trade1hCount: 0,
  };

  const trades = await loadTrades(tradesPath, tokenAddress);
  if (trades.length === 0) throw new Error("no usable trades found");

  const candles = continuousCandles(trades, maxGapSec);
  console.log(`trades=${trades.length} candles=${candles.length}`);
  console.log(`first=${new Date(trades[0]!.timestamp * 1000).toISOString()}`);
  console.log(`last=${new Date(trades.at(-1)!.timestamp * 1000).toISOString()}`);

  const events = detectEvents(token, candles);
  const researchEvents = events.filter((event) => event.type !== "crash");

  const observations: NonNullable<ReturnType<typeof buildObservation>>[] = [];
  for (const event of researchEvents) {
    const windowTrades = trades.filter(
      (trade) =>
        trade.timestamp >= event.accelerationStart - config.analysis.preSec &&
        trade.timestamp <= event.confirmedAt + config.analysis.postSec,
    );
    const volumes = sideVolumes(windowTrades);

    for (const trade of windowTrades) {
      const raw = buildObservation(
        event,
        trade,
        candles,
        "trade-sol",
        { poolAddresses: new Set(poolAddresses) },
      );
      if (!raw) continue;
      const sideVolume = trade.side === "buy" ? volumes.buy : volumes.sell;
      observations.push(attachVolumeShare(raw, sideVolume));
    }
  }

  const walletEvents = aggregateWalletEvents(observations);
  const report = buildWalletReport(
    walletEvents,
    config.report.minWalletEvents,
    config.report.minWalletTokens,
  );

  const eventLines = events.map((event) => JSON.stringify(event)).join("\n");
  const observationLines = observations.map((row) => JSON.stringify(row)).join("\n");
  const walletEventLines = walletEvents.map((row) => JSON.stringify(row)).join("\n");

  await Bun.write(`${outputBase}_events.jsonl`, eventLines ? `${eventLines}\n` : "");
  await Bun.write(`${outputBase}_observations.jsonl`, observationLines ? `${observationLines}\n` : "");
  await Bun.write(`${outputBase}_wallet_events.jsonl`, walletEventLines ? `${walletEventLines}\n` : "");
  await Bun.write(
    `${outputBase}_report.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: { tradesPath, tradeCount: trades.length },
        candles: {
          count: candles.length,
          type: "continuous 1s trade-price series with bounded gap bridging",
          maxGapSec,
          priceQuality: "balance-delta",
        },
        events: {
          total: events.length,
          research: researchEvents.length,
          crashesExcluded: events.filter((event) => event.type === "crash").length,
        },
        observations: observations.length,
        walletEvents: walletEvents.length,
        leaderWallets: report,
      },
      null,
      2,
    ),
  );

  console.log(`events=${events.length} researchEvents=${researchEvents.length}`);
  console.log(`observations=${observations.length} walletEvents=${walletEvents.length}`);
  console.log(`leaderWallets=${report.length}`);
}

await main();
