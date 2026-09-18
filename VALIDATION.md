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

## v5 permutation null + bootstrap CIs

`evaluateWallets` now ships a wallet-shuffled null (fixed train selection, labels permuted across scored validation entries) and bootstrap percentile intervals, all on a seeded RNG (`eval.permutationCount`, `eval.randomSeed`).

- `bun run src/selftest.ts`: v5 fixture asserts determinism (two runs identical), bounds (p/null/CI in [0,1]), and a small p-value for a perfect candidate against mixed background. Observed on fixture: p=0.208 nullMean=0.504 obs=1.00 — matches the closed-form hypergeometric expectation (3/15 = 0.2).
- Mutation-tested: an identity shuffle fails the self-test at "null mean should sit below a perfect observed rate".

## DBotX discovery fallback

Birdeye token-list is plan-blocked (401) on the current key while OHLCV works, so discovery chains Birdeye -> DBotX hot+surging -> frozen universe. Verified live: hot=70 rows, surging empty (valid quiet state), mapper filters to 10 candidates with seeded pair addresses. DBotX omits holders/marketCap on most rows, so filters stay lenient and the detector selects. One cycle costs ~20 DBotX credits.

## Debot activity-rank discovery

Debot community-signal ranking (keyless, 5m window, only duration=5m supported upstream) slots between Birdeye and DBotX: free, attention-led, with native USD market cap/liquidity/volume plus holder/swap counts and pair addresses. Verified live: ranked=20, qualified=10 with real liquidity ($8k–$464k) and seeded pairs. Empty results fall through to DBotX; universe only, never event timing.
