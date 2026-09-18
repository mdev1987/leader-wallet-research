/**
 * Long-running research worker.
 *
 * Pipeline:
 *   Birdeye discovery -> 1s market candles -> local event detection ->
 *   Helius event-local transactions -> trade parsing -> wallet observations ->
 *   event-level wallet statistics -> persistent leader report.
 *
 * The worker intentionally does not scrape DexScreener for event timing.
 * DexScreener can be used later for independent market-data validation, but
 * event timestamps should come from the finer-grained Birdeye candles.
 */

import { discoverTokens, fetchCandles, isBirdeyeAuthError, isBirdeyeRateLimit } from "./api/birdeye";
import { fetchTransactionsForAddress } from "./api/helius";
import { fetchTokenPairs } from "./api/dexscreener";
import { config } from "./config";
import { detectLatestEvent } from "./research/events";
import {
  attachVolumeShare,
  buildObservation,
  sideVolumes,
} from "./research/observations";
import { parseTrades } from "./research/trades";
import { aggregateWalletEvents, buildWalletReport } from "./research/wallets";
import { evaluateWallets } from "./research/scoring";
import {
  appendJsonl,
  ensureDataDir,
  loadCandidates,
  loadEvents,
  loadEventIds,
  loadObservations,
  path,
  replaceJson,
  saveCandidates,
} from "./storage";
import type { DetectedEvent, TokenCandidate, WalletObservation } from "./types";
import { formatUtc, sleep } from "./utils";

function label(token: TokenCandidate): string {
  return token.symbol || token.address.slice(0, 8);
}

/** Explicit infrastructure labels are configured in config.ts, never inferred from side mix. */
function knownPrograms(): ReadonlyMap<string, "router" | "program"> {
  return new Map(Object.entries(config.walletLabels.knownPrograms));
}

function eventKey(event: DetectedEvent): string {
  return `${event.token.address}:${event.type}:${event.accelerationStart}`;
}

