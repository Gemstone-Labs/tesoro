# Keeper

Off-chain process that keeps the devnet demo moving without a human. Every job is idempotent, permissionless on chain (the keeper is just a fee payer) and logs one line per action.

```
pnpm --filter @tesoro/keeper start            # loop, every 20 s
pnpm --filter @tesoro/keeper start --once     # one pass, then exit
pnpm --filter @tesoro/keeper start --once --dry-run   # say what it would do, send nothing
pnpm --filter @tesoro/keeper typecheck
```

Flags / env: `--interval <secs>` (`KEEPER_INTERVAL_SECS`, 20), `--max-sol-per-hour <n>` (`KEEPER_MAX_SOL_PER_HOUR`, 0.5), `--rpc <url>` (`KEEPER_RPC`, default `https://rpc.magicblock.app/devnet`; the public devnet RPC rate-limits), `KEEPER_KEYPAIR` (`~/.config/tesoro/keeper.json`), `KEEPER_FUNDER` (`~/.config/solana/id.json`), `TESORO_IDL_DIR`.

Payer: `~/.config/tesoro/keeper.json` is created on first run and funded with 2 devnet SOL from the deployer keypair (never in the repo). Fees and rent it spends are tracked in a rolling hour; at the cap, actions are skipped and logged. 429s are retried with exponential backoff inside each RPC call, and the loop doubles its delay (max 5 min) after a rate-limited pass.

## Jobs

1. **Match hygiene** (every Match in tesoro_core that is not Settled or Refunded)
   - Block Puzzle: no opponent, no Session or no Seed before the Match deadline: `refund_match`. Boards on the base layer and both sealed: `settle`. Past the submission deadline and nobody played: `claim_timeout`. Boards in the private rollup: past the deadline, or when a free simulation of `seal` says both runs are closed, `seal` + `commit_boards` then `settle`. Otherwise it logs why it waits and until when.
   - Hold'em: a finished (over or cancelled) table on the base layer: `finalize`. A delegated table is private to its Players, so the keeper simulates `claim_timeout` (idle Player past deadline) and `close_match` (table finished) in the rollup and sends what would succeed, then `finalize`. A table that never went live, or no table, past the Match deadline: `refund_match`. It never refunds a live delegated table.
2. **Backing hygiene**: `expire_offer` for Open Offers past `expires_at` and Accepted Offers past `use_by`, releasing the Backer's reservation. Requests have no expiry instruction in tesoro_core (only the Player can `cancel_request`) and hold no reservation, so they are only counted.
3. **Price feed** (`src/price.ts`): the oracle key (`KEEPER_ORACLE`, `~/.config/tesoro/oracle.json`) publishes SOL/USD with `set_price` whenever the on-chain `PriceFeed` is older than 50 minutes (`KEEPER_PRICE_REFRESH_SECS`; so at least hourly; Advances reject a feed older than 24 h). Price from Pyth Hermes, else CoinGecko, else Coinbase spot, else the last on-chain value (else $150). It is a **devnet price feed**, a stand-in until Pyth is read on chain. The oracle pays that fee, so keep it funded.
4. **Yield** (`src/yield.ts`): every Solana-native Position (simSOL custody, `source_asset == SIM_SOL_MINT`) that is Locked with Debt > 0 (`open_advance` set) gets `accrue_native_yield` each pass, with the real accounts `[position, custody, vault, pool, open Advance source]` built by `app/src/lib/chain/native.ts` (shared with the app). Simulated yield: 1 month = ~10 min. ETH Positions: `PositionVault.reportYield` on Hoodi is a stub that logs how many Positions are waiting.

## Sharing

The keeper imports the app's IDL-based clients (`app/src/games/*/chain.ts`) and IDL JSON directly, so it cannot drift from them. It only needs `app/` to be installed (`pnpm install` at the root).

## Limits

- Private rollup state (Block Puzzle Boards, Hold'em tables) is unreadable to the keeper; it uses simulations and program-enforced clocks to decide. If the rollup rejects simulation from a non-member, the keeper waits for the deadline paths.
- Block Puzzle Matches are settled by the Player clients when they can; the keeper is the fallback.
