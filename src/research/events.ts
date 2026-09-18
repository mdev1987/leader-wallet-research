/**
 * Detect local pump/dump events from one-second candles.
 *
 * Event timing is split into two concepts:
 * - accelerationStart: earliest qualifying start that can be confirmed later;
 * - breakoutStart: first point where the move reaches a configurable fraction
 *   of the full event threshold.
 *
 * The detector rejects windows containing implausible one-second price jumps.
 * This is important for sparse trade-derived replay data, where a balance-delta
 * price artifact can otherwise look like a multi-thousand-percent pump.
 */

import { config } from "../config";
import type { Candle, DetectedEvent, EventType, TokenCandidate } from "../types";
import { median, pctChange } from "../utils";

function indexBySecond(candles: Candle[]): Map<number, Candle> {
  return new Map(candles.map((candle) => [candle.unixTime, candle]));
}

/** Return false when any second in the window is missing. */
function hasContinuousWindow(
  candlesByTime: Map<number, Candle>,
  start: number,
  end: number,
): boolean {
  for (let time = start; time <= end; time += 1) {
    if (!candlesByTime.has(time)) return false;
  }
  return true;
}

/**
 * Return false when one adjacent one-second price move is implausibly large.
 *
 * The guard is deliberately applied before pump/dump/crash classification so a
 * bad price sample is not mislabeled as a legitimate crash or pump.
 */
function hasAcceptablePriceSteps(
  candlesByTime: Map<number, Candle>,
  start: number,
  end: number,
): boolean {
  const maxPct = config.event.maxOneSecondMovePct;
  const guardStart = Math.max(
    0,
    start - config.event.discontinuityLookbackSec,
  );

  // Include the immediate pre-event path. Otherwise an isolated bad sample
  // could itself become `start` and all subsequent steps could look normal.
  for (let time = guardStart + 1; time <= end; time += 1) {
    const previous = candlesByTime.get(time - 1);
    const current = candlesByTime.get(time);
    if (!previous || !current) return false;

    const stepPct = Math.abs(pctChange(previous.close, current.close));
    if (!Number.isFinite(stepPct) || stepPct > maxPct) return false;
  }

  return true;
}