function lastEventByToken(events: DetectedEvent[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const event of events) {
    const current = result.get(event.token.address) ?? 0;
    result.set(event.token.address, Math.max(current, event.accelerationStart));
  }
  return result;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  await ensureDataDir();

  const eventPath = path("events");
  const observationPath = path("observations");
  const candidatesPath = path("candidates");
  const leadersPath = path("leaders");
  const walletEventsPath = path("walletEvents");
  const evalPath = path("evaluation");

  const observations: WalletObservation[] = await loadObservations(observationPath);
  const processedEventIds = await loadEventIds(eventPath);
  const parsedEvents = await loadEvents(eventPath);

  const active = new Map<string, { token: TokenCandidate; lastSeen: number }>();
  for (const token of await loadCandidates(candidatesPath)) {
    active.set(token.address, { token, lastSeen: Date.now() });
  }

  // Static fallback universe for keys whose plan tier blocks token-list
  // discovery. Comma-separated mints; minimal metadata, refreshed by real
  // discovery whenever the plan allows it.
  for (const mint of (process.env.WATCHLIST_MINTS ?? "").split(",")) {
    const address = mint.trim();
    if (address.length <= 20 || active.has(address)) continue;
    if (active.size >= config.discovery.maxTokens) break;
    active.set(address, {
      token: {
        address,
        symbol: address.slice(0, 8),
        name: address.slice(0, 8),
        liquidityUsd: 0,
        volume1hUsd: 0,
        trade1hCount: 0,
      },
      lastSeen: Date.now(),
    });
  }
  if (active.size > 0) console.log(`watchlist: active=${active.size}`);

  const lastEvent = lastEventByToken(parsedEvents);
  const observedEventIds = new Set(observations.map((observation) => observation.eventId));
  const pendingEvents = new Map<string, DetectedEvent>();
  for (const event of parsedEvents) {
    if (event.type !== "crash" && !observedEventIds.has(event.id)) {
      pendingEvents.set(event.id, event);
    }
  }

  let discoveryAt = 0;
  let birdeyeCooldownUntil = 0;

  const refreshReports = async (): Promise<void> => {
    const walletEvents = aggregateWalletEvents(observations);
    const leaders = buildWalletReport(
      walletEvents,
      config.report.minWalletEvents,
      config.report.minWalletTokens,
    );
    const evaluation = evaluateWallets(walletEvents);

    await Bun.write(
      walletEventsPath,
      walletEvents.map((row) => JSON.stringify(row)).join("\n") +
        (walletEvents.length ? "\n" : ""),
    );

    await replaceJson(leadersPath, {
      generatedAt: new Date().toISOString(),
      methodology: {
        evidenceUnit: "one wallet-event, not one trade",
        leadershipWindow: `0-${config.analysis.preSec}s before accelerationStart`,
        mixedWallets: "retained and reported; never hard-filtered",
        infrastructure: "pool/router/program wallet-events remain stored but are excluded from leader promotion and validation",
        crashEvents: "excluded from wallet observations",
      },
      walletEvents: walletEvents.length,
      leaders,
    });

    await replaceJson(evalPath, evaluation);
  };

  await refreshReports();

  const ingestEvent = async (event: DetectedEvent): Promise<void> => {
    if (event.type === "crash") {
      console.log(
        `[event] CRASH ${label(event.token)} move=${event.movePct.toFixed(2)}% ` +
          `at=${formatUtc(event.accelerationStart)} (excluded)`,
      );
      if (!processedEventIds.has(event.id)) {
        processedEventIds.add(event.id);
        await appendJsonl(eventPath, event);
      }
      return;
    }

    if (processedEventIds.has(event.id)) return;

    const previous = lastEvent.get(event.token.address) ?? -Infinity;
    if (event.accelerationStart - previous < config.event.cooldownSec) return;

    lastEvent.set(event.token.address, event.accelerationStart);

    let labeledEvent = event;
    try {
      const pairs = await fetchTokenPairs(event.token.address);
      labeledEvent = {
        ...event,
        poolAddresses: [...new Set(pairs.map((pair) => pair.pairAddress))],
        poolPairs: pairs,
        poolLabelSource: "dexscreener-token-pairs",
      };
      console.log(
        `[labels] ${label(event.token)} pair-addresses=${labeledEvent.poolAddresses?.length ?? 0}`,
      );
    } catch (error) {
      // Pair metadata is labeling-only. A DexScreener outage must never alter
      // the Birdeye event timestamp or suppress the research event.
      labeledEvent = {
        ...event,
        poolAddresses: [],
        poolPairs: [],
        poolLabelSource: "unavailable",
      };
      console.warn(
        `[labels] ${label(event.token)} pair lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    processedEventIds.add(labeledEvent.id);
    await appendJsonl(eventPath, labeledEvent);
    pendingEvents.set(labeledEvent.id, labeledEvent);

    console.log(
      `[event] ${event.type.toUpperCase()} ${label(event.token)} ` +
        `move=${event.movePct.toFixed(2)}% ` +
        `accel=${event.accelerationPct.toFixed(2)}% ` +
        `start=${formatUtc(event.accelerationStart)} ` +
        `confirm=${formatUtc(event.confirmedAt)}`,
    );
  };

  async function analyzeEvent(event: DetectedEvent): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const requiredFuture = Math.max(...config.analysis.forwardOffsetsSec);
    if (now < event.confirmedAt + requiredFuture) return false;

    const transactions = await fetchTransactionsForAddress(
      event.token.address,
      event.accelerationStart - config.analysis.preSec,
      event.confirmedAt + config.analysis.postSec,
    );

    const trades = transactions.flatMap((tx) => parseTrades(tx, event.token.address));
    if (trades.length === 0) {
      console.log(`[analysis] ${label(event.token)} no parsed trades`);
      return true;
    }

    const candles = await fetchCandles(
      event.token.address,
      event.accelerationStart - config.analysis.preSec,
      event.confirmedAt + config.analysis.postSec + requiredFuture + config.birdeye.candleFetchPaddingSec,
    );
    const volumes = sideVolumes(trades);
    let count = 0;

    for (const trade of trades) {
      const observation = buildObservation(
        event,
        trade,
        candles,
        "market-usd",
        {
          poolAddresses: new Set(event.poolAddresses ?? []),
          knownPrograms: knownPrograms(),
        },
      );
      if (!observation) continue;
      const sideVolume = trade.side === "buy" ? volumes.buy : volumes.sell;
      const finalObservation = attachVolumeShare(observation, sideVolume);
      observations.push(finalObservation);
      await appendJsonl(observationPath, finalObservation);
      count += 1;
    }

    console.log(
      `[analysis] ${label(event.token)} txs=${transactions.length} ` +
        `trades=${trades.length} observations=${count}`,
    );
    await refreshReports();
    return true;
  }

  async function processPendingEvents(): Promise<void> {
    for (const [id, event] of pendingEvents) {
      try {
        const completed = await analyzeEvent(event);
        if (completed) pendingEvents.delete(id);
      } catch (error) {
        console.error(
          `[analysis] ${label(event.token)} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  console.log("Starting pump-window leader-wallet research scanner");
  console.log(`restored events=${processedEventIds.size} observations=${observations.length}`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log(`[shutdown] ${signal}`);
      process.exit(0);
    });
  }

  while (true) {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    try {
      if (nowMs - discoveryAt >= config.discovery.everyMs && nowMs >= birdeyeCooldownUntil) {
        try {
          const discovered = await discoverTokens();
          for (const token of discovered) {
            active.set(token.address, { token, lastSeen: nowMs });
          }

          const retained = [...active.values()]
            .filter((state) => nowMs - state.lastSeen <= config.discovery.candidateTtlMs)
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .slice(0, config.discovery.maxTokens);

          active.clear();
          for (const state of retained) active.set(state.token.address, state);

          await saveCandidates(candidatesPath, retained.map((state) => state.token));
          discoveryAt = nowMs;
          console.log(`[discovery] active=${active.size}`);
        } catch (error) {
          if (isBirdeyeAuthError(error)) {
            // Plan-tier block on discovery (e.g. token-list needs a higher
            // tier). Fail fast, retry next discovery interval, and crucially
            // do NOT gate candle scans: OHLCV may still work on this key.
            discoveryAt = nowMs;
            console.warn(
              `[discovery] auth blocked (HTTP ${error.status}, plan tier?): ` +
                `${error.message.slice(0, 150)} — frozen universe kept`,
            );
          } else if (isBirdeyeRateLimit(error)) {
            const cooldown = error.quotaExhausted
              ? config.birdeye.quotaCooldownMs
              : error.retryAfterMs || config.birdeye.rateLimitCooldownMs;
            birdeyeCooldownUntil = Date.now() + cooldown;
            console.warn(`[birdeye] cooldown=${Math.round(cooldown / 1000)}s`);
          } else {
            console.error(`[discovery] ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      if (nowMs >= birdeyeCooldownUntil) {
        for (const { token } of active.values()) {
          try {
            const candles = await fetchCandles(
              token.address,
              nowSec - config.birdeye.candleLookbackSec,
              nowSec,
            );
            const event = detectLatestEvent(token, candles);
            if (event) await ingestEvent(event);
          } catch (error) {
            if (isBirdeyeRateLimit(error)) {
              const cooldown = error.quotaExhausted
                ? config.birdeye.quotaCooldownMs
                : error.retryAfterMs || config.birdeye.rateLimitCooldownMs;
              birdeyeCooldownUntil = Date.now() + cooldown;
              console.warn(`[birdeye] cooldown=${Math.round(cooldown / 1000)}s`);
              break;
            }
            console.error(
              `[scan] ${label(token)} ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else {
        console.log(`[birdeye] cooldown active until ${formatUtc(Math.floor(birdeyeCooldownUntil / 1000))}`);
      }

      await processPendingEvents();
    } catch (error) {
      console.error(`[loop] ${error instanceof Error ? error.message : String(error)}`);
    }

    if (once) break;
    await sleep(config.birdeye.scanEveryMs);
  }
}

await main();
