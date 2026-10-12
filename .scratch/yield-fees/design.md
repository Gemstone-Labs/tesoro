# Yield Fee and Instant Redeem: design (2026-10-12)

Founder decisions (do not reopen): Tesoro takes **20% of all staking yield** every Position earns (SOL, ETH, HYPE), never Principal. A holder of **won Gemas** can **Instant Redeem** now for **65%** of their value; Tesoro keeps 35% (the Instant Redeem Fee). A Tesoro **Treasury** pays the 65% now, takes the Gemas and redeems them at full value later. Beta: breaking devnet accounts and abandoning the current EVM vaults is acceptable.

## Terms (CONTEXT.md, binding)
- **Yield Fee**: Tesoro's 20% of every yield increment a Position earns, taken before the yield counts toward Debt, redemption or free yield. Never on Principal.
- **Instant Redeem**: turning won Gemas into their Source asset now, before the Source's yield has landed, for 65% of their value. The Treasury takes the Gemas.
- **Instant Redeem Fee**: the 35% Tesoro keeps on an Instant Redeem.
- **Treasury**: Tesoro's holdings per asset (simSOL on Solana, a balance inside each EVM vault) that collect the Yield Fee, pay Instant Redeems, and are refilled when the Gemas it bought are redeemed.
- **Horizon**: the Advance is **80% of projected yield** over the Horizon (100% minus the Yield Fee), so the Unlock Estimate still lands at the Horizon.
- **Platform Fee**: no longer "Tesoro's only revenue".

## Math
- Yield Fee bps `yield_fee_bps = 2000`, cap 5000. Position keeps `units - floor(units * fee / 10000)`.
- Advance (Solana `open_advance`, app quote, keeper): `floor(principal * rate_bps * months * (10000 - yield_fee_bps) / (12 * 10000 * 10000))` source units, then Gemas at the price as before. Repaid in exactly `months * 10` minutes because the Position earns 80% of `principal * apy * t`.
- Instant Redeem payout: `units = floor(gemas * unit_num / unit_den)` (same as Redeem), `payout = floor(units * (10000 - instant_fee_bps) / 10000)`, `instant_fee_bps = 3500` (cap 5000). Only **won** Gemas (`holding.is_own == false`), free (not reserved). Gemas move from the holder's Holding to the Treasury Account's Holding of the same Source (Source counts unchanged: Debt, outstanding, redeemable untouched).

## tesoro_core (Solana)
New account `Treasury`, PDA `["treasury"]`: `bump, vault_bump, account_bump, yield_fee_bps u16, instant_fee_bps u16, account Pubkey (TesoroAccount PDA ["account", treasury_pda]), vault Pubkey (simSOL token account PDA ["treasury_vault"], authority = treasury PDA), fee_units u64 (cumulative SOL units minted as Yield Fee), instant_units u64 (cumulative SOL units paid by SOL Instant Redeem), funded_shares u64`.
The Treasury Account (`TesoroAccount` with `authority = treasury PDA`) holds bought Gemas; nobody can sign for it.

Instructions (new / changed accounts; order matters for clients):
- `init_treasury(yield_fee_bps, instant_fee_bps)` admin. Accounts: `admin (mut signer), config, treasury (init_if_needed), treasury_account (init_if_needed), mint (SIM_SOL_MINT), treasury_vault (init_if_needed), token_program, system_program`. Re-call changes the bps.
- `fund_treasury(shares)` admin. Accounts: `admin (signer), config, treasury (mut), treasury_vault (mut), admin_token (mut, simSOL owned by admin), token_program`.
- `accrue_native_yield()` CHANGED: accounts `position, custody, vault, pool, mint, yield_config, yield_authority, sim_lst_program, token_program, treasury (mut), treasury_vault (mut), source (optional, last)`. Mints 80% of the yield into the Position vault, 20% into the treasury vault.
- `take_advance(horizon, price)` CHANGED: `treasury` added right after `config`.
- `take_native_advance(horizon)` CHANGED: `treasury` added right after `price_feed`.
- `instant_redeem(amount)` NEW (native SOL Sources only): `holder_authority (mut signer), holder_account (mut), position, source, holding (mut), treasury (mut), treasury_account (mut), treasury_holding (init_if_needed ["holding", treasury_account, source], payer holder), treasury_vault (mut), holder_token (mut, simSOL owned by holder), pool (sim_lst ["pool"]), token_program, system_program`. Pays simSOL `floor(payout * 1e9 / rate)` from the treasury vault in the same tx; fails `TreasuryShort` if the vault holds less.
- `instant_redeem_from_source(amount) -> u64` NEW (EVM Sources, holder + bridge sign): `holder_authority (mut signer), source_signer (signer), source_authority, holder_account (mut), position, source, holding (mut), treasury, treasury_account (mut), treasury_holding (init_if_needed, payer holder), system_program`. Returns the payout in source units; the bridge records and caps it.
- `redeem_treasury(amount)` NEW (native SOL, permissionless crank): `treasury, treasury_account (mut), position, source (mut), treasury_holding (mut)`, remaining `[custody, vault, treasury_vault, pool, token_program]`. Normal Redeem rules; simSOL goes into the treasury vault.
- `redeem_treasury_from_source(amount)` NEW (EVM, bridge signs): `source_signer (signer), source_authority, treasury, treasury_account (mut), position, source (mut), treasury_holding (mut)`.
- Events: `InstantRedeemed { position, source, account, gemas, source_units, payout_units }`, `YieldFeeTaken { position, units, shares }`, `TreasuryFunded { shares }`. Errors: `TreasuryShort`, `NotWonGemas` (ledger).

