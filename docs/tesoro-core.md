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
Position: `open_position` (oracle), `open_native_position`, `take_native_advance`, `extend_native_advance`, `accrue_native_yield`, `sweep_native_surplus`, `set_price` (see Solana-native Positions below), `take_advance` (owner picks the Horizon, oracle supplies the price, both sign), `apply_yield` (oracle; idempotent by `seq`), `return_own`, `redeem` (refuses EVM-sourced Sources: they use `redeem_from_source`, co-signed by the chain's source authority, called by the bridge's `redeem_to_evm`), `claim_free_yield`, `unlock`.
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

One change was strictly necessary: **`extend_match_deadline(new_deadline)`**. `join` sets the refund deadline to 1 h and anyone may refund an Active Match after it, which would let the losing Player of an async Game refund before the result is settled. The Game authority may push an Open or Active, unexpired Match's deadline later (an Open Match: block_puzzle's 24 h Queue window) (never earlier, at most 7 days from now, `MAX_MATCH_EXTENSION_SECS`); errors `InvalidDeadline`, `InvalidStatus`, `Expired`, `Unauthorized`. Covered by `only_the_game_authority_extends_a_deadline_forward_and_within_the_cap`. `refund_match` stays the liveness fallback: block_puzzle sets the deadline to its submission deadline plus 1 h, so its own settlement always comes first.

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

## Solana-native Positions (simSOL custody)

Added additively (no existing account layout, seed or instruction signature changed). A native Position holds real `sim_lst` simSOL in a program-controlled vault; no oracle opens it, credits its yield or unlocks it. The yield is SIMULATED and per Position (`docs/yield-model.md`, ADR 0005): each Position earns `principal * apy * simulated_time` and `accrue_native_yield` mints it into the vault through `sim_lst::mint_yield`; the sim_lst rate is constant. 1 simulated month = 10 min.

| On chain | Seeds | Notes |
|---|---|---|
| `NativeCustody` | `["native", position]` | pool, mint, vault, `rate_at_open`, `deposited_shares`, `redeemed_units` (SOL paid to holders) |
| Vault (SPL token account) | `["native_vault", position]` | authority = the custody PDA; the only place Principal shares live |
| `PriceFeed` | `["price", SIM_SOL_MINT]` | SOL/USD in micro-USD, written by `oracle_authority` (`set_price`) |

A Position is native iff `source_chain == Solana` and `source_asset == SIM_SOL_MINT` (`3Q2VRPmd...`, the sim_lst mint PDA). Its id is `sha256("native" || owner || nonce_le)`, so the seeds are `["position", 0, id]`. The oracle's `open_position` refuses that asset, `apply_yield` and `claim_free_yield` refuse native Positions.

Instructions (all new, plus native branches in `redeem` and `unlock`):

