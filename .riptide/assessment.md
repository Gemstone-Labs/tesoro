# Protocol assessment — tesoro_core (Solana-native LST positions & advances)

This report records simulation evidence. It is not audit signoff, complete protocol safety, formal verification, mainnet monitoring, or certification.

## Executive summary

- **Protocol:** tesoro_core (Solana-native LST positions & advances)
- **Verdict:** ready_to_send
- **Headline claim:** Across all 28 fixed-seed guided-sim iterations spanning exogenous SOL/USD price shocks from 0 to 6000 bps (0% to -60%), every hard protocol solvency invariant held on the real tesoro_core.so and sim_lst.so binaries: vault LST balance covered open principal at every step, early unlock while debt remained rejected with Custom(6110) (DebtOutstanding), minted yield stayed strictly within the 2-month accrual bound (40,077,776 vs 116,763,898 lamports), and post-repayment unlock returned the full 10 simSOL principal. Crucially, Treasury share outlay for a 1,000-Gema fill_instant_redeem remained flat at 39,999,999 lamports (33.33% of the 0.12 simSOL seeded buffer) across the entire 0-60% SOL/USD crash because tesoro_core prices instant-redeem shares off the Source's locked issuance unit_num/unit_den rather than the post-shock spot PriceFeed — structurally insulating share-denominated Treasury reserves from post-issuance SOL/USD drops. This is evidence over the declared single-position, 2-month native-LST configuration only, not unconditional protocol safety.
- **Main finding:** No finding under the declared inputs.
- **Main limit:** take_native_advance_onchain (Pyth PriceUpdateV2) is out of scope: Out of scope for this sweep; oracle shock is driven via tesoro_core::set_price.

Short summary:

Evidence source: a guided-simulation parameter sweep converted into campaign-cartography artifacts via `riptide sim surface`. The failure rates and gradient are real guided-sim execution over the declared, fixed-seed swept region.

tesoro_core (Solana-native LST positions & advances) was assessed over a guided-simulation sweep `sol_price_drop_bps sweep` (lst.v1), rendered as cartography artifacts: 28 of 28 swept iteration(s) completed under the fixed:1337000000000000000000000000000000000000000000000000000000000000 seed policy, sweeping `sol_price_drop_bps`.

Verdict — ready to send: Declared ready to send for the declared, fixed-seed simulation region.

No declared invariant fired across the 28 completed run(s) within the declared parameter region. Every populated cell held the invariant-failure rate at or under the 5% threshold: the tested swept `sol_price_drop_bps` range stayed within the protocol's observed resilience under this configuration, and no failure boundary was crossed inside the declared, fixed-seed swept region. Stresses beyond the swept region were not tested.

This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.

## Scope

### In scope

- scenario family `guided_sim_sweep`
- guided-sim flow `create_account`
- guided-sim flow `early_unlock_rejected`
- guided-sim flow `faucet_admin`
- guided-sim flow `faucet_alice`
- guided-sim flow `fill_instant_redeem`
- guided-sim flow `fund_treasury`
- guided-sim flow `init_ckpt_page`
- guided-sim flow `init_native_custody`
- guided-sim flow `init_treasury`
- guided-sim flow `init_treasury_stores`
- guided-sim flow `initialize_config`
- guided-sim flow `open_native_position`
- guided-sim flow `redeem`
- guided-sim flow `request_instant_redeem`
- guided-sim flow `set_economy`
- guided-sim flow `set_price_initial`
- guided-sim flow `set_price_shock`
- guided-sim flow `sim_lst_initialize`
- guided-sim flow `sim_lst_set_yield_authority`
- guided-sim flow `take_native_advance`
- guided-sim flow `unlock`
- parameter axis `sol_price_drop_bps` (discrete(0|1000|2000|3000|4000|5000|6000))
- risk objective `Native LST position solvency, yield-mint bounds, early-unlock enforcement, and Treasury instant-redeem buffer utilization under exogenous SOL/USD price shocks (0-60%)` over the fixed:1337000000000000000000000000000000000000000000000000000000000000 seed policy

### Out of scope

