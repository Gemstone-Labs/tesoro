# Tesoro

Colosseum Crypto World's Fair MVP (deadline Oct 12, 2026). Testnets only: Solana devnet, Ethereum Hoodi, HyperEVM testnet.

## Read first

1. `CONTEXT.md` — the domain language. Use its terms verbatim in code, UI and copy (Gema, not credit/ORO/token). If a concept has no term, stop and raise it.
2. `docs/adr/` — decisions that bind the build.
3. `~/Work/gemstone-labs/tesoro/docs/BUILD.md` (outside the repo, in the workspace) — tracks, acceptance criteria, day plan, cut order.
4. `DESIGN.md` — UI direction (Cut) and tokens.

Nothing outside this repo about earlier Tesoro work is a source. Do not read or reuse `~/Archive/tesoro-pre-2026-09-30/` or the Obsidian `Archive/Tesoro pre-2026-09-30/` folder.

## Layout

`programs/` Anchor 0.31.1 workspace · `contracts/` Foundry · `app/` Next.js 16 (read `app/AGENTS.md`) · `keeper/` cranks · `scripts/`

## Commands

- Programs: `pnpm build:programs` (wraps `scripts/build-programs.sh` — uses platform tools v1.54 because the default tools' Cargo 1.84 cannot parse edition-2024 crates; plain `anchor build` fails). Tests: `cargo test --workspace`. Then `cargo fmt` and `cargo clippy -- -W clippy::all`.
- `/tmp` is a small shared tmpfs: export `TMPDIR=$HOME/.cache/tesoro-tmp` before any cargo/anchor/forge build or test (the build script does this itself).
- Contracts: `pnpm build:contracts`, `pnpm test:contracts`.
- App: `pnpm dev`, `pnpm build:app`.

## Program IDs

| Program | ID |
|---|---|
| tesoro_core | `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh` |
| block_puzzle | `5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj` |
| holdem | `CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE` |
| trading_duel | `CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj` |
| sim_lst | `WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F` |

Devnet RPC: the public `api.devnet.solana.com` rate-limits deploys (429). Use `https://rpc.magicblock.app/devnet` for base-layer devnet (same chain). `devnet.magicblock.app` is the ephemeral rollup, not base layer.

Program keypairs live in `~/.config/tesoro/deploy-keys/`; the build script copies them into `target/deploy/`. Never run `anchor keys sync` or generate new program keypairs.

## Rules

- Solana programs: checked arithmetic, no `unwrap()`, validate every account (owner, signer, PDA), store canonical bumps, validate CPI program IDs, reload accounts after CPIs. Run the `program_autofixer` MCP tool on changed program code until it reports no critical/high issues.
- Label anything simulated as simulated (UI, README, video).
- Work on your own git worktree/branch when running in parallel with other agents; never `git checkout` in the primary checkout. Small commits; conventional messages.