- `set_price(price_micro_usd)`: oracle only. **Price seam decision:** the issuance price is an on-chain `PriceFeed` account (max age 24 h) rather than an oracle co-signature, so the owner signs alone and the app needs no server key. Pyth later replaces the feed's source; `take_native_advance` does not change.
- `open_native_position(nonce, lst_amount)`: owner deposits simSOL into the vault. Validates the pool (sim_lst-owned, canonical `["pool"]` PDA, `pool.mint == SIM_SOL_MINT`) and the mint. Principal is `floor(shares * rate / 1e9)` SOL lamports, `rate_bps` is the pool APY at open. The Horizon is chosen by the follow-up instruction; send both in one transaction.
- `take_native_advance(horizon_months)`: owner only, priced by the feed. Same ledger rules as `take_advance` (which still works on native Positions with an oracle price).
- `extend_native_advance(extra_months)`: owner only (ADR 0008). Extends the Position's open Advance when its Debt is above zero and the total Horizon stays at most 12 months; mints `size(horizon + extra) - size(horizon)` Gemas (Yield Fee netted, the Source's stored price) to the owner's existing Holding of that Source and emits `AdvanceExtended`. Accounts: `owner_authority` (writable, pays), `owner_account, position, treasury, source, holding, extend_limit, system_program`. Counts the months against the owner's Extend Limit first (ADR 0009). Refused with `NoOpenAdvance`, `SourceMismatch`, `AdvanceRepaid` (Debt 0), `InvalidHorizon` (zero months or over 12), `PositionNotLocked`, `ExtendCoolingDown` (under 24 h since the last Extend), `ExtendLimitReached`.
- `set_extend_limit(months)`: owner only (ADR 0009). Creates the `ExtendLimit` account (`["extend_limit", account]`, the owner pays) on first use. Refuses more than 11 (`InvalidExtendLimit`). A lower limit applies at once; a higher one is pending and applies 24 h later. Emits `ExtendLimitSet`. Accounts: `owner_authority, owner_account, extend_limit, system_program`.
- `set_entry_limit(gemas)`: owner only (ADR 0011, Protections). Creates the `Protections` account (`["protections", account]`, the owner pays) on first use. `gemas` is the most the owner may enter in a fixed 7-day period that starts at their first counted entry after the last period ended; 0 means no limit. A lower limit applies at once; a higher one, or 0, is pending and applies 24 h later. Emits `EntryLimitSet`. Accounts: `owner_authority, owner_account, protections, system_program`.
- **Entry Limit checks:** `open_match`, `join_match` (the entrant) and `create_offer` (the Backer, when the entry is reserved) take `protections` (the PDA address, writable, may be empty = no Protection set) after the Account and count the entry; over the limit is `EntryLimitReached`. `open_match_backed` and `join_match_backed` count nobody (the Backer was counted at `create_offer`, the Player risks nothing of their own). Refunds, cancelled and expired Offers do not give room back (fixed-period accounting). Ticket 23 (Break, Self-Exclusion) extends the same account: `Protections` is `entry_limit`, `break_until`, `self_exclusion_until`, then 48 reserved bytes, so no reallocation is needed.
- `accrue_native_yield()`: permissionless crank. While Locked it first mints the yield earned since `custody.last_accrual_ts`, `floor(principal * rate_bps * dt * speedup / (10_000 * 31_536_000))` SOL units converted to shares at the (constant) pool rate, into the vault by CPI to `sim_lst::mint_yield` (signed by the `["yield"]` PDA, which sim_lst records as the one yield authority; the sim_lst program id, its `["yield_config"]` PDA, the pool and the mint are all checked); under one share it mints nothing and keeps `last_accrual_ts`, so the time carries. Nothing is minted after Unlock. Then cumulative accrued yield in SOL `= floor(V * r / 1e9) + paid - Principal` (V = `tracked_shares`, r = the pool rate, paid = SOL already paid to redeemers); if it exceeds the applied cumulative it is applied exactly like `YieldAccrued` (Debt repaid first, the rest is free yield). Idempotent within one second and monotonic. Accounts: position, custody, vault, pool, mint, yield_config, yield_authority, sim_lst program, token program, and the open Advance's Source as the optional last account.
- `sweep_native_surplus()`: owner, after Unlock; releases whatever the vault holds beyond the reserve at the current rate (the rate is constant, so the reserve only shrinks as holders redeem).

**Vault invariant.** While Locked the vault holds at least `ceil((Principal + owed) * 1e9 / rate)` shares, where `owed = cumulative_yield - free_yield - redeemed_units` is the yield applied to Sources and not yet paid to holders. After Unlock only `owed` is reserved, so yield owed to holders who have not redeemed stays in the vault, valued at the pool rate, until they redeem. Every payout re-checks this (`VaultShortfall`). Free yield and un-cranked yield are not reserved: they return to the owner at Unlock. `claim_free_yield` is refused for native Positions for that reason. Rounding leaves at most a share or two of dust reserved.

Errors appended: `InvalidPool` 6007, `InvalidMint` 6008, `NativePosition` 6009, `NotNativePosition` 6010, `StalePrice` 6011; ledger `VaultShortfall`, `ZeroShares`.

Tests: `ledger/native.rs` (model property test over random Time/Advance/Crank/Redeem/ReturnOwn/Unlock sequences), `tests/native.rs` (LiteSVM with the real sim_lst, incl. a randomized on-chain sequence test reading the invariants back: Principal shares leave only via unlock, payouts <= accrued, vault covers Principal + owed, crank idempotent, wrong pool / mint / owner rejected). TS helper: `scripts/native-position`.

### How the app calls it

