/** Shared domain types used by discovery, event detection, parsing and reports. */

export type EventType = "pump" | "dump";
export type TradeSide = "buy" | "sell";
export type TradePhase = "pre_event" | "breakout";

export type TokenCandidate = {
  address: string;
  symbol: string;
  name: string;
  liquidityUsd: number;
  volume1hUsd: number;
  trade1hCount: number;
};

export type Candle = {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

export type DetectedEvent = {
  id: string;
  token: TokenCandidate;
  type: EventType;
  detectedAt: number;
  startTime: number;
  endTime: number;
  movePct: number;
  accelerationPct: number;
  volumeAcceleration: number;
};

export type RawTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
};

export type RawAccountKey =
  | string
  | {
      pubkey: string;
      signer?: boolean;
      writable?: boolean;
    };

export type RawTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures?: string[];
    message: {
      accountKeys: RawAccountKey[];
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

export type Trade = {
  token: string;
  timestamp: number;
  side: TradeSide;
  wallet: string;
  tokenAmount: number;
  solAmount: number;
  priceSol: number;
  signature: string;
  slot: number;
};

export type WalletObservation = {
  eventId: string;
  token: string;
  symbol: string;
  eventType: EventType;
  eventStart: number;
  tradeTime: number;
  wallet: string;
  side: TradeSide;
  phase: TradePhase;
  alignedWithEvent: boolean;
  leadSeconds: number;
  solAmount: number;
  tokenAmount: number;
  tradePriceSol: number;
  forward: Record<string, number | null>;
  directionalReturn60s: number | null;
  signature: string;
};

export type WalletStats = {
  wallet: string;
  leaderEvents: number;
  uniqueTokens: number;
  alignedBuyEvents: number;
  alignedSellEvents: number;
  medianLeadSeconds: number | null;
  medianDirectionalReturn60s: number | null;
  positiveDirectional60Rate: number | null;
  observations: number;
  tokens: string[];
};