function meanVolume(candles: Candle[], from: number, to: number): number {
  const values = candles
    .filter((candle) => candle.unixTime >= from && candle.unixTime <= to)
    .map((candle) => candle.volumeUsd)
    .filter((value) => value > 0);

  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function eventId(
  token: TokenCandidate,
  type: EventType,
  accelerationStart: number,
): string {
  return `${token.address}:${type}:${accelerationStart}`;
}

/** Find the first meaningful breakout point inside the confirmed move window. */
function findBreakoutStart(
  candlesByTime: Map<number, Candle>,
  startTime: number,
  moveEndTime: number,
  direction: "up" | "down",
  startPrice: number,
): number {
  const threshold =
    config.event.minMovePct * config.event.breakoutFraction;

  for (let time = startTime + 1; time <= moveEndTime; time += 1) {
    const candle = candlesByTime.get(time);
    if (!candle) continue;
    const move = pctChange(startPrice, candle.close);
    if (direction === "up" && move >= threshold) return time;
    if (direction === "down" && move <= -threshold) return time;
  }

  return moveEndTime;
}

function detectDirectionAt(
  token: TokenCandidate,
  candles: Candle[],
  byTime: Map<number, Candle>,
  index: number,
): DetectedEvent | null {
  const start = candles[index];
  if (!start) return null;

  const moveEnd = byTime.get(start.unixTime + config.event.moveSec);
  const accelerationEnd = byTime.get(
    start.unixTime + config.event.accelerationSec,
  );

  if (!moveEnd || !accelerationEnd) return null;

  if (
    !hasAcceptablePriceSteps(
      byTime,
      start.unixTime,
      moveEnd.unixTime,
    )
  ) {
    return null;
  }

  const movePct = pctChange(start.close, moveEnd.close);
  const accelerationPct = pctChange(start.close, accelerationEnd.close);

  const isPump =
    movePct >= config.event.minMovePct &&
    accelerationPct >= config.event.minAccelerationPct;

  const isCrash = movePct <= -config.event.crashPct;
  const isDump =
    movePct <= -config.event.minMovePct &&
    accelerationPct <= -config.event.minAccelerationPct;

  if (!isPump && !isDump && !isCrash) return null;

  const type: EventType = isCrash ? "crash" : isPump ? "pump" : "dump";
  const direction = type === "pump" ? "up" : "down";
  const breakoutStart =
    type === "crash"
      ? moveEnd.unixTime
      : findBreakoutStart(
          byTime,
          start.unixTime,
          moveEnd.unixTime,
          direction,
          start.close,
        );

  const recentVolume = meanVolume(
    candles,
    start.unixTime,
    start.unixTime + config.event.volumeRecentSec,
  );
  const baselineVolume = meanVolume(
    candles,
    start.unixTime - config.event.volumeBaselineSec,
    start.unixTime - 1,
  );

  return {
    id: eventId(token, type, start.unixTime),
    token,
    type,
    accelerationStart: start.unixTime,
    breakoutStart,
    confirmedAt: moveEnd.unixTime,
    movePct,
    accelerationPct,
    breakoutPct: pctChange(start.close, byTime.get(breakoutStart)?.close ?? moveEnd.close),
    volumeAcceleration:
      baselineVolume > 0 ? recentVolume / baselineVolume : 0,
  };
}

/**
 * Detect confirmed local events in chronological order.
 *
 * The detector searches backward for the earliest qualifying start, then applies
 * a per-token cooldown so one sustained move does not become many events.
 */
export function detectEvents(
  token: TokenCandidate,
  candles: Candle[],
): DetectedEvent[] {
  const ordered = [...candles]
    .filter((candle) => candle.close > 0)
    .sort((a, b) => a.unixTime - b.unixTime);

  const byTime = indexBySecond(ordered);
  const events: DetectedEvent[] = [];
  let nextAllowedStart = Number.NEGATIVE_INFINITY;

  const latestStart =
    ordered.length > 0
      ? ordered[ordered.length - 1]!.unixTime - config.event.moveSec
      : 0;

  for (let i = 0; i < ordered.length; i += 1) {
    const candidate = ordered[i];
    if (!candidate) continue;
    if (candidate.unixTime < nextAllowedStart) continue;
    if (candidate.unixTime > latestStart) break;

    if (
      !hasContinuousWindow(
        byTime,
        candidate.unixTime,
        candidate.unixTime + config.event.moveSec,
      )
    ) {
      continue;
    }

    let earliest: DetectedEvent | null = null;
    const searchFrom = Math.max(
      ordered[0]?.unixTime ?? candidate.unixTime,
      candidate.unixTime - config.event.searchBackSec,
    );

    for (let j = i; j >= 0; j -= 1) {
      const probe = ordered[j];
      if (!probe || probe.unixTime < searchFrom) break;
      if (
        !hasContinuousWindow(
          byTime,
          probe.unixTime,
          probe.unixTime + config.event.moveSec,
        )
      ) {
        continue;
      }

      const detected = detectDirectionAt(token, ordered, byTime, j);
      if (!detected) continue;

      // A crash is itself the earliest confirmed downside regime. Do not search
      // farther backward through an unrelated preceding event.
      if (detected.type === "crash") {
        earliest = detected;
        break;
      }

      earliest = detected;
    }

    if (!earliest) continue;

    events.push(earliest);
    nextAllowedStart =
      earliest.accelerationStart + config.event.cooldownSec;
  }

  return [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((a, b) => a.accelerationStart - b.accelerationStart);
}

/** Return the newest confirmed event, useful for live polling. */
export function detectLatestEvent(
  token: TokenCandidate,
  candles: Candle[],
): DetectedEvent | null {
  return detectEvents(token, candles).at(-1) ?? null;
}

/** Return the last candle at or before a timestamp. */
export function candleAtOrBefore(
  candles: Candle[],
  timestamp: number,
): Candle | null {
  let result: Candle | null = null;
  for (const candle of candles) {
    if (candle.unixTime > timestamp) break;
    result = candle;
  }
  return result;
}

/** Return the first candle at or after a timestamp. */
export function candleAtOrAfter(
  candles: Candle[],
  timestamp: number,
): Candle | null {
  for (const candle of candles) {
    if (candle.unixTime >= timestamp) return candle;
  }
  return null;
}

/** Return the largest timestamp gap in a candle series. */
export function largestCandleGap(candles: Candle[]): number {
  let largest = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1];
    const current = candles[i];
    if (!previous || !current) continue;
    largest = Math.max(largest, current.unixTime - previous.unixTime);
  }
  return largest;
}

/** Return the median close price for diagnostics. */
export function medianClose(candles: Candle[]): number | null {
  return median(candles.map((candle) => candle.close));
}