All with `TESORO_CORE_ID`, discriminators `sha256("global:<name>")[..8]` or the regenerated IDL (`pnpm build:programs`; the IDL gains `NativeCustody`, `PriceFeed` and a `Pool` type from sim_lst). Flow: `create_account` (once) -> sim_lst `faucet` -> one tx of `open_native_position(nonce, lst)` + `take_native_advance(months)` (source index = `advances` = 0) -> anyone calls `accrue_native_yield` (keeper or the app on view) -> `redeem` with the five remaining accounts -> `unlock` with the five remaining accounts -> optionally `sweep_native_surplus`. Keep the price feed fresh (`set_price` from the keeper, < 24 h old). Old IDL clients keep working for oracle Positions; `redeem` and `unlock` for those need no remaining accounts.

## Per-Position yield migration (2026-10-03)

`NativeCustody` gains `last_accrual_ts: i64` after `tracked_shares` (`SPACE` 8 bytes larger). `migrate_native_custody` (permissionless) extends a custody in either older layout (original 194 bytes, or with `tracked_shares`) and sets `last_accrual_ts = now`: the Position keeps the yield the old rate model already gave it (the sim_lst rate is checkpointed at its then-current value), no back pay, and earns at `principal * apy * speedup / year` from the migration. An unmigrated custody cannot be read by `accrue_native_yield`, `redeem`, `unlock` or `sweep` until it is migrated. `open_advance` was then `principal * rate_bps * months / 12` (since 2026-10-12 it is 80% of that, see below), repaid in exactly `months * 10` minutes at speedup 4,380.

## Yield Fee, Instant Redeem and the Treasury (2026-10-12, ADR 0007)

| On chain | Seeds | Notes |
|---|---|---|
| `Treasury` | `["treasury"]` | `yield_fee_bps`, `instant_fee_bps`, `account`, `vault`, `fee_units` (cumulative SOL units minted as Yield Fee), `instant_units` (paid by SOL Instant Redeem), `funded_shares` |
| Treasury Account | `["account", treasury_pda]` | a `TesoroAccount` with the Treasury PDA as authority: holds the Gemas it bought; nobody can sign for it |
| Treasury vault (simSOL token account) | `["treasury_vault"]` | authority = the Treasury PDA |

Instructions (new):

- `init_treasury(yield_fee_bps, instant_fee_bps)` (admin; calling it again changes the rates). The Instant Redeem Fee is 2,500 bps (Players get 75%); `instant_fee_bps` is the only Instant Redeem rate: EVM vaults hold no rate of their own, the payout of an EVM-Sourced Instant Redeem is computed here and relayed by the bridge. The app reads the rate from the `Treasury` account, with 2,500 as its fallback (`DEFAULT_INSTANT_FEE_BPS`). Accounts: admin, config, treasury, treasury_account, mint (`SIM_SOL_MINT`), treasury_vault, token program, system program.
- `fund_treasury(shares)` (admin): moves simSOL from the admin into the treasury vault. Event `TreasuryFunded`.
- `instant_redeem(amount)` (native SOL Sources): holder_authority, holder_account, position, source, holding, treasury, treasury_account, treasury_holding (created for the holder if missing), treasury_vault, holder_token, pool, token program, system program. Pays simSOL `floor(payout * 1e9 / rate)` from the treasury vault in the same transaction. Event `InstantRedeemed`.
- `instant_redeem_from_source(amount) -> u64` (EVM Sources; holder and the chain's source authority sign): same ledger step, no payout; returns the payout in source units and the bridge records and caps it.
- `redeem_treasury(amount)` (native SOL, permissionless crank): the Treasury Account redeems its Holding under the normal Redeem rules; the simSOL goes into the treasury vault. `redeem_treasury_from_source(amount)` is the EVM twin, signed by the source authority.

Changed account lists (order matters for clients):

- `accrue_native_yield`: `position, custody, vault, pool, mint, yield_config, yield_authority, sim_lst_program, token_program, treasury, treasury_vault`, then the optional open Source. It mints 80% of the yield into the Position vault and 20% into the treasury vault (event `YieldFeeTaken`).
- `take_advance`: `treasury` right after `config`. `take_native_advance`: `treasury` right after `price_feed`.

Errors appended: `TreasuryShort` (6017); ledger `NotWonGemas`, `ExceedsPending` (2026-10-13), `AdvanceRepaid` (Extend); `ExtendCoolingDown`, `ExtendLimitReached`, `InvalidExtendLimit` (Extend limits).

`extend_native_advance` also changed its account list (ADR 0009): `extend_limit` and `system_program` are appended, and `owner_authority` is writable.
