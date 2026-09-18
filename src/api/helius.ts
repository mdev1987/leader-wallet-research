/**
 * Helius archival client.
 *
 * Full transactions are fetched only after a price event has been detected.
 * This keeps the expensive transaction payloads local to short event windows.
 */

import { config } from "../config";
import type { RawTransaction } from "../types";

const BASE_URL = "https://mainnet.helius-rpc.com";

function requireApiKey(): string {
  if (!config.api.heliusKey) throw new Error("Missing HELIUS_API_KEY");
  return config.api.heliusKey;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(`${BASE_URL}/?api-key=${requireApiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(config.http.requestTimeoutMs),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius HTTP ${response.status}: ${response.statusText}`);
  }

  const json = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`Helius RPC ${json.error.code}: ${json.error.message}`);
  }

  if (json.result === undefined) {
    throw new Error(`Helius ${method}: missing result`);
  }

  return json.result;
}

/** Fetch all full transactions in one narrow token/event time window. */
export async function fetchTransactionsForAddress(
  address: string,
  startTime: number,
  endTime: number,
  opts?: { maxTransactions?: number },
): Promise<RawTransaction[]> {
  const transactions: RawTransaction[] = [];
  let paginationToken: string | undefined;

  do {
    const remaining = opts?.maxTransactions !== undefined
      ? Math.max(1, opts.maxTransactions - transactions.length)
      : 100;

    const options: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: "asc",
      limit: Math.min(100, remaining),
      maxSupportedTransactionVersion: 1,
      filters: {
        blockTime: {
          gte: Math.floor(startTime),
          lte: Math.floor(endTime),
        },
        status: "succeeded",
        tokenAccounts: "balanceChanged",
      },
    };

    if (paginationToken) options.paginationToken = paginationToken;

    const result = await rpc<{
      data?: RawTransaction[];
      paginationToken?: string;
    }>("getTransactionsForAddress", [address, options]);

    transactions.push(...(result.data ?? []));

    if (
      opts?.maxTransactions !== undefined &&
      transactions.length >= opts.maxTransactions
    ) {
      return transactions.slice(0, opts.maxTransactions);
    }

    paginationToken = result.paginationToken;
  } while (paginationToken);

  return transactions;
}
