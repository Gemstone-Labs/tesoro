# On mainnet a Source is a real staking token, chosen by setting, and Advances are sized on its trailing APY

Proposed (founder, Oct 15, 2026). Mainnet launches SOL, ETH and HYPE Positions on real staking tokens. ADR 0005's simulated yield (linear, 4,380x speed-up) stays for test mode only. The staking partners are not settled: jitoSOL for now (maybe Sanctum), wstETH on Ethereum mainnet (probably Lido), kHYPE on HyperEVM (Kinetiq for now). So the programs must not hard-code any of them.

## Decisions

- **The staking token is a setting, not a constant.** Each chain has one active token for new Positions, set by the admin. Every Position records the token it opened with and keeps it until Unlock. Changing partner adds a token; it rewrites nothing and moves no open Position.
- **Yield is the token's exchange-rate growth.** Nothing is minted. Custody already counts yield as `tracked_shares * rate - principal + redeemed`; the rate now comes from the real stake pool (Solana) or rate adapter (EVM; `WstETHRateAdapter` is the pattern).
- **In: coin or token.** A Player deposits SOL, ETH or HYPE (staked on the way in through the provider's own deposit, not a swap), or the staking token directly.
- **Out: the token.** Unlock and Redeem pay the staking token. No unstaking queue to run or audit; paying out the plain coin can come later.
- **Advance sizing:** the token's trailing 30-day APY, published on chain by the keeper, capped at a ceiling the admin sets. A yield spike cannot create oversized Advances. The Unlock Estimate stays an estimate.
- **Prices:** an Advance reads the asset's USD price on Solana from Pyth's sponsored push feeds (SOL/USD, ETH/USD, HYPE/USD, shard 0; accounts owned by the Pyth receiver program). MagicBlock's Pyth Lazer feeds (the ones Trading Duel reads in the rollup) were checked on mainnet base layer on 2026-10-15: they exist there but are delegated, owned by the delegation program and frozen at an old snapshot, so they cannot price an Advance. An admin-set mapping per asset names the feed account and feed id; the program refuses a feed of another owner or id, a price older than 120 s and a confidence interval wider than 5% of the price (the mapping sets tighter limits, 90 s and 1% at launch). Principal is recorded in the underlying coin (SOL base units at the pool's rate; wei for EVM), so the coin's USD price converts the yield to Gemas. While an asset has a mapping the oracle can no longer name its price. The keeper's CoinGecko/Coinbase price is test mode only.
- **Gas:** on Ethereum and HyperEVM the Player pays gas and the LayerZero fee to open, shown up front. The relayer does not pay on mainnet.
- **Instant Redeem** pays 75% (fee 25%, down from 35%) and only while that asset's Treasury holds enough. Treasuries start empty and fill from the Yield Fee; nobody seeds them.
- **Custody keys:** program upgrades, admin and fees sit behind a 2-of-3 Squads multisig; keeper, oracle and Invite keys are separate single-purpose hot keys.

## Considered Options

- **Hard-code jitoSOL / wstETH / kHYPE:** rejected. The partner deals are not signed, and swapping would be a program rewrite and a new audit.
- **Several active tokens per chain:** rejected for launch. One active token keeps Advance pricing and redemption simple; per-Position tokens already let us switch.
- **Unlock pays the plain coin:** deferred. Lido's withdrawal queue takes days and Jito unstakes at epoch end; it adds a waiting state to audit.
- **Advance on spot APY or a fixed hand-set APY:** rejected. Spot follows spikes; a fixed rate drifts from reality.

## Consequences

- `SIM_SOL_MINT`, the `sim_lst` Pool constraints and the mint step leave the mainnet path (about eight instructions in `tesoro_core`, plus Treasury). Test mode keeps `sim_lst`.
- Real yield is small: about 4.5% of Principal a year reaches the Player as Gemas on SOL. Mainnet entries are 100 / 500 / 1,000 Gemas and the default Horizon is 12 months; test mode keeps 500 / 1,000 / 2,500.
