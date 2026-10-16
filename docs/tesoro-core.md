# tesoro_core

The money rules of Tesoro (CONTEXT.md, ADR 0001). Two layers:

- `programs/tesoro_core/src/ledger/` is the pure accounting core: plain structs and functions, no clocks, accounts or syscalls (Anchor is used only for the Borsh derive). Every mutating function validates before it mutates. Property tests live in `ledger/tests.rs`.
- The rest of the crate is thin Anchor instructions that load accounts, validate them, call the ledger and store the result.

Cross-chain and game integration are not here yet. Two seams are explicit: `Config.oracle_authority` (see below) and the `Redeemed` / `PositionUnlocked` events (the `PayYield` and `Unlock` message seams).

## Units

A Source fixes its rate at issuance as `unit_num / unit_den` source-asset base units per Gema, with `unit_num = 10^(decimals+4)` and `unit_den = price` (USD per whole asset, micro-USD). One Gema is $0.01 = 10,000 micro-USD. The USD price is never consulted again. Debt is kept in Gemas and converted to source-asset units on demand (rounded up when repaying, down when paying out, so accrued yield is never over-spent).

Per Source: `issued`, `returned` (cancelled by the owner), `redeemed`, `yield_units` (accrued yield applied). `covered = min(issued - returned, floor(yield_units / rate))`; `debt = issued - returned - covered`; `outstanding = issued - returned - redeemed` (held or escrowed); `redeemable = covered - redeemed`. Conservation: `held + escrowed == outstanding`, hence `outstanding + redeemed + returned == issued`.

## Accounts (PDAs)

| On chain | CONTEXT term | Seeds |
|---|---|---|
| `Config` | (registry, fees, oracle) | `["config"]` |
| `TesoroAccount` | Account | `["account", authority]` |
| `PositionState` | Position | `["position", chain_byte, position_id]` |
| `SourceState` | Source (one per Advance) | `["source", position, index_le]` |
| `HoldingState` | Gemas held per (Account, Source) | `["holding", account, source]` |
| `MatchState` | Match (and its Pot, in escrow as lines) | `["match", id_le]` |
| `RequestState` | Request | `["request", player_account, nonce_le]` |
| `OfferState` | Offer (and the reservation) | `["offer", backer_account, nonce_le]` |

`Account` is `TesoroAccount` on chain because `Account` is Anchor's wrapper type. Every account stores its canonical bump. Ledger identities are PDA addresses: an Account key is its `TesoroAccount` address, a Source key is its `SourceState` address.

## Instructions

Config: `initialize_config`, `update_config`, `register_game`, `remove_game` (admin). Identity: `create_account`, `set_evm_address`, `open_holding` (anyone pays; own-sourced iff the Source belongs to the Account).
Position: `open_position` (oracle), `open_native_position`, `take_native_advance`, `extend_native_advance`, `init_native_custody`, `set_price` (see Solana-native Positions below), `take_advance` (owner picks the Horizon, oracle supplies the price, both sign), `apply_yield` (oracle; idempotent by `seq`), `return_own`, `redeem` (refuses EVM-sourced Sources: they use `redeem_from_source`, co-signed by the chain's source authority, called by the bridge's `redeem_to_evm`), `claim_free_yield`, `unlock`.
Match: `open_match`, `join_match`, `open_match_backed`, `join_match_backed`, `settle_match` (registered Game authority only), `extend_match_deadline` (registered Game authority only), `refund_match`.
Backing: `create_request`, `cancel_request`, `create_offer`, `accept_directed`, `apply_offer`, `accept_applicant`, `cancel_offer`, `expire_offer` (both take the accepted Request as an optional account, required when the Offer had one, and return it to Open).

Ledger errors surface as custom error `6100 + CoreError::code()`; program errors (`Unauthorized` = 6000, `GameNotRegistered` = 6001, `InvalidAccount` = 6003, ...) as usual.

### Trusted seam: `oracle_authority`

`Config.oracle_authority` signs `open_position` (the `PositionLocked` fact), `take_advance` (issuance price) and `apply_yield` (`YieldAccrued`). It is a single trusted key for now. The LayerZero receiver replaces it for messages and Pyth for the price; the instruction bodies do not change, only who may call them.

