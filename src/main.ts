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
import { DexSampler } from "./api/dexscreener";
import { fetchTransactionsForAddress } from "./api/helius";
import { config } from "./config";
import {
  buildObservation,
  detectLatestEvent,
  LeaderAccumulator,
  parseTrades,
  sideVolumesSol,
  withVolumeShare,
} from "./analysis";
import type { Candle, DetectedEvent, TokenCandidate } from "./types";
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
  // DexScreener spot buffer: sampled every cycle (even while Birdeye is
  // healthy) so fallback candles are warm the moment a cooldown starts.
  const dexSampler = new DexSampler();

  /** Dedupe, cooldown-gate, persist and log one detected event. */
  const ingestEvent = async (event: DetectedEvent): Promise<boolean> => {
    if (processedEventIds.has(event.id) || pendingEvents.has(event.id)) {
      return false;
    }

    const lastEvent = lastEventTimeByToken.get(event.token.address) ?? 0;
    if (event.startTime - lastEvent < config.event.cooldownSec) {
      return false;
    }

    lastEventTimeByToken.set(event.token.address, event.startTime);
    pendingEvents.set(event.id, event);
    processedEventIds.add(event.id);

    await appendJsonl(paths.eventsPath, event);

    console.log(
      `[event] ${event.type.toUpperCase()} ${tokenLabel(event.token)} ` +
        `move=${event.movePct.toFixed(2)}% ` +
        `accel=${event.accelerationPct.toFixed(2)}% ` +
        `vol=${event.volumeAcceleration.toFixed(2)}x ` +
        `start=${new Date(event.startTime * 1000).toISOString()}`,
    );
    return true;
  };

  let lastDiscoveryAt = 0;
  // While this timestamp is in the future, skip all Birdeye calls so a
  // 429 / CU-limit can recover instead of being hammered every 30s.
  let birdeyeCoolDownUntil = 0;

  const noteRateLimited = (error: unknown): void => {
    const exhausted = isRateLimitError(error) && error.quotaExhausted;
    const cooldown = exhausted
      ? config.birdeye.quotaCooldownMs
      : (isRateLimitError(error) && error.retryAfterMs) ||
        config.birdeye.rateLimitCooldownMs;
    birdeyeCoolDownUntil = Date.now() + cooldown;
    console.warn(
      `[ratelimit] Birdeye ${exhausted ? "quota exhausted" : "limited"}, backing off for ${(cooldown / 1000).toFixed(0)}s ` +
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
      // While Birdeye cools down, detect on DexScreener spot candles
      // instead of stalling (Helius analysis keeps working throughout).
      // ---------------------------------------------------------------
      const birdeyeDown = Date.now() < birdeyeCoolDownUntil;

      // Keep the fallback buffer warm regardless of Birdeye state: one
      // keyless batch request per cycle for every watched token.
      if (activeCandidates.size > 0) {
        await dexSampler.sample([...activeCandidates.keys()]);
      }

      if (!birdeyeDown) {
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
          if (event) await ingestEvent(event);
        }
      } else if (config.dex.enabled && activeCandidates.size > 0) {
        let covered = 0;
        for (const { token } of activeCandidates.values()) {
          const candles = dexSampler.candles(
            token.address,
            now - config.birdeye.candleLookbackSec,
            now,
          );
          if (candles.length === 0) continue;
          covered += 1;

          const event = detectLatestEvent(token, candles);
          if (event) await ingestEvent(event);
        }
        console.log(
          `[dex] fallback scan tokens=${activeCandidates.size} withSamples=${covered}`,
        );
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

          // Forward-return candles: prefer Birdeye 1s candles, but fall back
          // to DexScreener spot samples during Birdeye cooldowns so pending
          // events (Helius data is unaffected) keep resolving. Basis labels
          // keep the two USD-denominated sources distinguishable downstream.
          let candles: Candle[];
          let basis = "candle";
          if (Date.now() >= birdeyeCoolDownUntil) {
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
          } else if (config.dex.enabled) {
            candles = dexSampler.candles(
              event.token.address,
              event.startTime - config.analysis.preSec,
              event.endTime + requiredFutureSec + 5,
            );
            basis = "dex";
            if (candles.length < 2) continue; // buffer warming up; keep pending
          } else {
            continue; // cooling down with fallback disabled; keep pending
          }

          let observationCount = 0;
          const volumes = sideVolumesSol(trades);

          for (const trade of trades) {
            const raw = buildObservation(
              event,
              trade,
              candles,
              { basis },
            );

            if (!raw) continue;

            const observation = withVolumeShare(
              raw,
              trade.side === "buy" ? volumes.buy : volumes.sell,
            );

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
