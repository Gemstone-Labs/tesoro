# Tesoro Build Brief — Colosseum Crypto World's Fair MVP

**Deadline:** Oct 12, 2026, 23:59 PT. **Target submit:** Oct 11. **Proof & video freeze:** Oct 10. **Cut checkpoint:** end of Oct 8.

**Sources of truth, in order:** `CONTEXT.md` (language — use its terms exactly in code, UI and copy), `docs/adr/` (decisions), `DESIGN.md` (UI), this brief (plan). Nothing else. Everything outside this repo about earlier Tesoro work is archived and off-limits.

**Environment:** testnets only — Solana devnet, Ethereum Hoodi, HyperEVM testnet. No value, no mainnet.

## Repo layout

```
programs/        Anchor workspace (Solana)
  tesoro_core/     Positions (Solana-native + mirrored), Advances, Gemas & Sources, Debt, Redeem,
                   Matches & escrow, Fees, Backing, Game registry, LayerZero OApp endpoint
  block_puzzle/    async Game program (Private Ephemeral Rollup)
  holdem/          real-time Game program (Private Ephemeral Rollup)
  sim_lst/         simulated staking token with an accelerated yield clock (Solana)
contracts/       Foundry workspace (EVM: Hoodi + HyperEVM)
  PositionVault    locks an LST, reports accrued yield, unlocks, pays yield — LayerZero OApp
  SimLST           simulated staking token with an accelerated yield clock
app/             Next.js web app (DESIGN.md), embedded wallets
keeper/          off-chain cranks: yield-report cadence, expiries, Match timeouts, faucet
scripts/         deploy, configure LayerZero pathways, seed demo data
```

## Stack defaults (chosen by Claude — change any before the build starts)

| Area | Default | Why |
|---|---|---|
| Solana programs | Anchor **0.31.1** | Pinned by LayerZero's `oapp-solana` example; avoid a version fight |
| EVM | Foundry, Solidity ^0.8.2x, LayerZero `OApp` | Standard OApp path |
| Cross-chain | LayerZero V2 (ADR 0002) | eids: Solana devnet 40168, Hoodi 40449, HyperEVM testnet 40362 |
| Games | MagicBlock Private Ephemeral Rollups, `ephemeral-rollups-sdk` ≥ 0.14 (ADR 0003) | Hidden state, no game servers |
| Price at issuance | Pyth (pull oracle) SOL/ETH/HYPE-USD | Only needed when an Advance is issued |
| Accounts | Privy embedded wallets (Solana + EVM), external-wallet linking | Email login for Players and judges (Q21) |
| Web | Next.js + TypeScript, `@solana/kit`, viem | |
| Hosting | Vercel (app), Fly or a small VM (keeper) | |

## Cross-chain messages (all carry `sourceChain`, `positionId`, monotonic `seq`; every handler is idempotent)

| Message | Direction | Meaning |
|---|---|---|
| `PositionLocked` | source → Solana | Position opened with an LST amount and Horizon; Solana issues the Advance (Pyth price at issuance fixes Gemas ↔ source-asset rate) |
| `YieldAccrued` | source → Solana | Cumulative accrued yield of the Position in source-asset units; Solana applies it to Debt and makes that much of the Source redeemable |
| `Unlock` | Solana → source | Debt is zero; release Principal to the owner |
| `PayYield` | Solana → source | Transfer accrued yield (as LST shares) to a redeeming Gema holder's address on that chain |

Solana-native Positions use the same state machine without messaging.

## Tracks

Each track is one agent (or one agent at a time). Tracks list what they consume from others; stub those until they land.

### S — Spikes (days 1–2, block everything risky)
- **S1 PER poker:** a deck neither Player can read, shuffled with randomness nobody can predict; two hole-card accounts each readable only by its Player; a Match delegated to the private rollup settles its Pot on base-layer Solana. **Fail by end of day 2 →** Hold'em uses a result-signing server under a registered Game key (ADR 0003).
- **S2 LayerZero Solana ↔ HyperEVM testnet:** round-trip a message both ways with our OApps. **Fail by end of day 4 →** HyperEVM moves to Wormhole with self-relay (ADR 0002).
- **S3 LayerZero Solana ↔ Hoodi:** same, lower risk.

