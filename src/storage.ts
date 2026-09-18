/** Small JSON/JSONL persistence helpers for resumable research runs. */

import { appendFile, mkdir } from "node:fs/promises";
import type { DetectedEvent, TokenCandidate, WalletObservation } from "./types";
import { config } from "./config";

export async function ensureDataDir(): Promise<void> {
  await mkdir(config.storage.dir, { recursive: true });
}

export function path(name: keyof typeof config.storage): string {
  return `${config.storage.dir}/${config.storage[name]}`;
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const text = await Bun.file(filePath).text().catch(() => "");
  const result: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      result.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed rows so one broken record cannot stop a research run.
    }
  }
  return result;
}

export async function loadEvents(filePath: string): Promise<DetectedEvent[]> {
  return readJsonl<DetectedEvent>(filePath);
}

export async function loadEventIds(filePath: string): Promise<Set<string>> {
  return new Set((await loadEvents(filePath)).map((event) => event.id));
}

export async function loadObservations(filePath: string): Promise<WalletObservation[]> {
  return readJsonl<WalletObservation>(filePath);
}

export async function saveCandidates(
  filePath: string,
  candidates: TokenCandidate[],
): Promise<void> {
  await Bun.write(filePath, JSON.stringify(candidates, null, 2));
}

export async function loadCandidates(filePath: string): Promise<TokenCandidate[]> {
  try {
    const value = await Bun.file(filePath).json<unknown>();
    return Array.isArray(value) ? (value as TokenCandidate[]) : [];
  } catch {
    return [];
  }
}

export async function replaceJson(filePath: string, value: unknown): Promise<void> {
  await Bun.write(filePath, JSON.stringify(value, null, 2));
}
