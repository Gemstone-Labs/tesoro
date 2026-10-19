# On mainnet a Source is a real staking token, chosen by setting, and its yield is its Staking Rate

Proposed (founder, Oct 15, 2026); revised Oct 16, 2026 to sit on ADR 0010 (yield is computed, never cranked). Mainnet launches SOL, ETH and HYPE Positions on real staking tokens. ADR 0005's simulated yield (linear, 4,380x speed-up) stays for test mode only. The staking partners are not settled: jitoSOL for now (maybe Sanctum), wstETH on Ethereum mainnet (probably Lido), kHYPE on HyperEVM (Kinetiq for now). So the programs must not hard-code any of them.

ADR 0010 is the yield model on every network: `Accrued Yield = Principal x (growth since open - 1)` minus the Yield Fee, computed inside the instruction that needs it, with one shared custody and a Treasury claim from pool totals. This ADR only says what *growth since open* is on mainnet and what a mainnet Player puts in and gets out.

## Decisions

- **The staking token is a setting, not a constant.** Each chain has one active token for new Positions, set by the admin. Every Position records the token it opened with and keeps it until Unlock. Changing partner adds a token; it rewrites nothing and moves no open Position.
- **Growth since open is the token's Staking Rate now divided by its Staking Rate when the Position opened.** On Solana the rate is the SPL stake pool's `total_lamports / pool_token_supply`, read from the pool account inside each instruction; on EVM it comes from the rate adapter (`WstETHRateAdapter`, `KHypeRateAdapter`) read by the vault. Nothing is minted and nothing is cranked: no keeper job exists for mainnet yield.
- **In: coin or token.** A Player deposits SOL, ETH or HYPE (staked on the way in through the provider's own deposit, not a swap), or the staking token directly. Principal is recorded in the underlying coin at the rate of the moment.
- **Out: the token.** Unlock and Redeem pay the staking token. No unstaking queue to run or audit; paying out the plain coin can come later.
- **Advance sizing:** the token's recent growth, read on chain (for example the stake pool's last-epoch totals), capped at a ceiling the admin sets. A yield spike cannot create oversized Advances. The Unlock Estimate stays an estimate. Nothing is published by a keeper.
- **Prices:** an Advance reads the asset's USD price on Solana from Pyth's sponsored push feeds (SOL/USD, ETH/USD, HYPE/USD, shard 0; accounts owned by the Pyth receiver program). MagicBlock's Pyth Lazer feeds (the ones Trading Duel reads in the rollup) were checked on mainnet base layer on 2026-10-15: they exist there but are delegated, owned by the delegation program and frozen at an old snapshot, so they cannot price an Advance. An admin-set mapping per asset names the feed account and feed id; the program refuses a feed of another owner or id, a price older than 120 s and a confidence interval wider than 5% of the price (the mapping sets tighter limits, 90 s and 1% at launch). While an asset has a mapping the oracle can no longer name its price. The keeper's CoinGecko/Coinbase price is test mode only.
- **Gas:** on Ethereum and HyperEVM the Player pays gas and the LayerZero fee to open, shown up front. The relayer does not pay on mainnet.
- **Instant Redeem** pays 75% (fee 25%, down from 35%, founder 2026-10-16) and only while that asset's Treasury holds enough. Treasuries start empty and fill from the Yield Fee (the claim of ADR 0010); nobody seeds them.
- **Custody keys:** program upgrades, admin and fees sit behind a 2-of-3 Squads multisig; keeper, oracle and Invite keys are separate single-purpose hot keys.

## Considered Options

- **Hard-code jitoSOL / wstETH / kHYPE:** rejected. The partner deals are not signed, and swapping would be a program rewrite and a new audit.
- **Several active tokens per chain:** rejected for launch. One active token keeps Advance pricing and redemption simple; per-Position tokens already let us switch.
- **Unlock pays the plain coin:** deferred. Lido's withdrawal queue takes days and Jito unstakes at epoch end; it adds a waiting state to audit.
- **Advance on spot growth or a fixed hand-set APY:** rejected. Spot follows spikes; a fixed rate drifts from reality.
- **A keeper-published trailing APY and a crank that takes the Yield Fee in tokens (the first draft of this ADR):** dropped on 2026-10-16 for ADR 0010's computed model. It needed per-Position custody, a per-token Treasury vault and a keeper job that could stall.

## Consequences

- `SIM_SOL_MINT`, the `sim_lst` Pool constraints and the mint step leave the mainnet path. Test mode keeps `sim_lst`.
- Real yield is small: about 4.5% of Principal a year reaches the Player as Gemas on SOL. Mainnet entries are 100 / 500 / 1,000 Gemas and the default Horizon is 12 months; test mode keeps 500 / 1,000 / 2,500.
- SOL is built (ticket 41): `StakeConfig` and one `StakeCustody` + vault per token, `open_stake_position`, `take_stake_advance` (Pyth-only, sized on the pool's last-epoch growth under the admin ceiling), token payouts and a Treasury kept in tokens (see `docs/tesoro-core.md`). Decided there: the vault is a token account, so custody is per mint; the Staking Rate is held at 1e12; a stale pool (more than one epoch behind) is refused; the Treasury can never take the vault below the Principal of the open Positions. ETH/HYPE on the formula vault is ticket 42.
