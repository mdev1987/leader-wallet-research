/**
 * Offline sanity checks for v4 additive wallet labeling/features.
 *
 * This does not call external APIs. It verifies pair-address labeling, the
 * five-way label shape, phase-aware aggregation, and candle-price entry fields.
 */

import { aggregateWalletEvents, buildWalletReport } from "./research/wallets";
import { buildObservation } from "./research/observations";
import { classifyWallet } from "./research/labels";
import type { Candle, DetectedEvent, Trade } from "./types";

const wallet = "WALLET";
const pair = "PAIR";

const label = classifyWallet(wallet, true, {
  poolAddresses: new Set([pair]),
  knownPrograms: new Map(),
});
if (label.type !== "trader" || label.reason !== "default") {
  throw new Error("expected signer wallet to remain trader/default");
}

const poolLabel = classifyWallet(pair, false, {
  poolAddresses: new Set([pair]),
  knownPrograms: new Map(),
});
if (poolLabel.type !== "pool" || poolLabel.reason !== "pair-address") {
  throw new Error("expected pair address to be labeled pool/pair-address");
}

const event: DetectedEvent = {
  id: "token:pump:100",
  token: {
    address: "TOKEN",
    symbol: "TEST",
    name: "TEST",
    liquidityUsd: 100_000,
    volume1hUsd: 200_000,
    trade1hCount: 1_000,
  },
  type: "pump",
  accelerationStart: 100,
  breakoutStart: 130,
  confirmedAt: 160,
  movePct: 20,
  accelerationPct: 5,
  breakoutPct: 15,
  volumeAcceleration: 2,
  poolAddresses: [pair],
  poolLabelSource: "dexscreener-token-pairs",
};

const candles: Candle[] = [];
for (let t = 0; t <= 220; t += 1) {
  candles.push({
    unixTime: t,
    open: 1,
    high: 1,
    low: 1,
    close: 1 + t / 1_000,
    volumeUsd: 10,
  });
}

const trades: Trade[] = [
  {
    token: "TOKEN", timestamp: 70, side: "buy", wallet, tokenAmount: 100,
    solAmount: 1, priceSol: 0.01, signature: "A", slot: 1,
    priceQuality: "balance-delta", isSigner: true,
  },
  {
    token: "TOKEN", timestamp: 115, side: "buy", wallet, tokenAmount: 50,
    solAmount: 0.7, priceSol: 0.014, signature: "B", slot: 2,
    priceQuality: "balance-delta", isSigner: true,
  },
  {
    token: "TOKEN", timestamp: 145, side: "sell", wallet, tokenAmount: 20,
    solAmount: 0.5, priceSol: 0.025, signature: "C", slot: 3,
    priceQuality: "balance-delta", isSigner: true,
  },
];

const observations = trades
  .map((trade) => buildObservation(
    event, trade, candles, "market-usd", {
      poolAddresses: new Set([pair]),
      knownPrograms: new Map(),
    },
  ))
  .filter((row): row is NonNullable<typeof row> => row !== null);

const rows = aggregateWalletEvents(observations);
const row = rows[0];
if (!row) throw new Error("expected one wallet-event row");
if (row.phaseVolumes?.pre_event.buy !== 1) throw new Error("pre-event buy volume failed");
if (row.phaseVolumes?.acceleration.buy !== 0.7) throw new Error("acceleration buy volume failed");
if (row.phaseVolumes?.breakout.sell !== 0.5) throw new Error("breakout sell volume failed");
if (row.phaseTradeCounts?.breakout.sell !== 1) throw new Error("breakout sell count failed");
if (row.avgEntryPriceUsd === null) throw new Error("expected candle-based average entry price");
if (row.walletType !== "trader") throw new Error("expected trader wallet type");

const infraTrade: Trade = {
  token: "TOKEN", timestamp: 145, side: "sell", wallet: pair, tokenAmount: 20,
  solAmount: 0.5, priceSol: 0.025, signature: "POOL-TX", slot: 4,
  priceQuality: "balance-delta", isSigner: false,
};
const infraObservation = buildObservation(
  event, infraTrade, candles, "market-usd", {
    poolAddresses: new Set([pair]),
    knownPrograms: new Map(),
  },
);
if (!infraObservation || infraObservation.walletType !== "pool") {
  throw new Error("expected pair address observation to be pool-labeled");
}
const report = buildWalletReport(
  aggregateWalletEvents([...observations, infraObservation]),
  1,
  1,
);
if (report.some((entry) => entry.wallet === pair)) {
  throw new Error("infrastructure wallet must not be promoted to leader report");
}

// Discriminating infra-exclusion case: pool-labeled ALIGNED pre-event buys
// must not promote even at minEvents=1. (The unaligned-only leg above would
// be excluded by the pre-existing aligned filter, so only aligned buys prove
// the infrastructure exclusion itself.)
const poolTrades: Trade[] = [70, 80, 90].map((timestamp, index) => ({
  token: "TOKEN", timestamp, side: "buy", wallet: pair, tokenAmount: 200,
  solAmount: 2, priceSol: 0.01, signature: `P${index}`, slot: 10 + index,
  priceQuality: "balance-delta", isSigner: false,
}));
const poolObservations = poolTrades
  .map((trade) => buildObservation(
    event, trade, candles, "market-usd", {
      poolAddresses: new Set([pair]),
      knownPrograms: new Map(),
    },
  ))
  .filter((row): row is NonNullable<typeof row> => row !== null);
if (poolObservations.length !== 3) throw new Error("expected three pool observations");
if (poolObservations.some((row) => row.walletType !== "pool")) {
  throw new Error("expected pair-address observations to be pool-labeled");
}

const mixedReport = buildWalletReport(
  aggregateWalletEvents([...observations, ...poolObservations]),
  1,
  1,
);
if (mixedReport.some((entry) => entry.wallet === pair)) {
  throw new Error("pool wallet with aligned buys must not be promoted");
}
const traderRow = mixedReport.find((entry) => entry.wallet === wallet);
if (!traderRow) throw new Error("trader must still be promoted");
if (traderRow.infrastructureEventsExcluded !== 0) {
  throw new Error("trader row must audit zero excluded infra events");
}

console.log("v4.1 selftest: PASS");
