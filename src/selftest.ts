/**
 * Offline sanity checks for wallet labeling/features (v4) and the
 * permutation-null evaluator (v5).
 *
 * This does not call external APIs. It verifies pair-address labeling, the
 * five-way label shape, phase-aware aggregation, candle-price entry fields,
 * infra exclusion, and permutation determinism/bounds on a synthetic fixture.
 */

import { aggregateWalletEvents, buildWalletReport } from "./research/wallets";
import { buildObservation } from "./research/observations";
import { classifyWallet } from "./research/labels";
import { evaluateWallets } from "./research/scoring";
import { toCandidate } from "./api/dbotx";
import type { Candle, DetectedEvent, Trade, WalletEventStats } from "./types";

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

// --- v5 permutation-null fixture: 6 events (4 train / 2 valid at 70%) ---
// LEAD is perfect on train (3 events, 2 tokens) and valid (2 events);
// background is mixed. A working null must sit near the base rate with a
// small p-value; a broken (identity) shuffle would report pValue ~= 1.
function stat(
  wallet: string,
  eventId: string,
  eventTime: number,
  token: string,
  positive60: boolean,
): WalletEventStats {
  return {
    wallet, eventId, eventTime, token, symbol: token, eventType: "pump",
    firstAlignedTradeTime: eventTime, lastAlignedTradeTime: eventTime,
    firstAlignedLeadSeconds: 60, firstBuyLeadSeconds: 60, firstSellLeadSeconds: null,
    firstBuyOffsetSec: -60, lastBuyOffsetSec: -60, netVolumeSol: 1,
    preBreakoutTradeCount: 1,
    alignedTradeCount: 1, alignedVolumeSol: 1,
    buyVolumeSol: 1, sellVolumeSol: 0,
    buyCount: 1, sellCount: 0, sideConsistency: 1,
    earliestTradeTime: eventTime - 60, latestTradeTime: eventTime - 60,
    maxDirectional60: positive60 ? 5 : -5,
    medianDirectional60: positive60 ? 5 : -5,
    buyDirectional: { "60": positive60 ? 5 : -5 },
    sellDirectional: {},
    positive60, medianVolumeShare: 0.01, eventLiquidityUsd: 100_000,
    walletType: "trader", walletTypeReason: "default",
  };
}

// NOTE: noise wallets stay at 2 train events so LEAD is the only train
// candidate; otherwise the null has nothing to beat and the test is vacuous.
const fixture: WalletEventStats[] = [
  stat("LEAD", "e1", 100, "tokA", true),
  stat("LEAD", "e2", 200, "tokB", true),
  stat("LEAD", "e3", 300, "tokA", true),
  stat("LEAD", "e5", 500, "tokC", true),
  stat("LEAD", "e6", 600, "tokA", true),
  stat("NOISE1", "e1", 100, "tokA", false),
  stat("NOISE1", "e4", 400, "tokB", false),
  stat("NOISE1", "e5", 500, "tokC", false),
  stat("NOISE1", "e6", 600, "tokA", true),
  stat("NOISE2", "e1", 100, "tokA", false),
  stat("NOISE2", "e3", 300, "tokA", false),
  stat("NOISE2", "e5", 500, "tokC", false),
  stat("NOISE2", "e6", 600, "tokA", false),
];

const runA = evaluateWallets(fixture);
const runB = evaluateWallets(fixture);
const permA = runA.permutation;
const permB = runB.permutation;

if (permA.skipped !== null) throw new Error(`permutation skipped: ${permA.skipped}`);
if (permA.pValue === null || permA.nullMean === null || permA.observedRate === null) {
  throw new Error("permutation produced null statistics on testable fixture");
}
// Determinism: same seed must give the same null.
if (permA.pValue !== permB.pValue || permA.nullMean !== permB.nullMean) {
  throw new Error("permutation null is not deterministic");
}
// Bounds.
for (const value of [permA.pValue, permA.nullMean, permA.observedRate]) {
  if (!(value >= 0 && value <= 1)) throw new Error("permutation statistic out of bounds");
}
for (const ci of [permA.candidateCI95, permA.baseCI95]) {
  if (ci === null || !(ci[0] >= 0 && ci[0] <= ci[1] && ci[1] <= 1)) {
    throw new Error("bootstrap CI out of bounds");
  }
}
// A perfect candidate against a mixed background must beat the null clearly.
// (Identity shuffle would report nullMean == observed and pValue == 1.)
if (!(permA.nullMean < permA.observedRate)) {
  throw new Error("null mean should sit below a perfect observed rate");
}
if (!(permA.pValue < 0.5)) {
  throw new Error("perfect candidate must have a small p-value");
}
if (runA.candidates.length !== 1 || runA.candidates[0]?.wallet !== "LEAD") {
  throw new Error("expected exactly LEAD as the train candidate");
}

console.log("v4.1 selftest: PASS");
console.log(
  `v5 selftest: PASS (p=${permA.pValue.toFixed(3)} nullMean=${permA.nullMean.toFixed(3)} obs=${permA.observedRate.toFixed(2)})`,
);

// --- DBotX mapper: hot-shape row maps, sparse/new-shape row is filtered
// (no market cap), invalid row is skipped. Thresholds come from config.
const nowMs = Date.now();
const mapped = toCandidate(
  {
    token: "MINT111111111111111111111111111111111111",
    symbol: "HOT",
    name: "Hot Token",
    marketCap: 50_000,
    holders: 200,
    solReserve: 10,
    buyAndSellTimes1h: 500,
    pair: "PAIR1111111111111111111111111111111111111",
    tokenCreatedAt: nowMs - 3_600_000,
  },
  150,
  nowMs,
);
if (!mapped || mapped.address === "" || mapped.pairAddress === undefined) {
  throw new Error("hot-shape DBotX row must map with seeded pair address");
}
if (!(mapped.liquidityUsd > 0)) throw new Error("SOL reserve must convert to USD liquidity");
const thin = toCandidate(
  { token: "MINT222222222222222222222222222222222222", symbol: "NEW" },
  150,
  nowMs,
);
if (thin !== null) throw new Error("row without market cap must be filtered");
const invalid = toCandidate({ symbol: "BAD" }, 150, nowMs);
if (invalid !== null) throw new Error("row without address must be skipped");

console.log("discovery selftest: PASS");