- Mainnet behavior, historical replay, and live monitoring.
- Audit signoff, formal verification, and complete protocol safety.
- Flows, parameters, and seeds outside this campaign's declared region.
- Guided-sim boundary: Oracle price updates are driven deterministically via tesoro_core::set_price; Pyth PriceUpdateV2 receiver staleness and confidence checks (take_native_advance_onchain) are out of scope of this sweep.
- Guided-sim boundary: Simulated yield runs against the real sim_lst.so binary at fixed 7% APY / 4,380x speedup over a single 10 simSOL 2-month position and 0.12 simSOL seeded Treasury.
- Guided-sim boundary: Cross-chain LayerZero V2 EVM vault messaging (PositionVaultOApp / tesoro_bridge) and SPL stake-pool slashing are verified separately by Foundry invariants and Rust ledger proptests.

### Claim boundary

This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.

## Risk Plan

- **Protocol class:** lst.v1
- **Target claim:** Across all 28 fixed-seed guided-sim iterations spanning exogenous SOL/USD price shocks from 0 to 6000 bps (0% to -60%), every hard protocol solvency invariant held on the real tesoro_core.so and sim_lst.so binaries: vault LST balance covered open principal at every step, early unlock while debt remained rejected with Custom(6110) (DebtOutstanding), minted yield stayed strictly within the 2-month accrual bound (40,077,776 vs 116,763,898 lamports), and post-repayment unlock returned the full 10 simSOL principal. Crucially, Treasury share outlay for a 1,000-Gema fill_instant_redeem remained flat at 39,999,999 lamports (33.33% of the 0.12 simSOL seeded buffer) across the entire 0-60% SOL/USD crash because tesoro_core prices instant-redeem shares off the Source's locked issuance unit_num/unit_den rather than the post-shock spot PriceFeed — structurally insulating share-denominated Treasury reserves from post-issuance SOL/USD drops. This is evidence over the declared single-position, 2-month native-LST configuration only, not unconditional protocol safety.
- **Evidence profile:** ci-regression
- **P0 flows:** open_native_position; take_native_advance; early_unlock_rejected; set_price_shock; request_instant_redeem; fill_instant_redeem; redeem; unlock
- **P1 flows:** extend_native_advance; withdraw_treasury; take_stake_advance
- **Expected failure modes:** Vault principal dilution or under-collateralization during instant redeem or normal yield payouts; Early principal unlock bypassing outstanding Advance debt; Excessive Treasury buffer drain under post-issuance SOL/USD price crashes; Unbounded sim_lst yield minting beyond accrued yield
- **Guided-sim boundaries:** Oracle price updates are driven deterministically via tesoro_core::set_price; Pyth PriceUpdateV2 receiver staleness and confidence checks (take_native_advance_onchain) are out of scope of this sweep.; Simulated yield runs against the real sim_lst.so binary at fixed 7% APY / 4,380x speedup over a single 10 simSOL 2-month position and 0.12 simSOL seeded Treasury.; Cross-chain LayerZero V2 EVM vault messaging (PositionVaultOApp / tesoro_bridge) and SPL stake-pool slashing are verified separately by Foundry invariants and Rust ledger proptests.
- **Known coverage limits:** Single-position, single-actor lifecycle per iteration (multi-position concurrency and stake-pool rate slashes are covered by Rust ledger stateful proptests).; Does not exercise LayerZero V2 cross-chain bridge instructions or Pyth mainnet receiver accounts.

## Coverage & Limits

This is the negative-space map for the assessment: what Riptide probed, where risk signals concentrated, where the campaign produced no signal, and which declared flows were blocked, out of scope, or not assessed. Flat or zero-failure entries mean no signal in this campaign, not safety.

### Probed surface

Riptide probed the `Native LST position solvency, yield-mint bounds, early-unlock enforcement, and Treasury instant-redeem buffer utilization under exogenous SOL/USD price shocks (0-60%)` surface with 28 completed run(s) under the fixed:1337000000000000000000000000000000000000000000000000000000000000 seed policy; 0 run(s) fired a declared invariant (0.0%).

| Axis | Range | Granularity | Populated bins | Runs | Failed runs | Failure rate |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| sol_price_drop_bps | {0, 1000, 2000, 3000, 4000, 5000, 6000} | value, 7 bin(s), min cell run count 2 | 7/7 | 28 | 0 | 0.0% |

