---
status: accepted
---

# Accrued Yield is computed when needed, never recorded by a crank

Decided (founder, Oct 15, 2026). A Position's yield only counted once someone sent a transaction to record it: `accrue_native_yield` per SOL Position (the keeper every ~2 min, or the player's Refresh yield), `reportYield` per ETH/HYPE Position (keeper, or the player's Report yield). Cost and keeper load grew with every Position (10,000 Players × 10 Positions is past what one keeper sends), and players saw buttons for a mechanism they should never meet. Now **no background work exists for yield**: every instruction that needs a Position's Debt or redeemable amount computes its **Accrued Yield** on the spot, and nothing is cranked per Position.

## The model

- **One formula on every network:** `Accrued Yield = Principal × (growth since open − 1)`, minus the 20% Yield Fee. Debt now = Debt at the Advance − Accrued Yield counted toward it. Redeem, Instant Redeem, Unlock, Advance and Extend compute it inside their own transaction, the same math the app uses for its projections. Only *growth since open* differs:
  - **Mainnet:** the staking token's **Staking Rate** now ÷ its Staking Rate when the Position opened. The token's real rate, read on Solana; nobody sets it. The token is chosen later (jitoSOL expected first).
  - **Devnet:** `1 + APY × simulated time since the Position opened`, with a fixed test APY and the 4,380 speed-up (1 month = 10 min). Each Position earns from its own open time, so ADR 0005's per-Position linear yield stands. simSOL's value stays flat; the yield is minted only at the moment it is paid out (Redeem, Unlock, a Treasury withdrawal). Labelled simulated.
- **Advance sizing and Unlock Estimate** are unchanged from ADR 0007 (80% of projected yield over the Horizon): devnet projects from the test APY, so a Horizon still repays in `months × 10` minutes; mainnet from the staking token's recent growth read on chain. The Unlock Estimate stays an estimate.
- **ETH/HYPE.** Solana cannot read the vault, so a **Yield Report** (the vault's Accrued Yield for a Position, plus what the vault Treasury still holds) travels over LayerZero, but only when a Player's action needs it: Redeem or Unlock of Gemas Sourced from that Position asks the vault to report, the action completes when the report lands (usually a minute or two), and the app shows the live vault figure meanwhile. Our relayer sends the request so the Player needs no EVM wallet or gas, but anyone may send it and nobody can alter its content: the relayer is a convenience, not a trust. The vault computes its Accrued Yield with the same formula.
- **Custody.** All SOL Positions hold their tokens in one shared vault; each Position keeps its own record of what it owns.
- **Treasury.** The Yield Fee is a running claim, 20% of the Accrued Yield of every Position, computed from pool-wide totals that change only when a Position opens or unlocks (`Σ Principal` and `Σ Principal × open time` on devnet; the equivalent share totals on mainnet), so it grows without a crank. It is Tesoro's revenue: the admin key may withdraw any of it at any time to the company wallet. Instant Redeem works only while the Treasury holds enough; with nothing left the app shows it as unavailable. On EVM the Yield Report carries what the vault Treasury still holds, so withdrawals there reach Solana; an Instant Redeem the vault cannot pay is refunded.
- **Fresh start, upgraded in place.** Program IDs stay. Positions, Gemas, the Leaderboard Pool, Backings and Offers are reset (old accounts closed once); Profiles and Match history stay and the games are untouched. sim_lst gets new code; ETH/HYPE vaults are redeployed at new addresses. Not before the Season 2 payout (2026-10-19 00:00 UTC).
- **Built in two stages:** SOL first, then ETH/HYPE (vault contract, bridge).

## Considered Options

- **Keep cranking, make it cheaper (batching, longer intervals)**: rejected. Still one action per Position, a full scan of every Position each pass, and lagging state at scale.
- **A pool-wide Staking Rate that grows with the clock on devnet**: first chosen, then rejected. At 4,380× it gains about 0.84× its base per real day, so a Position opened 30 days later earns about 1/26 of the APY; compounding instead overflows within weeks (ADR 0005). Mainnet tokens grow about 7% a year and never meet this, which is why only *growth since open* differs between networks.
- **Scheduled per-vault rate update for ETH/HYPE**: rejected. Still background work; nothing should run unless a Player acts.
- **Our server signs the vault figure at action time**: rejected for mainnet. One company key would vouch for every ETH/HYPE redemption.
- **Wormhole Queries (guardian-signed read in the same transaction) or a Pyth redemption-rate feed**: not now; named as the mainnet upgrade that makes ETH/HYPE redemptions instant. Today Wormhole Queries needs granted access, its Solana verifier is a proof of concept and it does not support Hoodi; no Pyth rate feed was found for wstETH or HYPE staking tokens. LayerZero's read feature answers asynchronously and does not support Solana as the reader.
- **Two Treasury pots (reserve + withdrawable) or a reserve floor**: rejected by the founder. The whole Treasury is revenue; Instant Redeem lives with what is left.
- **Migrate existing devnet Positions**: rejected. Not live yet; a clean reset beats carrying two models.

## Consequences

- Supersedes, in ADR 0005, minting yield into each vault by a crank (the per-Position linear yield stays on devnet), and, in ADR 0007, minting the fee at accrue, the "no treasury withdrawal" rule and the only-growing `treasuryIn` mirror. The 20% Yield Fee, the Instant Redeem Fee and their sizing rules stand. Instant Redeem Fee changed to 25% on 2026-10-16, see ADR 0011.
- The keeper loses its yield jobs (`keeper/src/yield.ts`, `keeper/src/eth.ts`); prices, Seasons and Match hygiene stay.
- The Wallet loses Refresh yield and Report yield. ETH/HYPE Redeem and Unlock become two-step (request, then complete when the Yield Report lands).
- Every devnet Player loses test balances once; the Wallet says so.

Details: `.scratch/yield-by-math/spec.md` until built, then `docs/yield-model.md`, `docs/tesoro-core.md`, `docs/cross-chain.md`.
