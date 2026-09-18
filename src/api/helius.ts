/**
 * Helius archival client for event-local transaction analysis.
 *
 * We intentionally request full transactions only after Birdeye identifies a
 * pump/dump window. The narrow time range keeps research storage and RPC usage
 * far smaller than downloading the token's complete transaction history.
 */

import { api } from "../config";
import type { RawTransaction } from "../types";

const BASE_URL = "https://mainnet.helius-rpc.com";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(
    `${BASE_URL}/?api-key=${api.heliusKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    },
  );

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

/** Fetch all full transactions in a token/event time window. */
export async function fetchTransactionsForAddress(
  address: string,
  startTime: number,
  endTime: number,
): Promise<RawTransaction[]> {
  const transactions: RawTransaction[] = [];
  let paginationToken: string | undefined;

  do {
    const options: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: "asc",
      limit: 100,
      filters: {
        blockTime: {
          gte: startTime,
          lte: endTime,
        },
        status: "succeeded",
        tokenAccounts: "balanceChanged",
      },
    };

    if (paginationToken) options.paginationToken = paginationToken;

    const result = await rpc<{
      data: RawTransaction[];
      paginationToken?: string;
    }>("getTransactionsForAddress", [address, options]);

    transactions.push(...(result.data ?? []));
    paginationToken = result.paginationToken;
  } while (paginationToken);

  return transactions;
}