### Hot regions

No hot region was recorded by the coverage statement for the assessed inputs.

### Flat and no-signal regions

These entries are negative space. They record no signal in this campaign, not safety; use them as targets for additional scenarios, manual review, or prover work when the claim matters.

| Region | Signal type | Runs or dispatches | Observed signal | Interpretation |
| --- | --- | ---: | --- | --- |
| flat axis sol_price_drop_bps | invariant_failure | 28 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |
| zero-failure cell sol_price_drop_bps=0 | invariant_failure | 4 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |
| zero-failure cell sol_price_drop_bps=1000 | invariant_failure | 4 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |
| zero-failure cell sol_price_drop_bps=2000 | invariant_failure | 4 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |
| zero-failure cell sol_price_drop_bps=3000 | invariant_failure | 4 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |
| zero-failure cell sol_price_drop_bps=4000 | invariant_failure | 4 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |
| zero-failure cell sol_price_drop_bps=5000 | invariant_failure | 4 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |
| zero-failure cell sol_price_drop_bps=6000 | invariant_failure | 4 | 0 failed run(s), 0.0% failure rate | no signal in this campaign; not safety |

### Blocked or out of scope

Primary limit: take_native_advance_onchain (Pyth PriceUpdateV2) is out of scope: Out of scope for this sweep; oracle shock is driven via tesoro_core::set_price.

| Flow | Status | Evidence tier | Notes |
| --- | --- | --- | --- |
| take_native_advance_onchain (Pyth PriceUpdateV2) | out of scope | none | Out of scope for this sweep; oracle shock is driven via tesoro_core::set_price. |
| tesoro_bridge LayerZero V2 cross-chain messaging | out of scope | none | Out of scope for Solana-only guided sim; covered separately by EVM PositionVaultOApp Foundry invariants and bridge LiteSVM suite. |

## Coverage Matrix

Status values: `covered`, `covered by guided sim`, `blocked`, `out of scope`, `not assessed`.

| Priority | Flow | Status | Evidence tier | Commands | Artifacts | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | early_unlock_rejected | covered by guided sim | guided-sim-sbf | `riptide sim run .riptide/sim --flows 1 --seed 1337 --out .riptide/sim/artifacts/sol-price-shock` | .riptide/sim/artifacts/sol-price-shock/guided-sim-run.json | HELD (negative control) across 28/28 runs: unlock before debt repayment deterministically rejected with Custom(6110) (DebtOutstanding). |
| P0 | open_native_position | covered by guided sim | guided-sim-sbf | `riptide sim run .riptide/sim --flows 1 --seed 1337 --out .riptide/sim/artifacts/sol-price-shock` | .riptide/sim/artifacts/sol-price-shock/guided-sim-run.json | HELD across 28/28 runs: locks 10 simSOL into shared native custody vault and preserves vault_principal_solvency. |
| P0 | redeem & unlock | covered by guided sim | guided-sim-sbf | `riptide sim run .riptide/sim --flows 1 --seed 1337 --out .riptide/sim/artifacts/sol-price-shock` | .riptide/sim/artifacts/sol-price-shock/guided-sim-run.json | HELD across 28/28 runs: post-horizon redeem minted 40,077,776 lamports (within 116,763,898 bound) and unlock returned >= 10,000,000,000 simSOL principal. |
| P0 | request_instant_redeem & fill_instant_redeem | covered by guided sim | guided-sim-sbf | `riptide sim run .riptide/sim --flows 1 --seed 1337 --out .riptide/sim/artifacts/sol-price-shock` | .riptide/sim/artifacts/sol-price-shock/guided-sim-run.json | HELD (structural robustness) across 0-6000 bps SOL/USD shock: 1,000-Gema fill consumed exactly 39,999,999 lamports (33.33% of 0.12 simSOL buffer) at every shock level because pricing binds to Source issuance unit_num/unit_den. |
| P0 | take_native_advance | covered by guided sim | guided-sim-sbf | `riptide sim run .riptide/sim --flows 1 --seed 1337 --out .riptide/sim/artifacts/sol-price-shock` | .riptide/sim/artifacts/sol-price-shock/guided-sim-run.json | HELD across 28/28 runs: issues 1,750 Gemas for a 2-month advance at $150/SOL and initializes SourceBook + checkpoint pages. |
| P1 | take_native_advance_onchain (Pyth PriceUpdateV2) | out of scope | none | none | none | Out of scope for this sweep; oracle shock is driven via tesoro_core::set_price. |
| P1 | tesoro_bridge LayerZero V2 cross-chain messaging | out of scope | none | none | none | Out of scope for Solana-only guided sim; covered separately by EVM PositionVaultOApp Foundry invariants and bridge LiteSVM suite. |

