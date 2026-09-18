import { writeFile } from "node:fs/promises";

const API_KEY = Bun.env.HELIUS_API_KEY;

if (!API_KEY) {
  throw new Error("Missing HELIUS_API_KEY environment variable");
}

const TOKEN_ADDRESS = "viBEsohKdeaUgNhbB1j4NpsAm4Bg8LCCwYhkpb6UyNN";

// Explicit Tehran time (UTC+03:30)
const START_DATE_TIME = Math.floor(
  new Date("2026-09-18T01:30:00+03:30").getTime() / 1000,
);

const END_DATE_TIME = Math.floor(
  new Date("2026-09-18T02:30:00+03:30").getTime() / 1000,
);

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

type RawTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
};

type RawTransaction = {
  blockTime: number | null;
  slot: number;
  transaction: {
    signatures?: string[];
    message: {
      accountKeys: Array<
        | string
        | {
            pubkey: string;
            signer?: boolean;
            writable?: boolean;
          }
      >;
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
  };
};

type Trade = {
  time: string;
  timestamp: number;
  type: "buy" | "sell";
  wallet: string;
  tokenAmount: number;
  solAmount: number;
  priceSol: number;
  signature: string;
  slot: number;
};

function getPubkey(
  key:
    | string
    | {
        pubkey: string;
        signer?: boolean;
        writable?: boolean;
      },
): string {
  return typeof key === "string" ? key : key.pubkey;
}

function getFeePayer(transaction: RawTransaction): {
  wallet: string;
  index: number;
} | null {
  const accountKeys = transaction.transaction.message.accountKeys;

  if (!accountKeys?.length) {
    return null;
  }

  // Prefer the first explicitly marked signer.
  const signerIndex = accountKeys.findIndex(
    (
      key:
        | string
        | {
            pubkey: string;
            signer?: boolean;
            writable?: boolean;
          },
    ) => typeof key !== "string" && key.signer === true,
  );

  const index = signerIndex >= 0 ? signerIndex : 0;
  const key = accountKeys[index];

  if (!key) {
    return null;
  }

  const wallet = getPubkey(key);

  if (!wallet) {
    return null;
  }

  return { wallet, index };
}

function getTokenDeltaForWallet(
  transaction: RawTransaction,
  wallet: string,
): {
  amount: bigint;
  decimals: number;
} | null {
  const pre = transaction.meta.preTokenBalances ?? [];
  const post = transaction.meta.postTokenBalances ?? [];

  const balances = new Map<
    string,
    {
      mint: string;
      owner: string;
      decimals: number;
      pre: bigint;
      post: bigint;
    }
  >();

  for (const entry of pre) {
    if (!entry.owner || entry.mint !== TOKEN_ADDRESS) {
      continue;
    }

    const key = `${entry.accountIndex}:${entry.mint}`;

    balances.set(key, {
      mint: entry.mint,
      owner: entry.owner,
      decimals: entry.uiTokenAmount.decimals,
      pre: BigInt(entry.uiTokenAmount.amount),
      post: 0n,
    });
  }

  for (const entry of post) {
    if (!entry.owner || entry.mint !== TOKEN_ADDRESS) {
      continue;
    }

    const key = `${entry.accountIndex}:${entry.mint}`;

    const existing = balances.get(key);

    if (existing) {
      existing.post = BigInt(entry.uiTokenAmount.amount);
      existing.decimals = entry.uiTokenAmount.decimals;
    } else {
      balances.set(key, {
        mint: entry.mint,
        owner: entry.owner,
        decimals: entry.uiTokenAmount.decimals,
        pre: 0n,
        post: BigInt(entry.uiTokenAmount.amount),
      });
    }
  }

  let totalDelta = 0n;
  let decimals = 0;

  for (const balance of balances.values()) {
    if (balance.owner !== wallet) {
      continue;
    }

    totalDelta += balance.post - balance.pre;
    decimals = balance.decimals;
  }

  if (totalDelta === 0n) {
    return null;
  }

  return {
    amount: totalDelta,
    decimals,
  };
}

function rawTokenAmountToNumber(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function parseTrade(transaction: RawTransaction): Trade | null {
  if (!transaction.meta || transaction.meta.err !== null) {
    return null;
  }

  if (transaction.blockTime === null) {
    return null;
  }

  const feePayer = getFeePayer(transaction);

  if (!feePayer) {
    return null;
  }

  const { wallet, index: walletIndex } = feePayer;

  const tokenDelta = getTokenDeltaForWallet(transaction, wallet);

  if (!tokenDelta) {
    return null;
  }

  const preSol = transaction.meta.preBalances[walletIndex];
  const postSol = transaction.meta.postBalances[walletIndex];

  if (preSol === undefined || postSol === undefined) {
    return null;
  }

  // Positive = wallet gained SOL
  // Negative = wallet spent SOL
  const solDeltaLamports = postSol - preSol;

  if (solDeltaLamports === 0) {
    return null;
  }

  const tokenAmount = rawTokenAmountToNumber(
    tokenDelta.amount < 0n ? -tokenDelta.amount : tokenDelta.amount,
    tokenDelta.decimals,
  );

  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return null;
  }

  let type: "buy" | "sell";
  let solAmountLamports: number;

  if (tokenDelta.amount > 0n && solDeltaLamports < 0) {
    // Wallet received tokens and spent SOL.
    type = "buy";

    // Remove transaction fee from the SOL spent.
    solAmountLamports = Math.abs(solDeltaLamports) - transaction.meta.fee;
  } else if (tokenDelta.amount < 0n && solDeltaLamports > 0) {
    // Wallet sold tokens and received SOL.
    type = "sell";

    // Add transaction fee back to get the trade proceeds.
    solAmountLamports = solDeltaLamports + transaction.meta.fee;
  } else {
    // Token movement without the expected SOL movement.
    return null;
  }

  if (!Number.isFinite(solAmountLamports) || solAmountLamports <= 0) {
    return null;
  }

  const solAmount = solAmountLamports / 1e9;
  const priceSol = solAmount / tokenAmount;

  const signature = transaction.transaction.signatures?.[0];

  if (!signature) {
    return null;
  }

  return {
    time: new Date(transaction.blockTime * 1000).toISOString(),
    timestamp: transaction.blockTime,
    type,
    wallet,
    tokenAmount,
    solAmount,
    priceSol,
    signature,
    slot: transaction.slot,
  };
}

async function fetchTransactions(): Promise<RawTransaction[]> {
  const allTransactions: RawTransaction[] = [];

  let paginationToken: string | undefined;

  while (true) {
    const params: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: "asc",
      limit: 100,
      filters: {
        blockTime: {
          gte: START_DATE_TIME,
          lte: END_DATE_TIME,
        },
        status: "succeeded",
        tokenAccounts: "balanceChanged",
      },
    };

    if (paginationToken) {
      params.paginationToken = paginationToken;
    }

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransactionsForAddress",
        params: [TOKEN_ADDRESS, params],
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: any = await response.json();

    if (data.error) {
      throw new Error(
        `Helius RPC error ${data.error.code}: ${data.error.message}`,
      );
    }

    const result = data.result;

    if (!result) {
      break;
    }

    const page: RawTransaction[] = result.data ?? [];

    allTransactions.push(...page);

    console.log(
      `Fetched ${page.length} transactions | total: ${allTransactions.length}`,
    );

    paginationToken = result.paginationToken;

    if (!paginationToken || page.length === 0) {
      break;
    }
  }

  return allTransactions;
}

const rawTransactions = await fetchTransactions();

const trades = rawTransactions
  .map(parseTrade)
  .filter((trade): trade is Trade => trade !== null);

// Remove any duplicate signatures.
const uniqueTrades = [
  ...new Map(trades.map((trade) => [trade.signature, trade])).values(),
];

await writeFile("trades.json", JSON.stringify(uniqueTrades, null, 2), "utf8");

console.log();
console.log(`Raw transactions : ${rawTransactions.length}`);
console.log(`Detected trades   : ${uniqueTrades.length}`);
console.log(`Output             : trades.json`);