## tesoro_bridge (Solana)
- `YieldAccrued` (type 2) is now **77 bytes**: header(45) | cumulative u128 | treasury_in u128 (the vault's cumulative treasury credits: fees + funding + refills; monotonic).
- New outbound `PayInstant` (type **5**), 93 bytes: header | to bytes32 | amount u128 (same layout as PayYield).
- `BridgePosition` gains `treasury_in: u128` appended at the END (after `unlock_sent`; from the latest yield message). Old BridgePositions no longer decode (size).
- New account `VaultTreasury`, PDA `["treasury", eid u32 BE, vault bytes32]`: `eid, peer_address [32], reported_in u128, instant_recorded u128, bump`. Created by `set_peer_config` (init_if_needed; `vault_treasury` account added after `peer`). Available for Instant Redeem on that vault = `reported_in - instant_recorded`.
- `apply_yield` CHANGED: `vault_treasury (mut)` added after `bridge_position`; it raises `reported_in` to the position's `treasury_in` (max).
- `sync_treasury(PositionRef)` NEW permissionless: `bridge_position, vault_treasury (mut)`.
- `instant_redeem_to_evm(gemas)` NEW: `holder_authority (mut signer), store, authority, core_source_authority, holder_account (mut), core_position, core_source, core_holding (mut), core_treasury, core_treasury_account (mut), core_treasury_holding (mut), vault_treasury (mut), instant_claim (init_if_needed ["instant", holder_account, core_source]), core_program, system_program`. CPIs `instant_redeem_from_source`, refuses (`TreasuryShort`) unless `instant_recorded + payout <= reported_in`, records the payout.
- `send_pay_instant(SendParams)` NEW: like `send_pay_yield` with `instant_claim` instead of `claim`.
- `redeem_treasury_to_evm(gemas)` NEW permissionless: records a normal `Claim` for the Treasury Account.
- `send_pay_yield` CHANGED: `evm_link` is optional; when the claim's holder is the Treasury Account the PayYield goes to the vault's own address (`to == vault`), which the vault books into its treasury.
- `quote_send` accepts msg_type 5.

## EVM vault (PositionVault / PositionVaultOApp, SimLST vaults only)
- `yieldFeeBps = 2000` (cap 5000, admin setter). On accrue, 20% of the minted shares go to `treasuryShares` (`treasuryIn += value`), 80% to the Position.
- `fundTreasury(shares)` admin. No withdrawal (Solana's cap relies on `treasuryIn` only growing).
- `reportYield` reports `(accrued, treasuryIn)`.
- `MSG_PAY_INSTANT` pays from the treasury; `InsufficientTreasury` reverts (retryable); per-(id, seq) idempotent.
- `PayYield` with `to == address(this)` refills the treasury.
- Constructor unchanged; new vaults are deployed with `script/deploy-oapp.sh`, then `SimLST.setMinter(newVault)`.

## What breaks (beta, accepted)
- Every BridgePosition (layout), every current ETH/HYPE Position on the old vaults (abandoned: old vaults speak the 61-byte YieldAccrued, the new bridge refuses it).
- Clients building `accrue_native_yield`, `take_advance`, `take_native_advance`, `apply_yield` (bridge), `set_peer_config`, `send_pay_yield`.
- Existing native SOL Positions keep working (no layout change) but their open Advances were sized at 100%: their Unlock comes 25% later than estimated (they now earn 80%).