## Risk Surface

This surface reports invariant-failure rates and metric percentiles observed within this campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only, not a proof of protocol safety or a prediction of mainnet behavior.

### Parameter sensitivity

Method: Per-axis marginal invariant-failure-rate spread: for each axis, the failure rate is computed per bin by marginalizing over the other axes (failed runs / runs in that bin), and the spread is max − min across that axis's populated bins. Axes are ranked by spread descending, ties broken by axis name ascending. The monotonic note compares consecutive populated bins by increasing bin index. The elasticity note is the signed average failure-rate change per bin step from the first to the last populated bin: (rate_last − rate_first) / (index_last − index_first); positive means risk rises with the axis.

| Rank | Parameter | Failure-rate spread | Min bin | Max bin | Trend | Elasticity / bin step |
|---:|---|---:|---:|---:|---|---:|
| 1 | sol_price_drop_bps | 0.0% | 0.0% | 0.0% | flat | 0.0% |

### Failure-rate heatmap

Legend: `░` 0–25%  `▒` 25–50%  `▓` 50–75%  `█` 75–100%  `·` no runs

Axis: `sol_price_drop_bps` (most sensitive).

| sol_price_drop_bps | Failure rate | Runs |
|---|---|---:|
| 0 | ░ 0.0% | 4 |
| 1000 | ░ 0.0% | 4 |
| 2000 | ░ 0.0% | 4 |
| 3000 | ░ 0.0% | 4 |
| 4000 | ░ 0.0% | 4 |
| 5000 | ░ 0.0% | 4 |
| 6000 | ░ 0.0% | 4 |

### Safe region (failure rate ≤ 5.0%)

Every populated cell stayed at or under the 5% failure-rate threshold within this declared, fixed-seed parameter region.

Recommended bounds within this declared, fixed-seed parameter region:

- **sol_price_drop_bps:** allow `0`, `1000`, `2000`, `3000`, `4000`, `5000`, `6000`

Worst-case in-region failure rate: 0.0%.

## Simulations run

### Guided sims

| Objective | Command | Result | Retained evidence | Hashes | Notes |
| --- | --- | --- | --- | --- | --- |
| Native LST position solvency, yield-mint bounds, early-unlock enforcement, and Treasury instant-redeem buffer utilization under exogenous SOL/USD price shocks (0-60%) | `riptide sim run (sweep) -> riptide sim surface -> riptide assess` | 28 runs completed with no invariant failure | .riptide/retention-manifest.json | campaign-digest 6c73096958d925f78eab439b1566dd6c586d038c904f652611a268e1e6c6a038; risk-surface.json sha256 5edeee9b7d028f6af52860f9936cf87493e407a4a9318dba80ee15c41c5716b8 | Failure rate 0% over the declared fixed:1337000000000000000000000000000000000000000000000000000000000000 region. |

## Findings

Reproducible issues or risk signals observed in the declared simulations.

No finding under the declared inputs.

## Non-Findings

Tested claims where no declared invariant fired under the listed inputs. A non-finding is not proof that the protocol is safe.

| Flow | Evidence | Statement | Limit |
| --- | --- | --- | --- |
| open_native_position | risk-surface.json sha256 5edeee9b7d028f6af52860f9936cf87493e407a4a9318dba80ee15c41c5716b8 | No declared invariant fired under these inputs. | Evidence is bounded to the declared, fixed-seed parameter region and run budget. |

## Blocked and out-of-scope surfaces