### T1 — `tesoro_core` (the money rules; highest bar)
Positions, Advance (Horizon 1–12 months, 100% of projected yield, one open Advance per Position, 1 Gema = $0.01 at issuance), Gema holdings by Source, Debt, automatic repayment from `YieldAccrued`, return of own unspent Gemas, Redeem (only up to accrued), Match join/escrow/settle/refund with Platform Fee + Studio Fee taken in Gemas, own-Sourced-first entry draw, Backing (Request, Offer, accept, 24h expiries, no revoke after start, entry-first then Backer-set split), Game registry (only a registered Game program may settle its Matches).
**Acceptance:** property tests proving conservation — total Gemas per Source always equals that Source's Debt plus redeemed amount; no path lets Principal reduce Debt; no double settle; no settle from an unregistered Game; Backer never charged beyond the Offer; backed Player never gains Debt.

### T2 — EVM contracts
`PositionVault` on Hoodi (real wstETH path + SimLST) and HyperEVM (SimLST only), `SimLST` with an accelerated yield clock, LayerZero wiring. **Acceptance:** Principal can leave only via `Unlock`; `PayYield` can never exceed reported accrued yield; replayed or out-of-order messages are no-ops.

### T3 — Solana-native Positions
SimLST path (default demo) and Jito devnet pool path (real LST). Same acceptance as T2.

### T4 — Games
- **Block Puzzle** (async, same Seed, ~90s): Player moves stay private until both Players finish; the program computes the score from moves against the Seed; higher score wins, tie draws, missed window forfeits. One Tesoro twist (e.g. emerald gem tiles as multipliers) — design it, keep it small.
- **Hold'em** (heads-up, Chips in-match, turn clock and no-show via cranks) — after S1.

### T5 — Web app
Screens: Lobby (featured game, entry ladder 500/1,000/2,500, Hold'em row, Backing Requests), Game play, Wallet (Positions per chain, take Advance with Horizon, Unlock Estimate, Gemas redeemable-now vs pending by Source, Redeem, return unspent), Backing (post Request, browse and make Offers, public Offers with applicants), Match history per Account, cross-chain progress states, "Simulated yield · 1 month = 10 min" label everywhere amounts show. Follows `DESIGN.md` (Cut).

### T6 — Keeper, deploy, demo environment
Yield-report cadence per Position, expiry and timeout cranks, deploy/configure scripts for all chains, faucet ("get test tokens"), seeded demo accounts (a Backer, a Player, opponents) so a lone judge can finish every flow.

### T7 — Submission
README with exact networks, program/contract addresses, explorer links, and what is simulated; ≤3 min product demo video; 2–3 min pitch video; deck.

## Day plan

| Days | Focus |
|---|---|
| Sep 30 – Oct 1 | Scaffold repo; S1, S2, S3 in parallel; T1 core ledger (no chains) with property tests; DESIGN tokens + app shell |
| Oct 2 – Oct 4 | T1 Matches, Fees, Backing; T2/T3 vaults + messaging; Block Puzzle program; Wallet + Lobby screens. **Day 4: S2 fallback decision** |
| Oct 5 – Oct 7 | Hold'em (or fallback); end-to-end: lock → Advance → Match → settle → yield → Redeem → Unlock on all three chains; Backing UI; keeper + faucet |
| Oct 8 | **Cut checkpoint** — cut in order: public Offers → real-LST path → Hold'em → HyperEVM over LayerZero (switch to Wormhole) |
| Oct 9 – Oct 10 | Hosted smoke on all networks, fix, record videos, freeze proof |
| Oct 11 | Submit (buffer to Oct 12) |

## Rules for every agent
- Use `CONTEXT.md` terms verbatim; if a term is missing or wrong, stop and raise it — don't invent one.
- Solana program changes: `anchor build`, `cargo fmt`, `cargo clippy -- -W clippy::all`, tests; checked arithmetic; no `unwrap()`; validate every account; store canonical bumps; run `program_autofixer` until clean.
- Label anything simulated as simulated — in UI, README and video.
- Small commits on the working branch; worktrees (never `git checkout` in the primary checkout) for anything risky.
