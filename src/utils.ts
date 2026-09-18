/** Small dependency-free helpers. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function pctChange(oldPrice: number, newPrice: number): number {
  if (!(oldPrice > 0) || !(newPrice > 0)) return 0;
  return (newPrice / oldPrice - 1) * 100;
}

export function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const a = sorted[middle - 1];
  const b = sorted[middle];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}

export function pubkeyOf(
  key: string | { pubkey: string },
): string {
  return typeof key === "string" ? key : key.pubkey;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatUtc(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * Deterministic PRNG (mulberry32). Resampling for research must be
 * reproducible: same seed, same null distribution, same report.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle using an injected RNG (testable, seedable). */
export function shuffleInPlace<T>(values: T[], rand: () => number): T[] {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = values[i];
    const b = values[j];
    if (a === undefined || b === undefined) continue;
    values[i] = b;
    values[j] = a;
  }
  return values;
}
