/**
 * Main long-running research worker.
 *
 * Pipeline:
 *   Birdeye token discovery
 *       -> 1s OHLCV event detection
 *       -> narrow Helius transaction query
 *       -> wallet/trade parsing
 *       -> event-relative observations
 *       -> reusable leader-wallet report
 */

import { discoverTokens, fetchCandles, isRateLimitError } from "./api/birdeye";
import { fetchTransactionsForAddress } from "./api/helius";
import { config } from "./config";
import {
  buildObservation,
  detectLatestEvent,
  LeaderAccumulator,
  parseTrades,
} from "./analysis";
import type { DetectedEvent, TokenCandidate } from "./types";
import { appendJsonl, initStorage, loadEventIds, loadObservations, writeLeaderReport } from "./storage";
import { sleep } from "./utils";

function tokenLabel(token: TokenCandidate): string {
  return token.symbol || token.address.slice(0, 8);
}

// Timed runs (e.g. `timeout 900 bun run src/main.ts`) send SIGTERM.
// JSONL output is append-only, so exiting here is safe and resumable.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[shutdown] received ${signal}, exiting (progress is saved, resume by re-running)`);
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const paths = await initStorage();  const accumulator = new LeaderAccumulator();
  const processedEventIds = await loadEventIds(paths.eventsPath);
  const restoredObservations = await loadObservations(
    paths.observationsPath,
    accumulator,
  );

  await writeLeaderReport(paths.leadersPath, accumulator);

  const activeCandidates = new Map<
    string,
    { token: TokenCandidate; lastSeen: number }
  >();
  const lastEventTimeByToken = new Map<string, number>();
  const pendingEvents = new Map<string, DetectedEvent>();

  let lastDiscoveryAt = 0;
  // While this timestamp is in the future, skip all Birdeye calls so a
  // 429 / CU-limit can recover instead of being hammered every 30s.
  let birdeyeCoolDownUntil = 0;

  const noteRateLimited = (error: unknown): void => {
    const cooldown =
      (isRateLimitError(error) && error.retryAfterMs) ||
      config.birdeye.rateLimitCooldownMs;
    birdeyeCoolDownUntil = Date.now() + cooldown;
    console.warn(
      `[ratelimit] Birdeye limited, backing off for ${(cooldown / 1000).toFixed(0)}s ` +
        `until ${new Date(birdeyeCoolDownUntil).toISOString()}: ` +
        `${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
    );
  };

  console.log("Starting pump-window leader-wallet research scanner");
  console.log(`Restored observations: ${restoredObservations}`);
  console.log(`Restored event IDs: ${processedEventIds.size}`);

  while (true) {
    const now = Math.floor(Date.now() / 1000);

    try {
      // ---------------------------------------------------------------
      // Refresh the active token universe periodically.
      // Isolated so one 429 does not abort the whole iteration.
      // ---------------------------------------------------------------
      if (Date.now() - lastDiscoveryAt >= config.discovery.everyMs) {
        if (Date.now() < birdeyeCoolDownUntil) {
          console.log("[ratelimit] skipping discovery (cooldown active)");
        } else {
          try {
            const discovered = await discoverTokens();
            const seenAt = Date.now();

            for (const token of discovered) {
              activeCandidates.set(token.address, {
                token,
                lastSeen: seenAt,
              });
            }

            const retained = [...activeCandidates.entries()]
              .filter(
                ([, state]) =>
                  seenAt - state.lastSeen <= config.discovery.candidateTtlMs,
              )
              .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
              .slice(0, config.discovery.maxActiveTokens);

            activeCandidates.clear();
            for (const [address, state] of retained) {
              activeCandidates.set(address, state);
            }

            lastDiscoveryAt = Date.now();
            console.log(`\n[discovery] active=${activeCandidates.size}`);
          } catch (error) {
            if (isRateLimitError(error)) noteRateLimited(error);
            else {
              console.error(
                `[error] discovery: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`,
              );
            }
          }
        }
      }

      // ---------------------------------------------------------------
      // Look for a local pump/dump on each active token.
      // One token's 429 must not block the other tokens.
      // ---------------------------------------------------------------
      if (Date.now() >= birdeyeCoolDownUntil) {
        for (const { token } of activeCandidates.values()) {
          let candles;
          try {
            candles = await fetchCandles(
              token.address,
              now - config.birdeye.candleLookbackSec,
              now,
            );
          } catch (error) {
            if (isRateLimitError(error)) {
              noteRateLimited(error);
              break;
            }
            console.error(
              `[error] candles ${tokenLabel(token)}: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
            );
            continue;
          }

        const event = detectLatestEvent(token, candles);
        if (!event) continue;
        if (processedEventIds.has(event.id)) continue;
        if (pendingEvents.has(event.id)) continue;

        const lastEvent = lastEventTimeByToken.get(token.address) ?? 0;
        if (
          event.startTime - lastEvent <
          config.event.cooldownSec
        ) {
          continue;
        }

        lastEventTimeByToken.set(token.address, event.startTime);
        pendingEvents.set(event.id, event);
        processedEventIds.add(event.id);

        await appendJsonl(paths.eventsPath, event);

        console.log(
          `[event] ${event.type.toUpperCase()} ${tokenLabel(token)} ` +
            `move=${event.movePct.toFixed(2)}% ` +
            `accel=${event.accelerationPct.toFixed(2)}% ` +
            `vol=${event.volumeAcceleration.toFixed(2)}x ` +
            `start=${new Date(event.startTime * 1000).toISOString()}`,
        );
        }
      } else {
        console.log("[ratelimit] skipping candle scan (cooldown active)");
      }

      // ---------------------------------------------------------------
      // Wait until forward-return labels are available, then analyze.
      // ---------------------------------------------------------------
      const requiredFutureSec = Math.max(
        ...config.analysis.forwardOffsetsSec,
      );

      for (const [eventId, event] of pendingEvents) {
        if (now < event.endTime + requiredFutureSec) continue;

        try {
          const transactions = await fetchTransactionsForAddress(
            event.token.address,
            event.startTime - config.analysis.preSec,
            event.endTime + config.analysis.postSec,
          );

          const trades = transactions.flatMap((tx) =>
            parseTrades(tx, event.token.address),
          );

          let candles;
          try {
            candles = await fetchCandles(
              event.token.address,
              event.startTime - config.analysis.preSec,
              event.endTime + requiredFutureSec + 5,
            );
          } catch (error) {
            if (isRateLimitError(error)) {
              noteRateLimited(error);
              continue; // keep pending, retry next iteration
            }
            throw error;
          }

          let observationCount = 0;

          for (const trade of trades) {
            const observation = buildObservation(
              event,
              trade,
              candles,
            );

            if (!observation) continue;

            await appendJsonl(paths.observationsPath, observation);
            accumulator.add(observation);
            observationCount += 1;
          }

          pendingEvents.delete(eventId);
          await writeLeaderReport(paths.leadersPath, accumulator);

          console.log(
            `[analysis] ${event.type.toUpperCase()} ${tokenLabel(event.token)} ` +
              `txs=${transactions.length} ` +
              `trades=${trades.length} ` +
              `observations=${observationCount} ` +
              `leaders=${accumulator.report().length}`,
          );
        } catch (error) {
          if (isRateLimitError(error)) {
            noteRateLimited(error);
            continue;
          }
          console.error(
            `[error] analysis ${tokenLabel(event.token)}: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`,
          );
          // Drop poisoned events so one bad token cannot block the queue.
          pendingEvents.delete(eventId);
        }
      }
    } catch (error) {
      console.error(
        `[error] ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await sleep(config.birdeye.scanEveryMs);
  }
}

await main();
