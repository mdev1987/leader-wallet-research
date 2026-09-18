# Leader Wallet Research v4.1

Bun + TypeScript research pipeline for discovering wallets that repeatedly trade **around short-lived pump/dump events**.

v4.1 is additive to v4/v3: event timing and the single Birdeye price source are unchanged. The new layer adds deterministic pool-address labels from one keyless DexScreener `token-pairs` request per event token, plus phase-aware wallet-event features.

## Research design

```text
Birdeye token discovery
        |
        v
Birdeye 1s OHLCV  <--- only price/event timing source
        |
        v
accelerationStart / breakoutStart
        |
        v
Helius event-local transactions
        |
        v
trade parser
        |
        +---- DexScreener token-pairs metadata
        |          |
        |          +--> deterministic pair-address -> pool label
        |
        v
wallet-event observations
        |
        v
phase-aware wallet stats
        |
        v
chronological validation
```

## v4 additions

### 1. Deterministic pool labels

When a pump/dump event is accepted, the worker makes one keyless request to:

```text
GET /token-pairs/v1/solana/<tokenAddress>
```

The returned `pairAddress` values and minimal pair metadata (`dexId`, liquidity, base/quote addresses) are stored on the event and used to classify any matching trade owner as:

```text
pool / pair-address
```

This is metadata labeling only. DexScreener does **not** provide event timing or forward-return labels in this project.

The full five-way label is:

```text
pool
router
program
trader
unknown
```

with a companion `walletTypeReason`:

```text
pair-address
known-program
behavioral
default
```

Known router/program IDs are intentionally an explicit configuration in `src/config.ts`; do not add IDs without verifying what the address represents.

A wallet is never automatically classified as a market maker merely because it has mixed buy/sell behavior. The event record keeps `sideConsistency` and `behavioralHint` as soft evidence. At report/evaluation time, deterministic infrastructure labels (`pool`, `router`, `program`) are excluded from leader promotion and candidate validation, while the underlying rows remain stored.

### 2. Phase-aware volume

Each wallet-event now contains SOL volumes split by:

```text
pre_event:   buy / sell
acceleration: buy / sell
breakout:     buy / sell
```

and matching trade counts. This directly represents patterns such as:

```text
accumulate -> accelerate -> breakout -> distribute
```

### 3. Candle-based entry/exit prices

`avgEntryPriceUsd` and `avgExitPriceUsd` are calculated from the **market candle close at trade time**, weighted by token amount. They never use `tradePriceSol`, because the Helius balance-delta price is explicitly labeled as noisy.

For compact trade-price replay, these USD fields remain `null`. That keeps the replay honest rather than mixing SOL/token and USD units.

## Setup

```bash
cp .env.example .env
```

Set:

```dotenv
BIRDEYE_API_KEY=...
HELIUS_API_KEY=...
```

Then:

```bash
bun install
bun run typecheck
bun run selftest
```

Run the live collector:

```bash
bun run start
```

One scan cycle:

```bash
bun run src/main.ts --once
```

## Replay

```bash
bun run src/replay.ts \
  --token <MINT> \
  --symbol VIBE \
  --trades ./helius_bun_trades.csv \
  --out ./data/vibe \
  --max-gap-sec 15
```

Optional deterministic pool labels can be supplied without changing the replay price source:

```bash
bun run src/replay.ts \
  --token <MINT> \
  --trades ./helius_bun_trades.csv \
  --pool-addresses <PAIR1>,<PAIR2>
```

The live worker obtains those pair addresses automatically from DexScreener when each event is accepted.

## Outputs

```text
data/events.jsonl
data/wallet_observations.jsonl
data/wallet_events.jsonl
data/leader_wallets.json
data/eval_report.json
```

All new v4 fields are additive/nullable so v3 observation rows can still be loaded. Legacy rows without labels are treated as `unknown/default`; legacy rows without candle USD prices keep `avgEntryPriceUsd` / `avgExitPriceUsd` as null.

## Infrastructure reporting

Raw pool/router/program observations are retained in `wallet_observations.jsonl` and `wallet_events.jsonl`, but the leader report and train/validation candidate set exclude those infrastructure types. `trader` and `unknown` remain eligible. This prevents deterministic infrastructure addresses from being promoted as leaders without removing the underlying evidence.

## Leader validation table (v4.2)

Wallet-event rows additionally carry side-split first leads, per-side per-horizon directional medians, signed net volume, pre-breakout positioning, and discovery-time event liquidity. The leader report aggregates these into the measurable leader definition:

```text
wallet, tokens, events
median_buy_lead_sec, median_sell_lead_sec
buy_5s / buy_15s / buy_30s / buy_60s
sell_5s / sell_15s / sell_30s / sell_60s
median_trade_sol, median_event_liquidity_usd, median_trade_vs_liquidity
train_events, validation_events
```

`median_trade_vs_liquidity` mixes SOL event volume with USD liquidity: relative comparisons only, never an absolute dollar claim. The out-of-sample evaluator reports the same side-split leads and horizon returns separately for train and validation splits, and `diagnose` histograms parse skip reasons per window.

## Significance testing (v5)
With thousands of wallets, some validate well by chance — beating 50% is not evidence. Every evaluation therefore includes a wallet-shuffled permutation null over validation wallet-events (train selection fixed, event structure intact, only the wallet→performance link broken) plus bootstrap percentile intervals for candidate and base rates:

```text
permutation.resamples / .seed   # seeded RNG: same seed, same report
permutation.observedRate         # candidate validation hit rate
permutation.nullMean / .nullSd / .nullP95
permutation.pValue               # P(null >= observed), +1 pseudocount
permutation.candidateCI95 / .baseCI95
permutation.skipped              # reason when untestable (e.g. no candidates)
```

Tune `eval.permutationCount` / `eval.randomSeed` in `src/config.ts`. The self-test asserts determinism, bounds, and a small p-value on a perfect-candidate fixture — verified by mutation testing (identity shuffle fails the test).

## Discovery providers

Discovery supplies the candidate *universe* only — never event timing. Provider chain per cycle:

```text
Birdeye token-list  ->  Debot activity rank  ->  DBotX hot+surging  ->  frozen
 (self-heals)             (free, keyless)          (~20 credits)        (candidates + WATCHLIST_MINTS)
```

Debot rows carry pair addresses, market cap, liquidity, volume, holders, swap counts, and smart-wallet presence, which seed pool labels without a metadata lookup. DBotX rows carry pair addresses with SOL-denominated reserves (converted via cached keyless SOL price). Filters are provider-native and lenient; the event detector (continuous-window + discontinuity guard) does the real selection. `DBOTX_API_KEY` goes in `.env`; Debot needs no key.

## Important limitations

The Helius trade parser remains a balance-delta parser. `priceQuality` stays `balance-delta`. v4 does not claim exact instruction-level swap pricing.

The pair-address label is deterministic with respect to the DexScreener response captured at event time, but a DEX pair address is not necessarily every vault/account involved in the settlement. It should therefore be treated as a deterministic **pair-address label**, not as proof that every pool vault has been discovered.

The project still does not infer causality. It measures whether wallet behavior precedes a market move and whether the subsequent return is directionally favorable.
