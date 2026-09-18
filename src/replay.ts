/**
 * Offline replay harness: run the live event detector + observation builder
 * over a historical compact-trade file (trades.json / CSV shape produced by
 * get_tx_for_address.ts), without touching any network API.
 *
 * 1s candles are synthesized from trade prices (median price per second), so
 * forward returns are trade-price-based and labeled forwardBasis "trade".
 * A candle-gap tolerance keeps sparse-data labels honest: a "+60s" return is
 * only recorded when a candle exists near trade+60s.
 *
 * Usage:
 *   bun run src/replay.ts --token <mint> [--symbol X] [--trades ./trades.json]
 *     [--out data/replay] [--gap 5]
 *
 * Outputs (re-runnable, rewritten each run — never appended to live data):
 *   <out>_events.jsonl, <out>_observations.jsonl, <out>_report.json
 */

import { writeFile } from "node:fs/promises";
import { config } from "./config";
import {
  buildObservation,
  detectLatestEvent,
  LeaderAccumulator,
  sideVolumesSol,
  withVolumeShare,
} from "./analysis";
import type { Candle, DetectedEvent, TokenCandidate, Trade } from "./types";
import { median } from "./utils";

type RawCompactTrade = {
  timestamp: number;
  type: string;
  wallet: string;
  tokenAmount: number;
  solAmount: number;
  priceSol: number;
  signature: string;
  slot: number;
};

function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] ?? fallback;
}

function parseCsv(text: string): RawCompactTrade[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0];
  if (!header) return [];

  const columns = header.split(",").map((c) => c.trim());
  const col = (name: string): number => columns.indexOf(name);
  const rows: RawCompactTrade[] = [];

  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    const num = (name: string): number => {
      const raw = cells[col(name)] ?? "";
      return Number(raw);
    };
    const timestamp = num("timestamp");
    const wallet = cells[col("wallet")] ?? "";
    const signature = cells[col("signature")] ?? "";
    if (!Number.isFinite(timestamp) || !wallet || !signature) continue;
    rows.push({
      timestamp,
      type: cells[col("type")] ?? "",
      wallet,
      tokenAmount: num("tokenAmount"),
      solAmount: num("solAmount"),
      priceSol: num("priceSol"),
      signature,
      slot: num("slot"),
    });
  }

  return rows;
}

async function loadCompactTrades(path: string): Promise<RawCompactTrade[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`trades file not found: ${path}`);
  }

  if (path.endsWith(".csv")) {
    return parseCsv(await file.text());
  }

  const json = (await file.json()) as RawCompactTrade[];
  if (!Array.isArray(json)) throw new Error(`expected a JSON array in ${path}`);
  return json;
}

