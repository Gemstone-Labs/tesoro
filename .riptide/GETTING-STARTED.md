# Running Riptide on Tesoro

The `.riptide/sim` guided simulation crate is already authored and pinned (do **not** re-run `riptide sim generate`, which would overwrite `.riptide/sim/Cargo.toml`, `Cargo.lock`, and `src/main.rs`).

## Quick Start

```bash
cargo build-sbf --manifest-path programs/tesoro_core/Cargo.toml --sbf-out-dir target/deploy --tools-version v1.54
cargo build-sbf --manifest-path programs/sim_lst/Cargo.toml --sbf-out-dir target/deploy --tools-version v1.54
.riptide/rerun.sh
riptide sim surface .riptide/sim/artifacts/sol-price-shock --sim .riptide/sim --out .riptide
riptide assess .riptide --input .riptide/assessment-input.json --out .riptide --brief
```

## Step-by-Step

1. Build the required SBF program binaries (`target/deploy/tesoro_core.so` and `target/deploy/sim_lst.so`):
   `cargo build-sbf --manifest-path programs/tesoro_core/Cargo.toml --sbf-out-dir target/deploy --tools-version v1.54`
   `cargo build-sbf --manifest-path programs/sim_lst/Cargo.toml --sbf-out-dir target/deploy --tools-version v1.54`
2. Run the maintained guided-simulation sweep and verify zero errored/panicked iterations:
   `.riptide/rerun.sh`
3. Surface the sweep results into campaign-cartography artifacts:
   `riptide sim surface .riptide/sim/artifacts/sol-price-shock --sim .riptide/sim --out .riptide`
4. Generate the deterministic assessment report (`assessment.md`, `assessment.json`, `brief.html`, `brief.pdf`):
   `riptide assess .riptide --input .riptide/assessment-input.json --out .riptide --brief`

## Layout

- `.riptide/adapters/tesoro-core.toml` — protocol adapter metadata for `tesoro_core`.
- `.riptide/sim/` — authored guided-simulation crate (pinned `riptide-sim` revision, `lst.v1` SOL price shock sweep, exact `Custom(6110)` negative control, hard-error solvency invariants).
- `.riptide/rerun.sh` — maintained replay wrapper outside the generated artifact directory; fails nonzero if any iteration fails or errors.
- `.riptide/assessment.{md,json}`, `.riptide/brief.{html,pdf}` — versioned assessment deliverables.
