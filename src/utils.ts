/** Small dependency-free helpers used throughout the research worker. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function pctChange(oldPrice: number, newPrice: number): number {
  if (oldPrice <= 0 || newPrice <= 0) return 0;
  return (newPrice / oldPrice - 1) * 100;
}

export function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function pubkeyOf(
  key: string | { pubkey: string },
): string {
  return typeof key === "string" ? key : key.pubkey;
}
