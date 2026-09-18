# v4 Validation Notes

v4 preserves the v3 event detector and price-source policy. The new functionality is additive:

- deterministic DexScreener pair-address metadata per accepted event token
- five-way wallet labels with explicit reasons
- phase-aware SOL volume and trade-count splits
- candle-price-based average entry/exit fields for live USD observations
- backward-compatible handling of v3 rows with missing v4 fields

The historical v3 replay remains useful as the baseline. In the compact VIBE CSV used for replay, the original exporter did not attribute pool legs, so no historical observation can be expected to match a DexScreener pair address; the replay will therefore show mostly `unknown/default` labels unless `--pool-addresses` are supplied explicitly. Pool labels are not available from the compact CSV unless pair addresses are supplied with `--pool-addresses`; this is intentional because the pair metadata is event-time labeling metadata, not part of the original compact export.

Do not interpret the wallet report as a causal ranking. v4 remains an observational research pipeline.

## v4.1 infrastructure reporting fix

Pair-address, router, and program labels remain in the raw `wallet_observations` and `wallet_events` files, but are now excluded from leader promotion and the validation candidate set. This is a reporting/evaluation filter only; it does not delete or alter the underlying observations.

## v4.2 consolidation validation (main project)

v4.1 was promoted into the main project with additive extensions, all verified in place:

- `tsc --noEmit` (plus `--noUncheckedIndexedAccess`): PASS
- `bun run src/selftest.ts`: PASS, including the discriminating aligned-pool-buys case (mutation-tested: removing the infra filter makes the selftest fail with "pool wallet with aligned buys must not be promoted")
- `bun run src/replay.ts` on `helius_bun_trades.csv`: trades=1620 candles=2507 events=4 researchEvents=4 observations=564 walletEvents=227 leaders=0 — counts identical to v4.1, with side-split leads, per-horizon directionals, net volume, and pre-breakout counts populated
- Parse skip-reason histogram ported into `diagnose`; Helius fetch bound unchanged
- `median_trade_vs_liquidity` is intentionally mixed-unit (SOL volume / USD liquidity): relative comparisons only