function toTrades(raw: RawCompactTrade[], token: string): Trade[] {
  const trades: Trade[] = [];

  for (const entry of raw) {
    if (entry.type !== "buy" && entry.type !== "sell") continue;
    if (
      !Number.isFinite(entry.timestamp) ||
      !Number.isFinite(entry.tokenAmount) ||
      entry.tokenAmount <= 0 ||
      !Number.isFinite(entry.solAmount) ||
      entry.solAmount <= 0 ||
      !entry.wallet ||
      !entry.signature
    ) {
      continue;
    }

    trades.push({
      token,
      timestamp: Math.floor(entry.timestamp),
      side: entry.type,
      wallet: entry.wallet,
      tokenAmount: entry.tokenAmount,
      solAmount: entry.solAmount,
      priceSol:
        Number.isFinite(entry.priceSol) && entry.priceSol > 0
          ? entry.priceSol
          : entry.solAmount / entry.tokenAmount,
      signature: entry.signature,
      slot: Number.isFinite(entry.slot) ? entry.slot : 0,
    });
  }

  return trades.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Synthesize 1s candles from trade prices. Close = median trade price in
 * that second; volume carries SOL turnover (only relative volume ratios are
 * ever used downstream, so the SOL-vs-USD unit does not matter here).
 */
function synthesizeCandles(trades: Trade[]): Candle[] {
  const bySecond = new Map<number, { prices: number[]; volume: number }>();

  for (const trade of trades) {
    const bucket = bySecond.get(trade.timestamp) ?? { prices: [], volume: 0 };
    bucket.prices.push(trade.priceSol);
    bucket.volume += trade.solAmount;
    bySecond.set(trade.timestamp, bucket);
  }

  const candles: Candle[] = [];
  for (const [unixTime, bucket] of [...bySecond.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const close = median(bucket.prices);
    if (close === null || close <= 0) continue;
    candles.push({
      unixTime,
      open: close,
      high: close,
      low: close,
      close,
      volumeUsd: bucket.volume,
    });
  }

  return candles;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tokenAddress = argValue(args, "--token", "");
  if (!tokenAddress) {
    throw new Error("missing required --token <mint>");
  }

  const token: TokenCandidate = {
    address: tokenAddress,
    symbol: argValue(args, "--symbol", tokenAddress.slice(0, 8)),
    name: argValue(args, "--symbol", tokenAddress.slice(0, 8)),
    liquidityUsd: 0,
    volume1hUsd: 0,
    trade1hCount: 0,
  };

  const tradesPath = argValue(args, "--trades", "./trades.json");
  const outPrefix = argValue(args, "--out", "data/replay");
  const gapSec = Number(argValue(args, "--gap", "5"));

  const raw = await loadCompactTrades(tradesPath);
  const trades = toTrades(raw, token.address);
  if (trades.length === 0) throw new Error("no usable trades found");

  const candles = synthesizeCandles(trades);
  console.log(
    `loaded ${trades.length} trades -> ${candles.length} synthetic 1s candles`,
  );

  // Slide the live detector over candle history with identical parameters,
  // per-token cooldown and idempotent event IDs.
  const events: DetectedEvent[] = [];
  const seenIds = new Set<string>();
  const lastEventByToken = new Map<string, number>();
  let windowStart = 0;

  for (let i = 0; i < candles.length; i++) {
    const end = candles[i];
    if (!end) continue;

    while (windowStart < i) {
      const first = candles[windowStart];
      if (first && end.unixTime - first.unixTime <= config.birdeye.candleLookbackSec) {
        break;
      }
      windowStart += 1;
    }

    const event = detectLatestEvent(token, candles.slice(windowStart, i + 1));
    if (!event || seenIds.has(event.id)) continue;

    const lastEvent = lastEventByToken.get(token.address) ?? 0;
    if (event.startTime - lastEvent < config.event.cooldownSec) continue;

    lastEventByToken.set(token.address, event.startTime);
    seenIds.add(event.id);
    events.push(event);
  }

  console.log(`detected ${events.length} events`);

  const accumulator = new LeaderAccumulator(["trade"]);
  const eventLines: string[] = [];
  const observationLines: string[] = [];

  for (const event of events) {
    eventLines.push(JSON.stringify(event));

    const windowTrades = trades.filter(
      (trade) =>
        trade.timestamp >= event.startTime - config.analysis.preSec &&
        trade.timestamp <= event.endTime + config.analysis.postSec,
    );
    const volumes = sideVolumesSol(windowTrades);

    for (const trade of windowTrades) {
      const rawObservation = buildObservation(event, trade, candles, {
        maxCandleGapSec: Number.isFinite(gapSec) ? gapSec : 5,
      });
      if (!rawObservation) continue;

      const observation = withVolumeShare(
        { ...rawObservation, forwardBasis: "trade" },
        trade.side === "buy" ? volumes.buy : volumes.sell,
      );
      observationLines.push(JSON.stringify(observation));
      accumulator.add(observation);
    }
  }

  await writeFile(`${outPrefix}_events.jsonl`, `${eventLines.join("\n")}\n`, "utf8");
  await writeFile(
    `${outPrefix}_observations.jsonl`,
    observationLines.length > 0 ? `${observationLines.join("\n")}\n` : "",
    "utf8",
  );
  await writeFile(
    `${outPrefix}_report.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: { trades: tradesPath, tradeCount: trades.length },
        methodology: {
          candles: "synthetic 1s from trade-price medians (SOL-denominated)",
          forwardBasis: "trade",
          candleGapToleranceSec: Number.isFinite(gapSec) ? gapSec : 5,
          eventWindow: `-${config.analysis.preSec}s to +${config.analysis.postSec}s around event start`,
          pumpDumpMove: `${config.event.movePct}% over ${config.event.moveSec}s`,
          acceleration: `${config.event.accelerationPct}% over ${config.event.accelerationSec}s`,
          minLeaderEvents: config.report.minLeaderEvents,
          minLeaderTokens: config.report.minLeaderTokens,
        },
        events: events.length,
        observations: observationLines.length,
        wallets: accumulator.report(),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `events=${events.length} observations=${observationLines.length} ` +
      `leaders=${accumulator.report().length} -> ${outPrefix}_*`,
  );
}

await main();
