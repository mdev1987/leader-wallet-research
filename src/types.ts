/** Shared domain types for the research pipeline. */

export type EventType = "pump" | "dump" | "crash";
export type ResearchEventType = "pump" | "dump";
export type TradeSide = "buy" | "sell";
export type TradePhase = "pre_event" | "acceleration" | "breakout";

/** Five-way infrastructure/trader label. Labels are event-token scoped. */
export type WalletType = "pool" | "router" | "program" | "trader" | "unknown";

/** Why a wallet type was assigned. */
export type WalletTypeReason =
  | "pair-address"
  | "known-program"
  | "behavioral"
  | "default";

export type WalletLabel = {
  type: WalletType;
  reason: WalletTypeReason;
};

export type PhaseVolume = {
  buy: number;
  sell: number;
};

export type PhaseTradeCount = {
  buy: number;
  sell: number;
};

export type TokenCandidate = {
  address: string;
  symbol: string;
  name: string;
  liquidityUsd: number;
  volume1hUsd: number;
  trade1hCount: number;
  recentListingTime?: number | null;
};

export type TokenPairMetadata = {
  pairAddress: string;
  dexId: string;
  liquidityUsd: number | null;
  baseTokenAddress: string | null;
  quoteTokenAddress: string | null;
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
  accelerationStart: number;
  breakoutStart: number;
  confirmedAt: number;
  movePct: number;
  accelerationPct: number;
  breakoutPct: number;
  volumeAcceleration: number;
  /** DexScreener pair addresses captured for this token at event time. */
  poolAddresses?: string[];
  poolPairs?: TokenPairMetadata[];
  poolLabelSource?: "dexscreener-token-pairs" | "unavailable";
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
  priceQuality: "balance-delta";
  /** True only when the token owner is the transaction fee payer. */
  isSigner?: boolean;
};

export type WalletObservation = {
  eventId: string;
  eventTime: number;
  token: string;
  symbol: string;
  eventType: ResearchEventType;
  accelerationStart: number;
  breakoutStart: number;
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
  forwardBasis: "market-usd" | "trade-sol";
  directionalReturns: Record<string, number | null>;
  sideVolumeSol: number;
  sideVolumeShare: number;
  signature: string;
  /** Point-in-time market candle close in USD; null for trade-price replay. */
  candlePriceUsdAtTrade?: number | null;
  /**
   * Discovery-time token liquidity snapshot. 0 when unknown (e.g. replay).
   * Context for trade-vs-liquidity ratios, never event timing.
   */
  eventLiquidityUsd: number;
  walletType?: WalletType;
  walletTypeReason?: WalletTypeReason;
  behavioralHint?: "buy-dominant" | "sell-dominant" | "mixed-sides" | null;
};

export type WalletEventStats = {
  wallet: string;
  eventId: string;
  eventTime: number;
  token: string;
  symbol: string;
  eventType: ResearchEventType;
  firstAlignedTradeTime: number | null;
  lastAlignedTradeTime: number | null;
  firstAlignedLeadSeconds: number | null;
  /** Side-split first leads: buys lead pumps, sells lead dumps. */
  firstBuyLeadSeconds: number | null;
  firstSellLeadSeconds: number | null;
  /** Buy offsets relative to accelerationStart (negative = early). */
  firstBuyOffsetSec: number | null;
  lastBuyOffsetSec: number | null;
  /** Signed positioning across all event rows: buys minus sells. */
  netVolumeSol: number;
  /** Rows at or before breakoutStart: positioned ahead of the breakout. */
  preBreakoutTradeCount: number;
  /** Per-horizon medians over aligned trades, split by side. */
  buyDirectional: Record<string, number | null>;
  sellDirectional: Record<string, number | null>;
  /** Discovery-time token liquidity snapshot; 0 when unknown. */
  eventLiquidityUsd: number;
  alignedTradeCount: number;
  alignedVolumeSol: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buyCount: number;
  sellCount: number;
  sideConsistency: number;
  earliestTradeTime: number | null;
  latestTradeTime: number | null;
  maxDirectional60: number | null;
  medianDirectional60: number | null;
  positive60: boolean | null;
  medianVolumeShare: number | null;
  walletType?: WalletType;
  walletTypeReason?: WalletTypeReason;
  behavioralHint?: "buy-dominant" | "sell-dominant" | "mixed-sides" | null;
  phaseVolumes?: {
    pre_event: PhaseVolume;
    acceleration: PhaseVolume;
    breakout: PhaseVolume;
  };
  phaseTradeCounts?: {
    pre_event: PhaseTradeCount;
    acceleration: PhaseTradeCount;
    breakout: PhaseTradeCount;
  };
  avgEntryPriceUsd?: number | null;
  avgExitPriceUsd?: number | null;
  entryTokenAmount?: number;
  exitTokenAmount?: number;
};

export type WalletReport = {
  wallet: string;
  eventCount: number;
  tokenCount: number;
  pumpEvents: number;
  dumpEvents: number;
  alignedObservations: number;
  positive60Rate: number | null;
  medianLeadSeconds: number | null;
  /** Median first-buy lead on pumps / first-sell lead on dumps. */
  medianBuyLeadSec: number | null;
  medianSellLeadSec: number | null;
  medianDirectional60: number | null;
  /** Per-horizon medians across pump events (buys) and dumps (sells). */
  buyDirectional: Record<string, number | null>;
  sellDirectional: Record<string, number | null>;
  medianVolumeShare: number | null;
  medianTradeSol: number | null;
  medianEventLiquidityUsd: number | null;
  /**
   * Median aligned-event-volume / event-liquidity. Mixed SOL/USD units:
   * relative comparisons only, never an absolute dollar claim.
   */
  medianTradeVsLiquidity: number | null;
  buyEventCount: number;
  sellEventCount: number;
  events: string[];
  tokens: string[];
  walletTypes?: WalletType[];
  walletTypeReasons?: WalletTypeReason[];
  /** Number of wallet-events retained in the raw data but excluded from leader reporting as infrastructure. */
  infrastructureEventsExcluded: number;
};