| Surface | Status | Reason | Needed next step | Owner |
| --- | --- | --- | --- | --- |
| take_native_advance_onchain (Pyth PriceUpdateV2) | out of scope | Out of scope for this sweep; oracle shock is driven via tesoro_core::set_price. | Cover by manual review, audit, or monitoring outside this assessment. | protocol owner |
| tesoro_bridge LayerZero V2 cross-chain messaging | out of scope | Out of scope for Solana-only guided sim; covered separately by EVM PositionVaultOApp Foundry invariants and bridge LiteSVM suite. | Cover by manual review, audit, or monitoring outside this assessment. | protocol owner |

## Reproduction Commands

Run these commands from the repository root at the assessed checkout.

```bash
riptide assess .riptide
```

Expected artifacts:

| Artifact | Hash or result |
| --- | --- |
| .riptide/campaign-summary.json | not emitted |
| .riptide/risk-surface.json | 5edeee9b7d028f6af52860f9936cf87493e407a4a9318dba80ee15c41c5716b8 |
| .riptide/retention-manifest.json | not emitted |

Canonical hashes:

- **Campaign digest:** `6c73096958d925f78eab439b1566dd6c586d038c904f652611a268e1e6c6a038`
- **Surface digest:** `281f59c392def49de948de3407c38198ee585c011062fc2f4ca1e0e833b692cc`
- **`risk-surface.json` sha256:** `5edeee9b7d028f6af52860f9936cf87493e407a4a9318dba80ee15c41c5716b8`

## Execution Honesty

- **Status:** `pass`
- **Surface hash:** `5edeee9b7d028f6af52860f9936cf87493e407a4a9318dba80ee15c41c5716b8`

| Gate | Status | Detail |
| --- | --- | --- |
| positive_control | pass | positive control sol_price_drop_bps=0 passed across 4 iteration(s). |
| lifecycle_executed | pass | all 7 declared lifecycle flow(s) executed on-chain. |
| determinism | pass | risk-surface.json byte-stable (sha256 5edeee9b7d028f6a…); assessment.json and assessment.md are checked for byte-stability at emit time. |

## Recommended next work

- Every populated cell held the invariant-failure rate at or under the 5% threshold: the tested swept `sol_price_drop_bps` range stayed within the protocol's observed resilience under this configuration, and no failure boundary was crossed inside the declared, fixed-seed swept region. Stresses beyond the swept region were not tested.
- Guided sim needed: Oracle price updates are driven deterministically via tesoro_core::set_price; Pyth PriceUpdateV2 receiver staleness and confidence checks (take_native_advance_onchain) are out of scope of this sweep.
- Guided sim needed: Simulated yield runs against the real sim_lst.so binary at fixed 7% APY / 4,380x speedup over a single 10 simSOL 2-month position and 0.12 simSOL seeded Treasury.
- Guided sim needed: Cross-chain LayerZero V2 EVM vault messaging (PositionVaultOApp / tesoro_bridge) and SPL stake-pool slashing are verified separately by Foundry invariants and Rust ledger proptests.
- Coverage limit to extend: Single-position, single-actor lifecycle per iteration (multi-position concurrency and stake-pool rate slashes are covered by Rust ledger stateful proptests).
- Coverage limit to extend: Does not exercise LayerZero V2 cross-chain bridge instructions or Pyth mainnet receiver accounts.

## Toolchain

- **Adapter:** guided-sim
- **Campaign class:** lst.v1
- **Seed policy:** fixed:1337000000000000000000000000000000000000000000000000000000000000
- **Environment notes:** Assessment is generated from existing campaign artifacts (ingest-only); it does not run the engine.

## Reviewer checklist

Before forwarding this report, verify each item.

- [ ] The commit SHA is present and matches the assessed checkout.
- [ ] Every headline claim points to a command, artifact, and hash when one was emitted.
- [ ] Every P0 Risk Plan flow appears in the Coverage Matrix.
- [ ] `blocked`, `out of scope`, and `not assessed` rows explain why the flow is not covered.
- [ ] Findings and Non-Findings are separate.
- [ ] Non-Findings use bounded language such as "no declared invariant fired under these inputs."
- [ ] Reproduction Commands are exact and runnable from the repository root.
- [ ] Artifacts are attached or their paths are valid for the reviewer.
- [ ] Hashes are copied exactly from the Riptide output or marked "not emitted."
- [ ] The report says this is simulation evidence, not audit signoff or complete protocol safety.
