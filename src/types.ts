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
  /**
   * How `forward` was computed. "candle" = candle-to-candle closes.
   * Observations written before this field existed mixed SOL-denominated
   * trade prices with USD candle closes and must be ignored by stats.
   */
  forwardBasis?: string;
  directionalReturn60s: number | null;
  /**
   * Total SOL volume of the trade's side within its event window, and the
   * trade's share of it. Null on rows written before volumeShare existed.
   * A share near 1 means the wallet likely moved the price itself.
   */
  sideVolumeSol?: number | null;
  volumeShare?: number | null;
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
  /** Median share of event-window side volume (null when unavailable). */
  medianVolumeShare: number | null;
  /**
   * Median directional return down-weighted by own volume share
   * (heuristic v1: directional * (1 - share)). Null when no share data.
   */
  medianSizeAdjustedReturn60s: number | null;
  positiveDirectional60Rate: number | null;
  observations: number;
  tokens: string[];
};