### Source authorities (cross-chain bridge)

`SourceAuthority` (`["source_auth", chain_byte]`) names, per source chain (Ethereum, HyperEVM), the signer allowed to report `PositionLocked` and `YieldAccrued`. Admin instructions `set_source_authority` / `remove_source_authority`; the source-signed twins `open_position_from_source` and `apply_yield_from_source` have the same bodies as `open_position` / `apply_yield`. The `tesoro_bridge` PDA is registered for both chains. `oracle_authority` still signs the same instructions unchanged and still supplies the issuance price. See `docs/cross-chain.md`.

## How Gemas move with their Sources

A Gema never loses its Source. A Pot is a list of lines `(source, amount)` per side. On a win the winner receives the loser's actual lines (minus fees) and their own entry back; the recipient's Holding of that Source is credited (own-sourced iff they own the Source, so Gemas that come home count as own again). Fees are taken in Gemas from the loser's lines. A Draw, abandonment or no-show returns every entry to its funder unchanged. Holdings of a payout's `(recipient, source)` must exist before settling; anyone can create them with `open_holding`, so a recipient cannot block a settlement.

## Multi-Source allocation rule

Deterministic and bounded.

1. **Entry draw** (join, open, and Offer reservations): `own = min(entry, own_free)` comes from own-sourced Gemas, the rest from won Gemas.
2. The caller supplies the Holdings: own class first, then won, each **strictly ascending by Source address**.
3. Each class is drained in that order: every Holding except the last used is fully drained; a Holding that would contribute nothing, out of order, or of another Account, is rejected (`NonCanonicalDraw`, `InvalidAccount`).
4. At most `MAX_ENTRY_SOURCES = 8` Holdings per entry (raised from 2 on 2026-09-30, because winners accumulate many small Sources), which bounds accounts per instruction and the payout lines at settlement. The supplied Holdings need not be every Holding: any strictly ascending subset that satisfies rule 3 is accepted, so a client skips small Holdings and sends the smallest set that covers the entry (`planEntry` in `app/src/lib/chain/ledger.ts`). When the own class must be drained completely (own Gemas < entry) every own Holding with Gemas is needed. Match and Offer accounts created before the change were sized for 2 lines per side; they keep working, but joining one with more than 2 Holdings fails at serialization and the transaction reverts (nothing is lost).
   Settlement stays bounded: each side has at most 8 lines; the loser's lines are cut at most three times by the three fees, so a settlement pays at most `2 * 8 + 3 = 19` `(recipient, source)` lines (20 for a backed win), i.e. 38-40 remaining accounts (before the Leaderboard Fee: 18 and 19).
