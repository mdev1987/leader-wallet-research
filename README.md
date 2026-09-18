# Solana Pump-Window Leader Wallet Research

This is a Bun/TypeScript research worker for discovering wallets that repeatedly trade **immediately before short pump/dump events**.

It intentionally does **not** download full token histories. The pipeline is:

```text
Birdeye token discovery
        ↓
Birdeye 1s OHLCV
        ↓
local pump/dump detector
        ↓
Helius getTransactionsForAddress
        ↓
event-local wallet/trade extraction
        ↓
forward price response
        ↓
leader_wallets.json
```

## Setup

```bash
cp .env.example .env
# fill in BIRDEYE_API_KEY and HELIUS_API_KEY
bun install
bun run src/main.ts
```

## Configuration

| Variable | Required | Used by |
|---|---|---|
| `BIRDEYE_API_KEY` | yes | token discovery + 1s OHLCV (`src/api/birdeye.ts`) |
| `HELIUS_API_KEY` | yes | event-window transactions (`src/api/helius.ts`) |

`.env` is gitignored and must never be committed. `.env.example`
documents the full schema (including placeholders for optional/planned
integrations such as paper trading, Telegram alerts, and enrichment
services); only the two keys above are read by the current worker.

## Timed run

Birdeye's free/Starter plans enforce tight compute-unit limits, so the
bot is configured to back off instead of crash-looping:

- `src/api/birdeye.ts` retries 429s with exponential backoff
  (respects `Retry-After`) and throws `BirdeyeRateLimitError` when spent.
- `src/main.ts` isolates failures per token, skips Birdeye calls during a
  90s cooldown, keeps pending events for retry, and exits cleanly on
  SIGINT/SIGTERM.
- `src/config.ts` defaults are softened for Starter plans:
  discovery every 5 min, max 5 tokens, 1 req / 2s, scan every 30s,
  3-min candle lookback.

Run it timed later with:

```bash
timeout 900 bun run src/main.ts 2>&1 | tee live_run.log
```

Expected while limited: `[ratelimit] Birdeye 429 ... retrying in ...` and
`[ratelimit] ... backing off ...` lines, then normal
`[discovery] / [event] / [analysis]` lines once quota recovers.
Progress is append-only and resumable: re-running picks up
`data/events.jsonl` + `data/wallet_observations.jsonl` and rewrites
`data/leader_wallets.json`. If 429s persist, raise
`birdeye.minIntervalMs` / `scanEveryMs` or lower `maxActiveTokens` in
`src/config.ts`.

Output files (`data/` is gitignored):

```text
data/events.jsonl                 # one line per detected pump/dump
data/wallet_observations.jsonl    # one line per trade × event
data/wallet_observations.pre-fix.jsonl  # backup of rows written before the forward-return fix
data/leader_wallets.json          # promoted wallets + methodology block
```

## Project structure

```text
src/
  main.ts        # long-running worker: discover → detect → analyze → report
  config.ts      # all thresholds in one place (tune without touching logic)
  analysis.ts    # pure logic: event detection, trade parsing, wallet scoring
  api/
    birdeye.ts   # token discovery + 1s OHLCV (retry + rate-limit backoff)
    helius.ts    # event-window getTransactionsForAddress client
  storage.ts     # append-only JSONL + leader report
  types.ts / utils.ts
get_tx_for_address.ts  # legacy one-shot Helius fetch for a single token window
```

## What counts as a leader?

For a pump event, a **BUY before the event start** is aligned with the event.
For a dump event, a **SELL before the event start** is aligned with the event.

The report requires at least:

- 3 event observations
- 2 unique tokens

Leaders are ranked by **size-adjusted 60s return**: the directional forward
return down-weighted by the trade's own share of its side's event-window SOL
volume (`directional * (1 - share)`). A wallet that *was* most of the volume
mechanically moved the pool; a small trade followed by a favorable move is
stronger evidence of leadership. Raw directional return is kept alongside as
a fallback for rows written before volume-share existed.

This is deliberately a minimum sample filter, not a trading recommendation or a claim that the wallet causes price movement.

## Forward returns

For each trade, 5/15/30/60s forward returns are computed
**candle-close to candle-close** (Birdeye USD), anchored at the candle
at/before trade time. The 60s value becomes `directionalReturn60s`,
sign-flipped for dump-sells so that a falling price after a pre-dump
sell scores positive. Rows carry `forwardBasis: "candle"`; the
accumulator ignores rows written before this convention existed
(their forwards mixed SOL trade prices with USD closes).
See `SUMMARY.md` (local-only, gitignored) for the fix history and
collected results.

## Research status

- 2 dump events collected, 864 trade observations.
- Leader list still empty: promotion needs a 3rd event on a 2nd token.
- Birdeye budget is healthy (24k+ CUs remaining at last check); earlier
  429s were per-second rate limiting, handled with backoff + cooldown.

## Main parameters

Edit `src/config.ts` to change:

```text
movePct          12% over 60s
accelerationPct   3% over 15s
analysisPreSec   180s before event start
analysisPostSec   30s after event end
forward offsets  5/15/30/60s
```

Keep these parameters explicit during research so they can later be optimized on a separate training/validation split.

## Parser

`parseTrades` evaluates every owner with a target-token balance change (not
just the fee payer) and combines the **native + WSOL** SOL leg, so
Jupiter-style routes that settle in wrapped SOL are still attributed. It
still skips balance changes that do not form a clear opposite-direction
buy/sell pair — validate extracted trades against an explorer on a sample
before using the dataset for model training.

## Replay (offline backtest)

Re-run the identical detector + observation logic over a historical
compact-trade file, with no API calls:

```bash
bun run src/replay.ts --token <mint> --symbol X --trades ./trades.json --out data/replay
```

1s candles are synthesized from trade-price medians (`forwardBasis:
"trade"`), and a candle-gap tolerance (`--gap 5`) keeps sparse-data forward
labels honest. Outputs `<out>_events.jsonl`, `<out>_observations.jsonl`,
`<out>_report.json` — always separate from live `data/` files.

## Train/valid evaluation

```bash
bun run src/eval.ts
```

Orders all events (live + replay) by start time, selects candidates on the
earliest 70% with the live promotion thresholds, and scores their hit rate
on the newest 30%. Time-ordering avoids lookahead leakage. With only a few
events collected, expect `candidates=0` — that is the honest answer until
the worker accumulates more events. The base hit rate (~0.5 on noise) is the
number to beat.