5. **Take N Gemas from a Pot** (fees, the Player's share): lines are merged by Source, sorted ascending by Source address, and drained in that order. Platform Fee first, then Studio Fee, then the Leaderboard Fee, then (for a backed win) the Player's share from what remains.
6. **Payout order** for `settle_match` / `refund_match`: payouts are merged by `(recipient, source)` and sorted by that pair. `remaining_accounts` carry, per payout, the recipient's `TesoroAccount` then its Holding of that Source.
7. **Redeem** pays a holder `held * redeemable / outstanding` at most (pro rata to holders, including escrowed and reserved Gemas in the denominator), so redemption never exceeds what the Source has accrued.

## Compute and size (8 Holdings per side, devnet, 2026-09-30)

Worst case: both entrants draw on 8 Holdings of distinct Sources, opener wins (18 payout lines). Legacy transactions, no Address Lookup Table needed: the largest (settle) is 1,091 bytes of the 1,232 limit, so a lookup table is not built; if the cap is raised again, settle moves to a v0 transaction with a lookup table for the payout Holdings.

| Instruction | 1 Holding | 2 | 5 | 8 | Measured on |
|---|---|---|---|---|---|
| `open_match` (core) | 16,110 | 19,036 | 27,835 | 36,688 | LiteSVM |
| `join_match` (core) | 10,247 | 13,329 | 22,596 | 31,918 | LiteSVM |
| `settle_match` (core, payouts) | 29,589 (4) | 40,497 (6) | 74,091 (12) | 107,496 (18) | LiteSVM |
| Block Puzzle `open_match + open_session` tx | | | | 78,679 | devnet |
| Block Puzzle `join_match + join_session` tx | | | | 74,747 | devnet |
| Block Puzzle `settle` tx (CPI, 18 payouts; core part 100,506) | | | | 135,734 (1,091 bytes) | devnet |

Settlement is the binding number: 136k of the 150k target and well under 200k, so 8 is the cap. Proof: `docs/deployments.md`.

## Money rules as built

- **Advance**: 80% of the projected yield (100% minus the Yield Fee), `principal * rate_bps * months * (10_000 - yield_fee_bps) / (12 * 10_000 * 10_000)` in source units, converted at the issuance price, floored to whole Gemas. One open Advance per Position; a new one only when Debt is zero. Horizon 1 to 12.
- **Debt**: outstanding Gemas of the Position's open Source, in Gemas (source-unit view via `debt_units`). `YieldAccrued(cumulative)` repays it automatically; yield beyond the Advance goes to the owner as `free_yield`.
- **Principal never reduces Debt**: no ledger function reads Principal after sizing an Advance, and the only paths that lower Debt are `apply_yield` and `return_own` (property-tested).
- **Return**: only the Position owner, only their own-sourced Gemas, only up to Debt.
- **Yield Fee**: 20% (`yield_fee_bps = 2000`, cap 5000) of every yield increment goes to the Treasury before it counts toward Debt, redemption or free yield. Never on Principal.
- **Instant Redeem**: won, free Gemas only (`NotWonGemas` otherwise), and only the holding's pending part: at most `free - redeemable_for(free)` (`ExceedsPending` otherwise; the app redeems the landed part in full first, in the same transaction); payout `floor(units * (10_000 - instant_fee_bps) / 10_000)` with `instant_fee_bps = 3500`, paid by the Treasury (`TreasuryShort`, 6017, when it holds less). The Gemas move to the Treasury Account's Holding of the same Source; Source counts are unchanged.
- **Redeem**: only up to accrued yield; `redeemed_units` versus `yield_units` is the redeemed-versus-pending split per Source.
- **Match**: entries 500 / 1,000 / 2,500; settle once (`Open`/`Active` to `Settled`/`Refunded`); fees `platform_bps + studio_bps` of the Pot (placeholders 200 + 300), snapshotted when the Match opens, plus the **Leaderboard Fee** `Config.leaderboard_bps` (100), read from Config when the Match settles (all three capped at 5,000 together; see "Leaderboard" below). Refund by the Game authority any time, by the opener of an unjoined Match, or by anyone after 1h.
- **Backing**: Request (Player, game, entry); Offer (Backer, game, entry, Player share of surplus in bps; directed at a Request or public with up to 8 applicants). Requests and Offers live 24h; an accepted Offer has 24h to be used. The Backer's Gemas are reserved on create. Win: Backer's entry first, then the Player's share of the surplus (after fees), the rest to the Backer. Loss: the Backer loses the entry, nothing more. No revoke after the Match starts (`Consumed`). The Player is never debited and only ever receives won Gemas.

## Game programs (CPI settlement)

A Game registers `(game program id, authority, studio_bps)`. `authority` may be a PDA of the Game program: `settle_match` and `extend_match_deadline` only require that the `game_authority` signer equals it, and a PDA signs by `invoke_signed` from the Game program. No change was needed for that. Block Puzzle (`docs/games/block-puzzle.md`) does exactly this with `PDA(["authority"], block_puzzle)`.

One change was strictly necessary: **`extend_match_deadline(new_deadline)`**. `join` sets the refund deadline to 1 h and anyone may refund an Active Match after it, which would let the losing Player of an async Game refund before the result is settled. The Game authority may push an Active, unexpired Match's deadline later (never earlier, at most 7 days from now, `MAX_MATCH_EXTENSION_SECS`); errors `InvalidDeadline`, `InvalidStatus`, `Expired`, `Unauthorized`. Covered by `only_the_game_authority_extends_a_deadline_forward_and_within_the_cap`. `refund_match` stays the liveness fallback: block_puzzle sets the deadline to its submission deadline plus 1 h, so its own settlement always comes first.

## Leaderboard (ADR 0006)

- **Config** gained `leaderboard_bps: u16` and `pool_account: Pubkey` after `games`. A Config created before them decodes with both zero (its unused tail is zeroed) and charges nothing. `init_leaderboard(bps)` (admin) reallocs it, creates the pool and sets the fee; it can be called again to change the fee. `update_config` and `register_game` keep platform + studio + leaderboard within the 5,000 bps cap.
- **Pool**: `TesoroAccount` at `["account", pda(["leaderboard"])]`. Its Holdings are opened with `open_holding` like any Account's. Every won Match credits it through the normal payout path (one more `(recipient, source)` line in `settle_match`'s remaining accounts, sorted with the rest). A Game's client must read `Config.leaderboard_bps` and `pool_account` to build the same payouts (`computePayouts(m, result, lb)` in the TS ports). Draws and refunds pay nothing.
- **Event** `MatchWon { match_id, game, entry, player, funder, points, pool_fee, season, ts }` on every decisive `settle_match`. `points = entry / 100`, to the Player who played.
- **Seasons**: `season = (ts - 1_791_158_400) / 604_800 + 1` (Monday 2026-10-05 00:00 UTC is Season 1). `ledger/season.rs`, mirrored in `app/src/lib/chain/season.ts`.
- **`record_season(number, points[])`** (admin or `oracle_authority`; the Players' `TesoroAccount`s as remaining accounts, in rank order): the season must have ended, ranks must be distinct, with points above zero, non-increasing, at most ten. Creates `Season` at `["season", number u32 LE]` holding the ranking and each prize, `pool_total * PRIZE_BPS[i] / 10_000` floored (25, 18, 13, 10, 8, 7, 6, 5, 4, 4%). Once per season (the account is `init`). Unfilled ranks are not paid, so their shares stay in the pool.
- **`pay_season_rank(rank)`** (same authority): pays rank `rank` once (`paid_mask`). Remaining accounts: `n` pool Holdings then the winner's `n` Holdings of the same Sources. The pool's Holdings must be non-empty, strictly ascending by Source, each drained but the last (`plan_prize`); Gemas keep their Source. A rank paid with a zero amount sends no Holdings.
- **Trust**: the ranking comes from the keeper (recomputed from `MatchWon` events / pool history); everything else is enforced here. See ADR 0006.

## Open questions

Conservative readings chosen where CONTEXT.md is silent. Raise before the build depends on them.

1. **Surplus base.** "The remainder is split by the Offer" is read as the remainder after Platform and Studio Fees. Alternative: split before fees.
2. **Who pays fees.** Fees come out of the loser's lines, so a winner always receives their own entry whole. Alternative: pro rata from the whole Pot.
3. **Entry cap.** An entry draws from at most 8 Holdings (was 2, which stranded Accounts spread over 3+ Sources). Beyond 8 the Player redeems small balances; a consolidation instruction is still not built.
4. **Fee rounding.** Fees are floored, so the winner gets the dust.
5. **Debt in source units.** Debt is stored in Gemas and derived in source units, so it is stable against price; the rounding of partial yield (floor when crediting, ceil when repaying) can leave sub-Gema dust on a Source.
6. **Backed Player's Match timeout.** The 1h no-show timer, the 24h Request/Offer TTL and the 24h use-by window after acceptance are placeholders.
7. **Challenge and Queue.** Pairing (Queue, Challenge links) is not modelled: `open_match` opens for anyone; the Game or keeper decides who joins.
8. **Redeem is a claim event.** `redeem` records the claim and emits `Redeemed`; the actual `PayYield` transfer and its failure handling are T2/T3.
9. **`take_advance` needs oracle and owner co-signing.** Fine for the demo; the message path will replace the oracle signature.
10. **Unlock.** Callable by the owner when no Advance is open; the `Unlock` message is not sent yet. An Unlocked Position takes no new Advance.
11. **Free yield.** Yield beyond an Advance is tracked (`free_yield`, `claim_free_yield`) but not paid out.

## Left for T1

Cross-chain receiver wiring, Pyth price, Game-program CPI (only the authority key is checked today), a Queue/Challenge layer, consolidation, fuzzing beyond the model-based property tests, CU profiling, and the security audit pass.

## Solana-native Positions (shared simSOL custody, yield computed; ADR 0010)

A native Position holds real `sim_lst` simSOL in one program-controlled vault shared by all native Positions; no oracle opens it, credits its yield or unlocks it. The yield is SIMULATED and computed on the spot (`ledger/yield_math.rs`, `docs/yield-model.md`): there is no crank, nothing records yield, and simSOL is minted only at the moment yield is paid out. 1 simulated month = 10 min. **Fresh start:** these layouts replace the per-Position custody of the earlier model; old accounts are not read (ticket 07 closes them).

| On chain | Seeds | Notes |
|---|---|---|
| `NativeCustody` (singleton) | `["native"]` | `pool`, `mint`, `vault`, and the pool totals `principal`, `fee_weight`, `fee_weight_time`, `realised_fee` (u128), `open_positions`; changed only by open and unlock |
| Shared vault (SPL token account) | `["native_vault"]` | authority = the custody PDA; holds the Principal shares of every Locked native Position |
| `PositionState` | `["position", 0, id]` | `ledger::Position` gained `opened_at`, `applied_net`, `custody_shares`, `yield_fee_bps` (appended) |
| `PriceFeed` | `["price", SIM_SOL_MINT]` | SOL/USD in micro-USD, written by `oracle_authority` (`set_price`) |

A Position is native iff `source_chain == Solana` and `source_asset == SIM_SOL_MINT`. Its id is `sha256("native" || owner || nonce_le)`. The oracle's `open_position` refuses that asset, `apply_yield` and `claim_free_yield` refuse native Positions. EVM Positions are untouched (`opened_at`, `applied_net`, `custody_shares` stay 0 and `apply_yield_from_source` still stores `yield_units`).

**Derived state.** `Accrued Yield = Principal x (growth - 1)`, `growth = 1 + rate_bps x (now - opened_at) x pool.speedup / (10,000 x year)`, minus the Yield Fee fixed on the Position at open (`position.yield_fee_bps`, copied from the Treasury): `ledger::native::position_accrued`. The open Advance counts `min(net - applied_net, units owed)` as its `yield_units` (`source_view`); a closed Source keeps the final value stored when it closed. `applied_net` is the checkpoint: net yield already consumed by closed Sources or banked into `free_yield`. A Source closes (Debt zero) in the next `take_native_advance`, in `unlock`, or in a `return_own` that clears Debt; the yield beyond it is banked as free yield and the checkpoint moves to now. Until then a repaid Advance simply reads Debt 0.

Instructions:

- `init_native_custody()`: admin, once. Creates the custody and the shared vault, pinned to the canonical sim_lst Pool.
- `set_price(price_micro_usd)`: oracle only (unchanged).
- `open_native_position(nonce, lst_amount)`: accounts `owner_authority, owner_account, pool, mint, owner_token, position, treasury, custody, vault, token_program, system_program`. `yield_fee_bps` is copied from the Treasury onto the Position (like `rate_bps`) and never changes. Principal in SOL at the (flat) rate, `rate_bps` = pool APY, `opened_at` = now, `custody_shares` = `lst_amount`; adds the Position to the pool totals.
- `take_native_advance(horizon_months)`: accounts `owner_authority, owner_account, position, price_feed, pool, prev_source (optional), source, holding, system_program`. If the Position has an open Advance, `prev_source` must be that Source: its Debt must be zero (else `AdvanceAlreadyOpen`; missing -> `SourceRequired`), and it is closed here. Idle yield is banked as free yield and the checkpoint moves to now, so yield from before the new Advance never repays it.
- `extend_native_advance(extra_months)`: as before, with `pool` instead of `treasury` (the fee is the Position's own). Debt is derived (`AdvanceRepaid` when zero); the Source is stored at its derived `yield_units`.
- `set_extend_limit(months)`: unchanged.
- `redeem(amount)`: native `remaining_accounts` = `[pool, holder_token, mint, yield_config, yield_authority, sim_lst_program, token_program]`. Computes the Source now, redeems, and mints exactly the SOL value of the Gemas to the holder through `sim_lst::mint_yield` (signed by the `["yield"]` PDA). Principal is never touched.
- `unlock()`: native `remaining_accounts` = `[custody, vault, pool, owner_token, mint, yield_config, yield_authority, sim_lst_program, token_program]` and, when the Position has an open Advance, that Source last (writable). Debt is computed here and must be zero (`DebtOutstanding`); Principal returns from the shared vault (`custody_shares`), the free yield (`free_yield - free_yield_claimed`) is minted, the Position leaves the pool totals and its Yield Fee is booked into `realised_fee`.
- `return_own(amount)`: native `remaining_accounts` = `[pool]`.
- `instant_redeem` / `redeem_treasury`: as in the Treasury section below, with the Source derived at the clock. `redeem_treasury` `remaining_accounts` = `[pool, treasury_vault, mint, yield_config, yield_authority, sim_lst_program, token_program]`; the redeem yield is minted into the treasury vault.

Removed: `accrue_native_yield`, `sweep_native_surplus` (the vault holds Principal only and yield is minted when paid, so no surplus can build up), `migrate_native_custody`, events `YieldFeeTaken` and `NativeCustodyMigrated`. `NativePayout.kind`: 0 redeem (minted), 1 unlock Principal (vault), 2 unlock free yield (minted).

**Treasury claim.** `PoolTotals::earned_fee(now, speedup)` over the stored totals, weighted by each Position's own `Principal x rate_bps x fee_bps` (`fee_weight`, `fee_weight_time`), is conservative: at most the sum of the per-Position fees and at least that sum minus `2N + 2` (N = Locked Positions). The fee is minted lazily, only when the Treasury pays out: see **Treasury balance** below.

The Yield Fee and APY are fixed per Position at open, so a Treasury fee change applies only to Positions opened afterwards and the claim stays at most the sum of per-Position fees (test `a_fee_change_never_applies_backwards`). `speedup` is the one value read live from the canonical sim_lst Pool (a devnet constant by founder decision); changing it bends every open curve. `instant_redeem` still reads the Instant Redeem fee live.

Errors appended: `SourceRequired` (6018), `CompanyNotSet` (6019).

Tests: `ledger/native.rs` (property test over random Time/Advance/Redeem/ReturnOwn/Unlock sequences: minted never exceeds net Accrued Yield; closed Sources fully covered), `tests/native.rs` (LiteSVM with the real sim_lst: open -> Advance -> warp -> Redeem -> Unlock with no crank, second Advance after Debt 0, Extend with limits, Instant Redeem, pool totals within the proven bound, validation and a randomized on-chain sequence).

### How the app calls it

Flow: `create_account` (once) -> sim_lst `faucet` -> one tx of `open_native_position(nonce, lst)` + `take_native_advance(months)` (source index = `advances`, no `prev_source`) -> read Debt with `position_accrued` + `source_view` (no keeper) -> `redeem` with the eight remaining accounts -> `unlock` with the ten (+ Source) remaining accounts. Keep the price feed fresh (`set_price` from the keeper, < 24 h old). Oracle Positions keep working with no remaining accounts for `redeem` and `unlock`.

## Yield Fee, Instant Redeem and the Treasury (2026-10-12, ADR 0007; balance by math, ADR 0010)

**Treasury balance** (SOL units, O(1)): `earned_fee(now, speedup) - fee_minted` (the Yield Fee earned by native Positions, never minted until paid) plus the simSOL in the treasury vault valued at the rate (funding and `redeem_treasury` refills land in the vault). `pay_from_treasury` pays Instant Redeem and withdrawals the same way: vault first, the shortfall shares minted by `sim_lst::mint_yield` straight to the destination, `fee_minted += ceil(value of minted shares)`, refused (`TreasuryShort`) when that would pass `earned_fee`. So `fee_minted <= earned_fee` always, and `earned_fee` itself is at most the sum of the per-Position fees (conservative). The Treasury never pays more than fee earned + simSOL it received.

| On chain | Seeds | Notes |
|---|---|---|
| `Treasury` | `["treasury"]` | `yield_fee_bps`, `instant_fee_bps`, `account`, `vault`, `fee_minted` (cumulative SOL units of earned Yield Fee already minted out as simSOL), `instant_units` (paid by SOL Instant Redeem), `funded_shares`, `withdrawn_units` (cumulative SOL units withdrawn), `company` (wallet `withdraw_treasury` pays; default = unset) |
| Treasury Account | `["account", treasury_pda]` | a `TesoroAccount` with the Treasury PDA as authority: holds the Gemas it bought; nobody can sign for it |
| Treasury vault (simSOL token account) | `["treasury_vault"]` | authority = the Treasury PDA |

Instructions (new):

- `init_treasury(yield_fee_bps, instant_fee_bps)` (admin; calling it again changes the rates). The Instant Redeem Fee is 2,500 bps (Players get 75%); `instant_fee_bps` is the only Instant Redeem rate: EVM vaults hold no rate of their own, the payout of an EVM-Sourced Instant Redeem is computed here and relayed by the bridge. The app reads the rate from the `Treasury` account, with 2,500 as its fallback (`DEFAULT_INSTANT_FEE_BPS`). Accounts: admin, config, treasury, treasury_account, mint (`SIM_SOL_MINT`), treasury_vault, token program, system program.
- `fund_treasury(shares)` (admin): moves simSOL from the admin into the treasury vault. Event `TreasuryFunded`.
- `instant_redeem(amount)` (native SOL Sources): holder_authority, holder_account, position, source, holding, treasury, treasury_account, treasury_holding (created for the holder if missing), treasury_vault, holder_token, pool, custody (`["native"]`), mint, yield_config (sim_lst `["yield_config"]`), yield_authority (core `["yield"]`), sim_lst_program, token program, system program. Pays simSOL `floor(payout * 1e9 / rate)` in the same transaction from the Treasury balance (vault first, then minted out of the unminted Yield Fee); `TreasuryShort` beyond it. Event `InstantRedeemed`.
- `set_treasury_company(company)` (admin): sets the wallet `withdraw_treasury` pays. Accounts: admin, config, treasury.
- `withdraw_treasury(amount)` (admin; `amount` in SOL units): pays the company wallet's simSOL account `floor(amount * 1e9 / rate)` the same way as Instant Redeem. Accounts: admin, config, treasury, treasury_vault, company_token (simSOL account owned by `treasury.company`), pool, custody, mint, yield_config, yield_authority, sim_lst_program, token program. Errors: `Unauthorized` (not admin), `CompanyNotSet` (6019, appended after `SourceRequired`), `InvalidAccount` (destination not owned by the company wallet), `TreasuryShort` (beyond the balance). Event `TreasuryWithdrawn { company, units, shares, minted_units }`.
- `instant_redeem_from_source(amount) -> u64` (EVM Sources; holder and the chain's source authority sign): same ledger step, no payout; returns the payout in source units and the bridge records and caps it.
- `redeem_treasury(amount)` (native SOL, permissionless crank): the Treasury Account redeems its Holding under the normal Redeem rules; the simSOL goes into the treasury vault. `redeem_treasury_from_source(amount)` is the EVM twin, signed by the source authority.

Changed account lists (order matters for clients):

- (Removed in ADR 0010) `accrue_native_yield` used to mint 80% of the yield into the Position vault and 20% into the treasury vault.
- `take_advance`: `treasury` right after `config`. `take_native_advance`: `treasury` right after `price_feed`.

Errors appended: `TreasuryShort` (6017); ledger `NotWonGemas`, `ExceedsPending` (2026-10-13), `AdvanceRepaid` (Extend); `ExtendCoolingDown`, `ExtendLimitReached`, `InvalidExtendLimit` (Extend limits).

`extend_native_advance` also changed its account list (ADR 0009): `extend_limit` and `system_program` are appended, and `owner_authority` is writable.
