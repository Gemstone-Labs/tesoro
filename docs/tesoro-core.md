# tesoro_core

The money rules of Tesoro (CONTEXT.md, ADR 0001). Two layers:

- `programs/tesoro_core/src/ledger/` is the pure accounting core: plain structs and functions, no clocks, accounts or syscalls (Anchor is used only for the Borsh derive). Every mutating function validates before it mutates. Property tests live in `ledger/tests.rs`.
- The rest of the crate is thin Anchor instructions that load accounts, validate them, call the ledger and store the result.

Read "Economy upgrade (ADR 0013)" below first: it replaces Holdings, the Multi-Source allocation rule, pro rata Redeem, automatic Instant Redeem and the Pool drain described in the older sections, which are kept only where they still hold. Two seams are explicit: `Config.oracle_authority` (see below) and the `Redeemed` / `PositionUnlocked` events (the `PayYield` and `Unlock` message seams).

## Units

A Source fixes its rate at issuance as `unit_num / unit_den` source-asset base units per Gema, with `unit_num = 10^(decimals+4)` and `unit_den = price` (USD per whole asset, micro-USD). One Gema is $0.01 = 10,000 micro-USD. The USD price is never consulted again. Debt is kept in Gemas and converted to source-asset units on demand (rounded up when repaying, down when paying out, so accrued yield is never over-spent).

Per Source: `issued`, `returned` (cancelled by the owner), `redeemed`, `yield_units` (accrued yield applied). `covered = min(issued - returned, floor(yield_units / rate))`; `debt = issued - returned - covered`; `outstanding = issued - returned - redeemed` (held or escrowed); `redeemable = covered - redeemed`. Conservation: `held + escrowed == outstanding`, hence `outstanding + redeemed + returned == issued`.

## Accounts (PDAs)

| On chain | CONTEXT term | Seeds |
|---|---|---|
| `Config` | (fees, oracle; the old Game list is unused) | `["config"]` |
| `GameRecord` | one per Game: settle authority, Studio terms, pending change, listing | `["game", program_id]` |
| `PairState` | Matches one opener-to-joiner pair started today | `["pair", opener Account, joiner Account]` |
| `TesoroAccount` | Account | `["account", authority]` |
| `PositionState` | Position | `["position", chain_byte, position_id]` |
| `SourceState` | Source (one per Advance) | `["source", position, index_le]` |
| `HoldingState` | Gemas held per (Account, Source). Being removed (ticket 08z); kept only for the devnet wipe | `["holding", account, source]` |
| Basket | All an Account's Gemas, one sorted list of lines | `["basket", account]` |
| Spill | Credits that did not fit the basket; same line layout, playable at once | `["spill", account]` |
| Sponsor | Core-owned rent sponsor: relayer key, pause, per-Account and total caps, and the cap on rent it can never get back (`accounts_cap`) | `["sponsor"]` |
| Source book | A Source's classes, coverage counters and fee counters | `["book", source]` |
| Checkpoint page | Append-only history of closed segments, per Source and class | `["ckpt", source, class, page_no_le]` |
| `EconomyConfig` | Season keeper, fill keeper, Pool share, prize routes | `["economy"]` |
| Instant Redeem order | One Instant Redeem order | `["instant", account, nonce_le]` |
| Prize Source | The prize Gemas of one Season on one route | `["prize", route, season_le]` |
| Settlement receipt | Written when a Match enters Settling or Refunding | `["settled", match]` |
| `MatchState` | Match (and its Pot, in escrow as lines) | `["match", id_le]` |
| `RequestState` | Request | `["request", player_account, nonce_le]` |
| `OfferState` | Offer (and the reservation) | `["offer", backer_account, nonce_le]` |
| `InviteGate` | Invite gate setting (ADR 0012) | `["invite_gate"]` |

`Account` is `TesoroAccount` on chain because `Account` is Anchor's wrapper type. Every account stores its canonical bump. Ledger identities are PDA addresses: an Account key is its `TesoroAccount` address, a Source key is its `SourceState` address.

## Instructions

Config: `initialize_config`, `update_config` (admin). Game registry: `register_game`, `propose_game_change`, `apply_game_change`, `cancel_game_change` (signed by the control of the Game program, see below), `list_game` (admin). Invite gate (admin): `set_invite_gate(required, key)`. Identity: `create_account` (takes the `invite_gate` PDA; while the gate is required the Invite `key` must also sign, passed as the first remaining account, else `InviteRequired`; no gate account means off), `set_evm_address`, `init_stores` (creates the basket and spill of an Account that has none), `open_holding` (Holdings only; removed with ticket 08z).
Position: `open_position` (oracle), `open_native_position`, `take_native_advance`, `extend_native_advance`, `init_native_custody`, `set_price` (see Solana-native Positions below), `take_advance` (owner picks the Horizon, oracle supplies the price, both sign), `apply_yield` (oracle; idempotent by `seq`), `return_own(line, amount)`, `redeem(line, amount)` (a line is `LineRef{side, due_at, class, tranche}`; EVM-sourced Sources use `redeem_from_source`, co-signed by the chain's source authority, called by the bridge's `redeem_to_evm`), `claim_free_yield`, `unlock`. Protections (owner): `set_entry_limit`, `set_break`, `set_self_exclusion`. On-chain prices: `set_onchain_price` (admin), `take_native_advance_onchain`, `take_advance_onchain` (see ADR 0012).
Match: `open_match`, `join_match`, `open_match_backed`, `join_match_backed`, `settle_match` (registered Game authority only), `extend_match_deadline` (registered Game authority only, capped at 7 days after open), `refund_match`. These still run on Holdings until ticket 09 moves them onto baskets, Tickets and the Settling/Refunding states described below.
Economy upgrade: baskets (`grow_store`, `grow_store_sponsored`, `shrink_store`, `claim_spill`, `init_source_book`, `init_ckpt_page`, `init_ckpt_page_sponsored`), sponsor (`init_sponsor`, `set_sponsor`, `set_accounts_cap`), economy (`set_economy`, `set_prize_share`, `set_prize_escrow`), Instant Redeem (`request_instant_redeem`, `fill_instant_redeem`, `fill_instant_redeem_from_source`, `cancel_instant_redeem`, `expire_instant_redeem`), prizes and Seasons (`harvest`, `fund_season_prize_native`, `fund_season_prize_stake`, `redeem_prize`, `record_season`, `pay_season_rank`, `void_season_rank`, `close_season`), listing (`list_game`, `refresh_listing`, `close_pair`).
Backing: `create_request`, `cancel_request`, `create_offer` (takes the Request it answers and copies its game and entry), `accept_offer`, `cancel_offer`, `expire_offer` (both take the Request as an optional account, required when the Offer was accepted, and return it to Open).

Ledger errors surface as custom error `6100 + CoreError::code()`; program errors (`Unauthorized` = 6000, `GameNotRegistered` = 6001, `InvalidAccount` = 6003, ...) as usual.

### Trusted seam: `oracle_authority`

`Config.oracle_authority` signs `open_position` (the `PositionLocked` fact), `take_advance` (issuance price) and `apply_yield` (`YieldAccrued`). It is a single trusted key for now. The LayerZero receiver replaces it for messages and Pyth for the price; the instruction bodies do not change, only who may call them.

`set_oracle_lock(locked)` (admin; `Config.oracle_locked`, appended last, false on older Configs) switches those three instructions off with `OracleLocked`. Mainnet runs locked, so a stolen oracle key cannot register a Position that holds nothing or price an Advance against it; test mode stays unlocked. The oracle's remaining powers are `record_season` / `pay_season_rank` (bounded by the 48-hour window), `set_price` (test mode) and the co-signature of `take_advance_onchain` (the price comes from Pyth).

### Source authorities (cross-chain bridge)

`SourceAuthority` (`["source_auth", chain_byte]`) names, per source chain (Ethereum, HyperEVM), the signer allowed to report `PositionLocked` and `YieldAccrued`. Admin instructions `set_source_authority` / `remove_source_authority`; the source-signed twins `open_position_from_source` and `apply_yield_from_source` have the same bodies as `open_position` / `apply_yield`. The `tesoro_bridge` PDA is registered for both chains. `oracle_authority` still signs the same instructions unchanged and still supplies the issuance price. See `docs/cross-chain.md`.

## How Gemas move with their Sources

A Gema never loses its Source, its class or its tranche. A Pot is a list of lines per side. On a win the winner receives the loser's actual lines (minus fees) and their own entry back; the recipient's basket (or spill) is credited, and a line is on the own side iff the recipient owns the Source's Lock, so Gemas that come home count as own again. Fees are taken in Gemas from the loser's lines. A Draw or abandonment returns every entry to its funder, unchanged. A credit that does not fit the basket goes to the spill, so a recipient can never block a settlement. See "Economy upgrade (ADR 0013)" for the exact rules.

## Entry draw (replaces the Multi-Source allocation rule)

The program, not the client, chooses the lines of an entry. Rules:

1. Own lines first, in order of `due_at`; then won lines, earliest `due_at` first. A line's key is (side, `due_at`, source, class, tranche) and the basket is kept sorted by it. Fee-class lines (Platform, Studio, Leaderboard) are never drawn, reserved or moved.
2. The draw never takes below `reserved_total` (an Offer's amount is held by the tail of the order, so it never conflicts with an entry).
3. A line with a non-zero amount that sorts before another line that is drawn is drawn first. The client cannot skip a fast line.
4. If the lines do not fit one transaction (`MAX_DRAW_LINES = 12`, a placeholder until ticket 09 measures it), the entry is staged in an Entry Ticket, with no cap on lines. `open`/`join` consume a complete Ticket after checking that no playable line sorts before the Ticket's last staged line.
5. **A Player whose free Gemas cover an entry can always enter.** The draw spans the basket and the spill. Fuzz tests check this after every operation, with no cancel-first shortcut.

Settlement is bounded by chunks, not by a line cap: see "Match lifecycle".

## Money rules as built

- **Advance**: the whole projected yield (ticket 31: Gemas are 100% of the yield), `principal * rate_bps * months / (12 * 10_000)` in source units, converted at the issuance price, floored to whole Gemas. One open Advance per Position; a new one only when Debt is zero. Horizon 1 to 12.
- **Debt**: outstanding Gemas of the Position's open Source, in Gemas (source-unit view via `debt_units`). `YieldAccrued(cumulative)` repays it automatically; yield beyond the Advance goes to the owner as `free_yield`.
- **Principal never reduces Debt**: no ledger function reads Principal after sizing an Advance, and the only paths that lower Debt are `apply_yield` and `return_own` (property-tested).
- **Return**: only the Position owner, only their own-sourced Gemas, only up to Debt.
- **Yield Fee** (ticket 31): 20% (`yield_fee_bps = 2000`, cap 5000) of yield when it is cashed out: `redeem`, the ready part of an Instant Redeem, `redeem_treasury` (bought Gemas are not exempt), and the owner's free yield at `unlock`. One floor: `payout = floor(paid * (10_000 - yield_fee_bps) / 10_000)`, the fee is the rest (`ledger::yield_fee::cash_out`). Fee-class lines (Platform, Studio, Leaderboard) and prize Gemas are exempt. Never on Principal. Each Source snapshots `yield_fee_bps` and `pool_bps` when its Advance opens and counts `fee_units`/`pool_units` (the bridge reads their deltas). The fee joins the route as the Treasury's at once; the Pool's part becomes `pool_owed`. The Treasury's redeem also owes the Pool one fifth of the Instant Redeem Fee on the value after the Yield Fee.
- **Instant Redeem**: an order, not an instant payout. See "Instant Redeem orders". The old one-step instruction (`instant_redeem`, `instant_redeem_stake`, `instant_fee_bps = 3500`) is removed.
- **Redeem**: only up to a line's own ready part, paid in staking-token shares (see "Exact bookkeeping"); `redeemed` versus `yield_units` is still the redeemed-versus-pending split per Source. Another holder's Redeem, an Extend or a new fee never lowers a line's ready part.
- **Match**: entries are `Config.entry_sizes` (1 to 4 sizes, each a multiple of 100 so Points stay whole; set by `set_entry_sizes`, admin only; all zero = default 500 / 1,000 / 2,500, so devnet needs no call; mainnet sets 100 / 500 / 1,000, test mode keeps 500 / 1,000 / 2,500; the app mirrors it in `cluster-settings.ts`; open Matches, Requests and Offers keep their entry); settle once (`Open`/`Active` to `Settled`/`Refunded`); fees `platform_bps + studio_bps` of the Pot (placeholders 200 + 300), snapshotted when the Match opens, plus the **Leaderboard Fee** `Config.leaderboard_bps` (100), read from Config when the Match settles (all three capped at 5,000 together; see "Leaderboard" below). Refund by the Game authority any time, by the opener of an unjoined Match, or by anyone after 1h.
- **Backing**: Request (Player, game, entry); Offer (Backer, the Request it answers and that Request's game and entry, Player share of surplus in bps; no public Offers since 2026-10-22). Requests and Offers live 24h; an accepted Offer has 24h to be used. An Offer reserves an amount of the Backer's Gemas (`reserved_total`), not lines; the lines are drawn by the Entry draw when the backed Match opens. Only a Listed Game can be Backed. Win: Backer's entry first, then the Player's share of the surplus (after fees), the rest to the Backer. Loss: the Backer loses the entry, nothing more. No revoke after the Match starts (`Consumed`). The Player is never debited and only ever receives won Gemas.

## Game programs (CPI settlement)

A Game registers `(game program id, authority, studio_bps)`. `authority` may be a PDA of the Game program: `settle_match` and `extend_match_deadline` only require that the `game_authority` signer equals it, and a PDA signs by `invoke_signed` from the Game program. No change was needed for that. Block Puzzle (`docs/games/block-puzzle.md`) does exactly this with `PDA(["authority"], block_puzzle)`.

One change was strictly necessary: **`extend_match_deadline(new_deadline)`**. `join` sets the refund deadline to 1 h and anyone may refund an Active Match after it, which would let the losing Player of an async Game refund before the result is settled. The Game authority may push an Open or Active, unexpired Match's deadline later (an Open Match: block_puzzle's 24 h Queue window) (never earlier, at most 7 days from now, `MAX_MATCH_EXTENSION_SECS`, and since ADR 0013 never past 7 days after the Match opened); errors `InvalidDeadline`, `InvalidStatus`, `Expired`, `Unauthorized`. Covered by `only_the_game_authority_extends_a_deadline_forward_and_within_the_cap`. `refund_match` stays the liveness fallback: block_puzzle sets the deadline to its submission deadline plus 1 h, so its own settlement always comes first.

## Leaderboard (ADR 0006)

- **Config** gained `leaderboard_bps: u16` and `pool_account: Pubkey` after `games`. A Config created before them decodes with both zero (its unused tail is zeroed) and charges nothing. `init_leaderboard(bps)` (admin) reallocs it, creates the pool and sets the fee; it can be called again to change the fee. `update_config` and `register_game` keep platform + studio + leaderboard within the 5,000 bps cap.
- **Pool**: `TesoroAccount` at `["account", pda(["leaderboard"])]`, with a basket and a spill like any Account. Every won Match credits it through the normal payout path as a fee-class (Leaderboard) line, repaid third in the Payout order. Half the Yield Fee reaches it as prize Gemas (see "Pool, prizes and Seasons").
- **Event** `MatchWon { match_id, game, entry, player, funder, points, pool_fee, season, ts }` on every decisive `settle_match`. `points = entry / 100`, to the Player who played.
- **Seasons**: `season = (ts - 1_791_158_400) / 604_800 + 1` (Monday 2026-10-05 00:00 UTC is Season 1). `ledger/season.rs`, mirrored in `app/src/lib/chain/season.ts`.
- **`record_season(number, points[])`** (admin or the Season keeper in `EconomyConfig`): see "Pool, prizes and Seasons". The ranking is read only from events the core program wrote (verified program id; main 93e7960).
- **`pay_season_rank(rank, line)`**: pays each rank its share of every line of the frozen budget, one step at a time (`(rank, line)` cursor), rounding down. See "Pool, prizes and Seasons".
- **Trust**: the ranking comes from the keeper (recomputed from `MatchWon` events); the budget, the shares and the payouts are enforced here. See ADR 0006 and ADR 0013.

## Open questions

Conservative readings chosen where CONTEXT.md is silent. Raise before the build depends on them.

1. **Surplus base.** "The remainder is split by the Offer" is read as the remainder after Platform and Studio Fees. Alternative: split before fees.
2. **Who pays fees.** Fees come out of the loser's lines, so a winner always receives their own entry whole. Alternative: pro rata from the whole Pot.
3. **Entry cap.** Resolved by ADR 0013: no cap on lines per entry (Entry Tickets); "Redeem small leftovers" tidies tiny lines.
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

**Derived state.** `Accrued Yield = Principal x (growth - 1)`, `growth = 1 + rate_bps x (now - opened_at) x pool.speedup / (10,000 x year)`, gross (ticket 31: nothing is taken as it accrues): `ledger::native::position_accrued`. The open Advance counts `min(net - applied_net, units owed)` as its `yield_units` (`source_view`); a closed Source keeps the final value stored when it closed. `applied_net` is the checkpoint: net yield already consumed by closed Sources or banked into `free_yield`. A Source closes (Debt zero) in the next `take_native_advance`, in `unlock`, or in a `return_own` that clears Debt; the yield beyond it is banked as free yield and the checkpoint moves to now. Until then a repaid Advance simply reads Debt 0.

Instructions:
- `set_entry_limit(gemas)`: owner only (ADR 0012, Protections). Creates the `Protections` account (`["protections", account]`, the owner pays) on first use. `gemas` is the most the owner may enter in a fixed 7-day period that starts at their first counted entry after the last period ended; 0 means no limit. A lower limit applies at once; a higher one, or 0, is pending and applies 24 h later. Emits `EntryLimitSet`. Accounts: `owner_authority, owner_account, protections, system_program`.
- **Entry Limit checks:** `open_match`, `join_match` (the entrant) and `create_offer` (the Backer, when the entry is reserved) take `protections` (the PDA address, writable, may be empty = no Protection set) after the Account and count the entry; over the limit is `EntryLimitReached`. `open_match_backed` and `join_match_backed` count nobody (the Backer was counted at `create_offer`, the Player risks nothing of their own). Refunds, cancelled and expired Offers do not give room back (fixed-period accounting).
- `set_break(days)` (1 to 42) and `set_self_exclusion(months)` (6 to 60; a month is 30 days; 60 is only this call's cap, a later call lengthens): owner only, wall-clock, same accounts as `set_entry_limit` (`SetProtection`). Each sets its end to now + length and **refuses a call that would end earlier than the one running** (`ProtectionCannotShorten`); there is no instruction that ends or shortens either. Emit `BreakSet` / `SelfExclusionSet { account, until }`. `Protections` is `entry_limit`, `break_until`, `self_exclusion_until`, then 48 reserved bytes.
- **Break / Self-Exclusion checks** (`OnBreak` / `SelfExcluded`; both block all of: Match entries, Requests, Offers, being backed). Entry points take the relevant `["protections", account]` address (may be empty = nothing set): `open_match`, `join_match` (entrant, plus `opener_protections`: nobody joins a Match whose opener is away), `create_offer` (Backer), `create_request`, `accept_offer` (`protections`), `open_match_backed` (`protections` and `backer_protections`) and `join_match_backed` (those plus `opener_protections`). Self-Exclusion alone also blocks the Player-initiated Advances: `take_native_advance`, `extend_native_advance`, `take_advance` (EVM-Source, owner co-signs) and the on-chain-priced `take_native_advance_onchain` / `take_advance_onchain` take `protections`. Position opens (`open_native_position`, bridge-reported `open_position*`) only lock funds, take no Advance, and stay allowed. Never blocked (no Protections account in their lists): Redeem, Instant Redeem, Unlock, `return_own`, settle, refunds and expiry. (no Protections account in their lists): Redeem, Instant Redeem, Unlock, `accrue_*` / `apply_yield*` (Debt repayment), `return_own`, sweep, settle, refunds and expiry.
- **Clean-up when someone is away** (permissionless, so the keeper can run it): `refund_match` takes optional `opener_protections`; an Open Match whose opener is away is refunded by anyone at once. `clear_request(request, protections)` cancels an open Request of an away owner. `expire_offer` takes optional `backer_protections`; an Open or Accepted Offer of an away Backer is released at once (status Cancelled, an accepted Request reopens). Paired (Active) Matches play out. The app's Break flow sends `set_break`/`set_self_exclusion` first, then withdraws the Player's own items; the keeper job `away` finishes anything left.

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

The APY is fixed per Position at open and the Yield Fee per Source when its Advance opens, so a Treasury fee change applies only to Advances opened afterwards (test `a_fee_change_never_applies_backwards`). `speedup` is the one value read live from the canonical sim_lst Pool (a devnet constant by founder decision); changing it bends every open curve. `instant_redeem` still reads the Instant Redeem fee live.

Errors appended: `SourceRequired` (6018), `CompanyNotSet` (6019).

Tests: `ledger/native.rs` (property test over random Time/Advance/Redeem/ReturnOwn/Unlock sequences: minted never exceeds net Accrued Yield; closed Sources fully covered), `tests/native.rs` (LiteSVM with the real sim_lst: open -> Advance -> warp -> Redeem -> Unlock with no crank, second Advance after Debt 0, Extend with limits, Instant Redeem, pool totals within the proven bound, validation and a randomized on-chain sequence).

### How the app calls it

Flow: `create_account` (once) -> sim_lst `faucet` -> one tx of `open_native_position(nonce, lst)` + `take_native_advance(months)` (source index = `advances`, no `prev_source`) -> read Debt with `position_accrued` + `source_view` (no keeper) -> `redeem` with the eight remaining accounts -> `unlock` with the ten (+ Source) remaining accounts. Keep the price feed fresh (`set_price` from the keeper, < 24 h old). Oracle Positions keep working with no remaining accounts for `redeem` and `unlock`.

## Yield Fee, Instant Redeem and the Treasury (2026-10-12, ADR 0007; balance by math, ADR 0010)

> ADR 0013 changed this section: the Treasury spends only realised fees through one `spendable_shares` figure, Instant Redeem is an order (`request_instant_redeem`, `fill_instant_redeem`), and half the realised Yield Fee is owed to the Pool. Where the text below names `instant_redeem`, `instant_redeem_stake` or a Holding, read "Instant Redeem orders" and "Pool, prizes and Seasons" in the Economy upgrade section instead.

**Treasury balance** (SOL units, O(1)): `earned_fee(now, speedup) - fee_minted` (the Yield Fee earned by native Positions, never minted until paid) plus the simSOL in the treasury vault valued at the rate (funding and `redeem_treasury` refills land in the vault). `pay_from_treasury` pays Instant Redeem and withdrawals the same way: vault first, the shortfall shares minted by `sim_lst::mint_yield` straight to the destination, `fee_minted += ceil(value of minted shares)`, refused (`TreasuryShort`) when that would pass `earned_fee`. So `fee_minted <= earned_fee` always, and `earned_fee` itself is at most the sum of the per-Position fees (conservative). The Treasury never pays more than fee earned + simSOL it received.

| On chain | Seeds | Notes |
|---|---|---|
| `Treasury` | `["treasury"]` | `yield_fee_bps`, `instant_fee_bps`, `account`, `vault`, `fee_minted` (cumulative SOL units of earned Yield Fee already minted out as simSOL), `instant_units` (paid by SOL Instant Redeem), `funded_shares`, `withdrawn_units` (cumulative SOL units withdrawn), `company` (wallet `withdraw_treasury` pays; default = unset) |
| Treasury Account | `["account", treasury_pda]` | a `TesoroAccount` with the Treasury PDA as authority: holds the Gemas it bought; nobody can sign for it |
| Treasury vault (simSOL token account) | `["treasury_vault"]` | authority = the Treasury PDA |

Instructions (new):

- `set_entry_sizes(sizes: Vec<u64>)` (admin; extends Config to the current size, replaces the list; refused with `InvalidEntry` unless 1-4 distinct non-zero multiples of 100). Accounts: admin, config, system program. Games do not check entries; `open_match`, `create_request` and `create_offer` do.
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

## Retiring the old world (ticket 11, admin only)

`retire_native_custody`, `retire_position`, `retire_source`, `retire_holding`, `retire_offer`, `retire_request`, `retire_treasury` close the pre-reset money accounts once, after the in-place upgrade (rent to the admin). Each checks raw bytes and refuses anything of the current layout: a Position, custody, Treasury or Offer shorter than its `SPACE`; a Source whose Position is gone or old-sized; a Holding whose Source is gone (its Gemas leave the Account totals); a current-size Offer whose reserved Sources are all gone; a Request opened before the reset (`expires_at` before `RETIRE_REQUESTS_BEFORE`, 2026-10-20 00:00 UTC) and past `expires_at` plus the 24 h use window; a Request of the new world is never closable. An old custody's vault simSOL goes to the owner's associated token account (created, admin pays, if missing). Event `OldAccountRetired { kind, account, amount }`, error `NotOldWorld`. Run book: `docs/deployments.md` ("Retire the old accounts"); script `keeper/scripts/retire-old-accounts.ts`.

## Invite gate (ADR 0012)

`InviteGate { bump, required, key }` is its own PDA (`["invite_gate"]`, created by the admin's first `set_invite_gate`, rent paid by the admin) so `Config` keeps its layout and nothing needs a realloc. `create_account` always carries the PDA: a missing or never-set gate means off. Turning it on needs a non-default key (`InviteKeyMissing`). Only `Config.admin` can set it; `required = false` switches the gate off for public launch.

The `create_account` account list gained `invite_gate` (before `system_program`). Anchor clients resolve it from the IDL; hand-built instructions must add it. The deployed program must be upgraded before a client that sends the new list; the gate itself changes nothing until the admin turns it on.

Server flow (`app/src/server/invite/`): `POST /api/invite/redeem` takes a wallet-signed request (scope `tesoro-invite`, field `code`). It checks the code against the Invite store, marks it used by the signing wallet in one statement, stores the Invite's email as the wallet's verified notification email, and only then builds `create_account` (Player as fee payer), signs it with `INVITE_SECRET_KEY` and returns it. The Player signs and sends it. The same wallet asking again gets a fresh co-signed transaction; another wallet is refused (`code-used`); a wallet that already has an Account is refused before a code is spent. Codes are 16 Crockford base32 characters (80 bits), stored as SHA-256 of the normalised code (`invites` table, migration `0003_invites.sql`). Create codes with `newInviteCode()` + `hashCode()` + `InviteStore.create()` from `app/src/server/invite/store.ts`.

Order for mainnet: create the multisig vault's own Account first, then turn the gate on (`keeper/src/mainnet-keys.ts` plans the `set_invite_gate` step, signed by the vault).

## Mainnet SOL Positions on a staking token (ADR 0011, computed model of ADR 0010)

On the mainnet cluster a SOL Position holds a real staking token (jitoSOL for now) instead of simSOL. Test mode never creates these accounts and is unchanged; both kinds of Position live side by side and the programs share the Source, Holding, Advance and Gema logic. Code: `programs/tesoro_core/src/instructions/stake.rs`, `ledger/stake.rs`, `ledger/stake_pool.rs`; tests `tests/stake.rs` (LiteSVM with the real SPL stake pool program and the live jitoSOL pool, mint, reserve and fee accounts in `tests/fixtures`; `sim_lst` is not loaded).

**Staking token = admin setting; one custody per token.** `StakeConfig` (`["stake_config"]`): `active_mint` (the one token new Positions open with) and `apy_ceiling_bps`. `StakeCustody` (`["stake_custody", mint]`) with its vault (`["stake_vault", mint]`, authority = the custody): the shared custody of that token, pinned to its stake pool account. The vault is a token account, so it is per mint; a second token gets a second custody and the first keeps serving its Positions. Each Position records its token in `source_asset` and the pool's Staking Rate at open in `stake_rate_open` (1e12 lamports per token; non-zero marks a stake Position, `is_stake`). `custody_shares` is its tokens; `principal` is its lamports at the rate of the open. `PositionState` grew by 8 bytes (fresh start, as for ADR 0010).

**Growth since open = Staking Rate now / at open.** Every instruction that needs it reads the pool account passed in (`stake_pool`, or in `remaining_accounts`): it must be the custody's pinned pool, owned by an allowed stake pool program (`STAKE_POOL_PROGRAMS`: SPL stake pool `SPoo1Ku8...`, Sanctum SPL `SP12tWFx...`, Sanctum multi `SPMBzsVU...`; each verified on mainnet-beta on 2026-10-16 as an executable program owning 611-byte stake pool accounts, jitoSOL's pool is owned by the first), carry the custody's mint, and not be stale (`last_update_epoch` more than one epoch behind the clock: `StaleStakePool`). The Staking Rate is `total_lamports * 1e12 / pool_token_supply`. The rest is main's one formula: `Accrued Yield = Principal x (growth - 1)`, minus the Yield Fee fixed on the Position, via `stake_position_accrued` and the shared `native::source_view` / `prepare_advance` / `unlock_native` / `return_own_native`. Nothing is cranked; the keeper has no yield job for SOL on mainnet.

**Accounts that change hands.** Everything the ledger owes is in lamports; only a payout converts to tokens, at the rate of that moment, rounded down.

- `set_stake_token()` (admin): accounts `admin, config, stake_config, mint (9 decimals), stake_pool, custody, vault, token_program, system_program`. Creates the custody and vault the first time, pins the pool, makes `mint` active. Same token again must name the same pool.
- `set_stake_apy_ceiling(bps)` (admin): 1 to 2,000 (20%). Zero means not set: no Advance can be taken.
- `init_treasury_stake(yield_fee_bps, instant_fee_bps)` (admin): the Treasury and its Account without the simSOL vault, for a deployment without `sim_lst` (`init_treasury` needs the simSOL mint).
- `open_stake_position(nonce, shares)`: accounts `owner_authority, owner_account, stake_config, mint, custody, vault, owner_token, stake_pool, treasury, position, token_program, system_program`. Moves `shares` of the active token into the vault, records Principal at the rate now, copies the Treasury's Yield Fee, adds the Position to the custody totals. A Player with plain SOL puts the pool's `DepositSol` and an idempotent token-account create in front in the same transaction and asks for the quoted tokens less 0.5%: the token transfer fails if the deposit minted fewer and the whole transaction reverts (tested on the real pool).
- `take_stake_advance(horizon_months)`: accounts `owner_authority, owner_account, protections, position, onchain_price, price_feed, stake_config, custody, stake_pool, prev_source?, source, holding, system_program`. Price: only the Pyth mapping keyed by the token's mint (`set_onchain_price(asset = token mint, SOL/USD feed)`); the keeper `PriceFeed` instruction (`take_native_advance`) and the oracle's `take_advance` refuse a stake Position (`NotNativePosition` / `NativePosition`). Sizing: `StakePoolRead::sizing_apy_bps(ceiling)` = the pool's last-epoch growth (current rate against the rate from `last_epoch_total_lamports / last_epoch_pool_token_supply`) scaled to a year at an assumed 194,400 s epoch (432,000 slots at 450 ms, a little long on purpose so the figure errs low), capped by the ceiling; written to `position.rate_bps` before the Advance is sized. Zero growth gives `NoStakingGrowth`; no ceiling `StakeCeilingNotSet`. Self-Exclusion and Break apply as on every Advance.
- `extend_stake_advance(extra_months)`: as `extend_native_advance` with `stake_config, custody, stake_pool` instead of the sim_lst pool, sized as an Advance.
- `redeem` (stake Source): `remaining_accounts = [custody, stake_pool, vault, holder_token, token_program]`. Pays `tokens_for_units(units, rate)` from the vault, signed by the custody PDA.
- `unlock` (stake Position): `remaining_accounts = [custody (w), stake_pool, vault (w), owner_token (w), token_program]`, then the open Advance's Source. Pays `min(shares, (Principal + free yield) / rate)` tokens (a pool that lost value leaves the Player the shares, not the old Principal), books the Yield Fee (in tokens at this rate) into `realised_fee_shares`, removes the Position from the totals.
- `return_own`: `remaining_accounts = [custody, stake_pool]`. `apply_yield`, `claim_free_yield` and the oracle's Advances refuse stake Positions.

**Treasury, in tokens.** `StakeTotals` (on the custody; changes only on open and unlock): `principal`, `fee_shares = sum shares x fee_bps`, `fee_principal = sum Principal x fee_bps`, `realised_fee_shares`, `open_positions`. The Yield Fee earned in tokens is `(fee_shares - ceil(fee_principal x 1e12 / rate)) / 10,000 - 3 x open_positions + realised` (conservative: never above the sum of the per-Position fees, proven by a property test). The fee tokens simply stay in the vault. Balance = earned + `refilled_shares` (the Treasury Account redeeming Gemas it bought: `redeem_treasury` with `remaining_accounts = [custody (w), stake_pool]`) - `instant_shares` - `withdrawn_shares`, and never more than the vault holds above `ceil(sum Principal / rate)` (the Principal reserve: the Treasury can never take the vault below what returns every Locked Position's Principal). `instant_redeem_stake(amount)` pays 75% (the Treasury's `instant_fee_bps`) in tokens and fails `TreasuryShort` when the balance is short; `withdraw_treasury_stake(amount_units)` (admin) pays the company wallet's token account. Nobody seeds a mainnet Treasury.

**Known basis risk.** Yield is paid in tokens at the rate of the payout; the tokens paid early keep appreciating in the Player's wallet while the Position's remaining tokens carry the Principal. A Position that redeems yield and then sees the rate rise further is short by `units_redeemed x (later growth)` against the one formula; that slack is the Position's own 20% Yield Fee buffer, and the Principal-reserve rule above stops the Treasury from spending it. Errors appended (stable): `StakeTokenInactive` 6025, `StakeCeilingNotSet` 6026, `NotStakePosition` 6027, `BadStakePoolAccount` 6028; ledger `StaleStakePool`, `NoStakingGrowth` after `ProtectionCannotShorten`.


## Game registry and listing (ticket 10, docs/adr/0013)

A Game is one `["game", program_id]` record. `Config.games` is no longer read or written.

- **Registering proves control of the program.** The `game_program` account must be an executable program of the upgradeable loader (the ProgramData address is derived from the program id and must be the one the Program account names, owned by the loader and in the `ProgramData` state), of loader v4 (status Deployed; a finalized one only if it forwards to itself), or of the older non-upgradeable loader. The signer must be the upgrade authority read from that state. A program that can no longer be upgraded accepts only the PDA `["tesoro-register"]` of the Game program itself (it signs with `invoke_signed`), never a key. An unreadable program (closed, retracted, wrong accounts) is refused everywhere.
- **Terms.** The record names the settle authority, the Studio recipient and the Studio Fee (at most 10%; Platform + Studio + Leaderboard together at most 50%). The Studio recipient may not be the Pool, the Treasury or the Platform recipient (also checked again when a change is applied).
- **Changes.** `propose_game_change` starts a 7-day wait; `apply_game_change` applies it. Both need the control signature of the moment, and the key that proposed must still be in control when it applies: if the upgrade authority changes hands during the wait, the new holder proposes again. A second proposal restarts the wait; `cancel_game_change` clears it. The admin cannot edit a record.
- **Listing.** `list_game(listed_until, approved_hash)` (admin): tesoro_core hashes the deployed executable (SHA-256 of the ProgramData bytes after the 45-byte header, loader v4 after its 48-byte header, without trailing zero bytes, at most 1,800,000 bytes of account data), refuses unless it equals `approved_hash`, and records the current deploy slot as `approved_slot`. `refresh_listing` (anyone): when the slot moved but the bytes still hash to the approved build, moves `approved_slot` forward; different bytes stay unlisted (`CodeChanged`). `open_match` and `open_match_backed` read the deploy slot of the Game program (`game_program` and `program_data` accounts) and store `MatchState.listed` and `MatchState.deploy_slot`. Listed means `listed_until` is in the future and the slot equals `approved_slot`, so an upgraded Game is unlisted until the admin approves the new slot. Unlisted: a win emits `MatchWon.points = 0`, and a backed Match is refused (`GameNotListed`) at open. `join_match_backed` reads the Game's deploy slot again and refuses (`GameNotListed`) unless the Game is still listed for the slot the Match was opened with, so a Backer's Gemas never follow an upgraded build. While the admin's listing is in force, an unreadable program (junk accounts, closed program) is an error at open, not a silent downgrade to unlisted. Settling from an upgraded Game (refund only) belongs to ticket 09.
- **Why a hash.** The loader's `ExtendProgram` moves the ProgramData slot and appends zeros without changing the code (agave `solana-bpf-loader-program` `common_extend_program` writes `slot: clock_slot`; the plain instruction needs no authority unless the `enable_extend_program_checked` feature is active, 3.1.x; 4.3.2 has no feature check in the source we read). So the slot alone cannot tell a stranger's extension from an upgrade. The slot compare stays the fast path at open; `refresh_listing` is the slow path. Over 1,800,000 bytes of account data (a program extended far past its size) it cannot run and the admin relists with `list_game`. Measured on `vanguard.so` (783,672 bytes): see the ticket comment.
- **Migration.** `MatchState` grew by 9 bytes and every Match needs its Game record to settle or refund: settle or refund all open Matches before the upgrade, then register and list the Games (the devnet wipe of ticket 24 does this).
- **Immutable Games.** A Game that signs with `["tesoro-register"]` hands its registry to whoever can reach that CPI: expose it only behind the Game's own authority check.
- **Pair limit.** A joiner may join at most 20 Matches opened by the same opener in a 24-hour window (`PairState`, `PairLimitReached`). The counter costs the joiner about 0.001 SOL of rent; `close_pair(opener, joiner)` (anyone, after the window) returns it to the wallet that paid. The per-Account cap on Matches open at once belongs to the Match lifecycle (ticket 09), where the per-Account Match counter lives.
- **Call sites.** `open_match`, `open_match_backed`, `create_request`, `create_offer` take `game_record` (the three Game accounts for the two `open_match` variants); `join_match` and `join_match_backed` take `pair` and `system_program`; `settle_match` takes `config` and `game_record`; `refund_match` and `extend_match_deadline` take `game_record` instead of `config`. Game programs pass their own record (`["game", crate::ID]` of tesoro_core).

## Economy upgrade (ADR 0013)

One `tesoro_core` upgrade changes how Gemas are stored, repaid, bet, paid out and counted. Everything below is new or replaces the older sections. Built so far: the ledger (pure Rust) and its instructions for baskets, Positions, Advances, Redeem, Treasury, Instant Redeem orders, prizes, Seasons and the registry. Matching on baskets and Tickets (ticket 09) is described from the spec and marked.

### Exact bookkeeping per line

Code: `programs/tesoro_core/src/ledger/book/`.

- **Classes.** Every Gema of a Source is in one class: 0 Platform, 1 Studio, 2 Leaderboard (fee classes), 3 General, then Extension 1 to 11 (class 3 + n). Landed yield pays classes in this order, so it is the **Payout order**. A Gema keeps its class and tranche for life. A fee cut is the one operation that changes a line's class: it moves Gemas from a playable line to a fee-class line of the same Source, and the unpaid part becomes senior.
- **Index.** Each class is a Liquity-style stability pool: unpaid total `U`, product `P` (a fixed-point fraction still unpaid), `scale` and `epoch`, plus a share sum `S`. A line stores its `amount`, its unpaid part, the snapshot `(P, scale, epoch, ck, S)` it was last brought up to date at, and the staking-token shares it already owns. Every operation brings a line up to date first. Ready is derived: `amount - unpaid`. Fixed-point fractions stay with the line; whole Gemas are rounded down only when paid out.
- **Landing.** When a Source is touched, its new coverage (computed cumulative minus the high-water mark `H`) is allocated in class order, and the staking-token shares it is worth at that instant are recorded with it. Coverage beyond total unpaid is the owner's free yield. A sync allocates only `max(0, computed - H)`, so an unchanged yield figure allocates nothing after a return.
- **Holders carry a slash (D2).** Ready Gemas are claims on shares, not on a fixed amount of SOL, ETH or HYPE. A later slash lowers every holder's value by the same ratio. Redeem, fee cash-in, `return_own` and prize Redeem all pay shares by this one rule. Each line owns its exact shares (a share-sum `S` per class; closed history lives in append-only checkpoint pages of 32 records, 1,576 bytes, never a ring). A line asleep through thousands of epochs reads only its own epoch's records, and at most 11 inside one long epoch. Platform and Leaderboard are single-holder counters on the Source, exact for one holder; the instruction layer allows exactly one line of each class per Source.
- **Transfers are proportional.** Moving `k` of a line's Gemas moves `k * ready / amount` of its ready part and its shares with them. The donor keeps fixed-point remainders; at most one unit of dust goes to the owner pocket.
- **Counters.** `H` (coverage ever allocated, only grows), `R` (released by `return_own`), `C = H - R`. Invariants after every operation: Left to pay back equals the sum of the classes' unpaid amounts; ready + redeemed + `R` <= `H`; `ready + unpaid == sum(amount)` per class.
- **`return_own(k)`** returns the owner's own Gemas: the unpaid part is cancelled (Left to pay back falls by exactly that), the ready part goes to the owner's free yield and `R`. Nothing is taken from other holders.
- **Extend** opens a new class with its own `due_at` (now plus the new Length) and zero ready. It is junior to everything issued before it.
- **Cost.** A basket line is 144 bytes (`BASKET_VERSION` 3), the basket header 128. A Source book is 594 bytes with no Extension and 2,002 at 11. The book is read and written in place (`BookBytes`) because the in-memory book overflows the 4 KB SBF stack frame.
- **Bounds (documented, tested).** Shares per unit of coverage are limited to `shares <= delta * 2^40` (`SharesOutOfRange` otherwise). The error is a few units of unpaid amount per touch times the shares per unit landed, concentrated in the last units of a class's epoch; it never exceeds what landed. Tests: `ledger/book/tests.rs` (reference model in exact rational numbers, fuzz, directed Codex counterexamples).

### Basket, spill and sponsored rent

- **Basket** `["basket", account]` and **spill** `["spill", account]` are created with the Account (`create_account`; `init_stores` for older Accounts, the Pool and the Treasury). Both use the same sorted line layout, kept by one small `LineStore` type with no other logic (fuzzed against a list model).
- **Header** fields include totals (own, won, fee), `reserved_total`, `ticket_need`, sponsored lamports, `room_reserved` and flags (Entry Ticket open, Backing Ticket open).
- **Pool.** The basket and the spill act as one: the draw order, the free figure, every withdrawal and Ticket staging span both. A credit goes to a matching line, else a basket slot, else the spill. `put` is atomic: `SpillFull` changes nothing, the instruction layer grows the spill and retries. **An entry never needs a free slot:** every whole line it (or a Ticket stage) takes off the pool frees one, and that slot is held for the line (`room_reserved` in the spill header counts the held slots of both stores; the Ticket or the Match keeps its share), so cancel, restage and refund always find their place and no other credit can take it. Joining also holds, where the stores are passed and have room, the slots the other side's lines can need (`room_plan`); a credit without a hold waits for free room beyond the held ones.
- **Sponsored `create_account`, `set_profile`, `set_name_evm`.** `payer` (signer) and an optional `sponsor` come after `system_program`, so a wallet with no SOL can own an Account and a Profile: the relayer is `payer`, fronts the rent and is repaid by the sponsor in the same instruction. Any payer other than the wallet itself needs the sponsor account (`PayerNeedsSponsor`), so the relayer is never left holding rent. For a new Account the basket's four starting lines are recorded as sponsored in the store (they return to the sponsor when the basket shrinks, and count against the per-Account and total caps); the rest (the Account, both headers, the spill's base, a new Profile) stays for good and is counted in `accounts_spent` against `accounts_cap`, which starts at 0 (`set_accounts_cap`, admin): until the admin opens it nothing is created on the sponsor's SOL. The Invite key's co-signature is still the first remaining account of `create_account`. The bridge's `link_evm` also takes a `payer`; the relayer pays that rent itself (a different program cannot be repaid by the sponsor).
- **Growing.** Anyone may grow a store with their own lamports (`grow_store`, a gift to the owner). `grow_store_sponsored` is signed by the sponsor's relayer key and paid by the sponsor PDA, within a per-Account cap (basket and spill together) and a total cap. `shrink_store` (owner) refunds the sponsor first, then the owner; the two stores keep, together, the `room_reserved` slots. `claim_spill` merges spill lines into the basket (benchmark: 16 Sources, 32 merges, about 150,000 compute units).
- **Fee counters** live in the Source book (Platform, Studio for Tesoro's own Games, Leaderboard), never in a basket. A basket cannot hold a fee line of a Source whose counter exists (`basket_may_hold`). Outside studios' Studio Fees are fee-class lines in their own baskets.

### Entry draw and Entry Tickets

See "Entry draw" above. Ticket rules (ledger `draw/`, instructions with ticket 09):

- A Ticket `["ticket", account, nonce]` is bound to an Account, a Game and an entry size. Staging needs the owner, or applies to an accepted Offer's Backing Ticket. The Ticket reserves storage first (sponsored and refundable, within a total cap).
- While an Entry Ticket is open the basket allows no other draw and refuses new Offers' reservations. A Backing Ticket has its own flag, one at a time; it blocks only new Offers, and the Backer cancels it at once.
- `open`/`join` consume a complete Ticket: its pages become the side's Pot pages, so open and join stay one bounded transaction. A Ticket expires after `TICKET_WINDOW_SECS` (1 hour), and cancel/expiry return its lines in idempotent chunks anyone may run.
- An Offer reserves an amount; the Backer's lines are drawn by the same order when the backed Match opens. Reservation is refused while a Ticket is open.
- Open for ticket 09: the per-transaction line cap (`MAX_DRAW_LINES` is 12 until measured), `open_backing` authorisation (the Requester's signed open; Backer cancel or expiry), sponsor-paid growth for Ticket storage.

### Match lifecycle (ledger built; instructions are ticket 09)

- States: Open, Active, then **Settling** (frozen outcome) or **Refunding**, then Closed. Entering Settling or Refunding is one atomic, one-way step; the two exclude each other.
- The plan is frozen at the start: fee totals, cuts from the fewest loser lines (largest first), the Backed share, the phase order. Each chunk syncs the Sources it cuts, credits baskets or spills, and is idempotent by a cursor kept in the record. Anyone may continue a chunk.
- Payout order of a settlement: fee cuts (Platform, Studio, Leaderboard), then the winner's Backing, then the surplus.
- **Deadline.** Open, join and extend all clamp to 7 days after open (`MAX_MATCH_LIFETIME_SECS`). Starting a settlement at or after that point is refused; only a refund can start. A running settlement ignores the clock.
- **Same build as at open.** The Game's deploy slot is compared at the start of settling. The backed join already decides through `GameRecord::same_build(match, slot)`; the settle and refund instructions (ticket 09) are to use it too, and until then the ledger compares the raw slot. `same_build` means: a slot moved by a harmless extension with an unchanged approved build and the same listing epoch counts as the same build. After a real upgrade only a refund can start.
- **No-show.** A committed "started, nobody acted" result costs each side the Platform Fee once, then returns the rest exactly. A draw is an exact refund.
- **Records.** The settlement receipt `["settled", match]` is written at the start of Settling or Refunding. Start, chunk and completion records are written as events of the core program (event-CPI). The Match closes when every obligation is a durable basket or spill line; unused reserve goes back to its payer. Match ids come from the opener's Account and a counter that never resets (ticket 09).
- **Per-Account concurrent Match cap** and the per-Account Match counter belong to ticket 09. The per-pair limit is built: a joiner may join at most 20 Matches opened by the same opener per 24 hours (`PairState`).

### Pool, prizes and Seasons

Code: `ledger/prize/`, `instructions/prize.rs`, `instructions/season.rs`.

- **Realised Yield Fee (D1).** A Yield Fee counts when yield is cashed out (ticket 31). `realise_yield_fee` and, for the Treasury's redeems, `owe_pool` are the only ways `pool_owed` grows: the Pool's share (`EconomyConfig.pool_share`, half of the fee by default, changeable from a Season announced ahead through `set_prize_share`) goes to `pool_owed`, the rest to the Treasury.
- **One spendable figure per route:** `spendable_shares = max(0, T - owed_shares - pool_owed - reserved)`. `T` is the shares the Treasury holds; `owed_shares` is what holders of unlocked Locks may still claim, fixed in shares at Unlock; `reserved` is pending payouts. Treasury withdrawals, Instant Redeem fills and prize funding all spend only this. No cushion (D3).
- **Prize escrow.** An accounting bucket inside each custody vault (Solana native and stake routes), switched off until `set_prize_escrow`. `harvest(source)` (anyone; refused on prize Sources) moves a Leaderboard counter's ready part into the escrow. `fund_season_prize_native` / `_stake` (Season keeper or admin, once per ended Season) moves `pool_owed` into the escrow only while `T - owed - reserved >= pool_owed`, then issues one prize Source (`["prize", route, season]`) for the confirmed shares not yet issued, credited to the Pool. Each prize Source owns its own share quantity; a holder redeems `held / outstanding` of it with `redeem_prize`. Only prize Redeem and the finish of a payout lower the escrow. Every other Redeem path refuses prize Sources. A fee cut from prize Gemas becomes an ordinary, fully ready line in the recipient's basket and leaves only through prize Redeem.
- **Season order.** The Season ends; each route's `fund_season_prize`; `record_season` stores the ranking and a **frozen budget** (the Pool's 16 biggest free lines at most, reserved in `["pool_reservations"]` so a later Season cannot promise them again; `record` waits until every enabled route has been funded for that Season); the 48-hour void window (`void_season_rank`); `pay_season_rank(rank, line)` pays each rank its share of every budget line, rounding down; `close_season` releases leftovers into the next Season. Every rank gets the same mix.
- **Obligations** for later work: every other spender of Pool lines must respect the frozen reservations; a non-prize line in the Pool basket would freeze that rank's pay step (cannot happen while nobody can send Gemas to the Pool outside prize funding).

### Instant Redeem orders

Code: `ledger/instant/`, `instructions/instant.rs`.

- `request_instant_redeem(line, sell, ttl)` (the holder): Redeems the line's ready Gemas to the seller at full value, then moves `sell` Gemas of the unpaid part (won side only; never own or fee-class) into an order `["instant", account, nonce]`. The order keeps the Gemas' Source, class and tranche. They cannot be played, reserved or drawn while the order is open. The request is refused if the Gemas leaving would pass `reserved_total` (`ReservedGemas`), and a ttl outside 1 hour to 30 days (`InvalidOrderTtl`); the default is 7 days.
- `fill_instant_redeem` (the fill authority: the admin, or `EconomyConfig.fill_keeper` while `keeper_fills` is on; off by default), in full or in part: first Redeems any ready Gemas that repaid while the order waited (to the owner, from the class pool, not from Treasury money), then pays `floor(value at fill * (10000 - fee) / 10000)` from `spendable_shares` (fee `INSTANT_REDEEM_FEE_BPS = 2500`, one function that already receives the Source's fee share, so a curve can come later; cap `MAX_INSTANT_FEE_BPS`). The Treasury's basket takes the Gemas with the seller's class and tranche, never a fee class and never promoted. A fill into a full Treasury basket lands in its spill. A fill never touches `owed_shares` or `pool_owed`.
- `fill_instant_redeem_from_source` is the EVM twin, signed by the chain's source authority; the budget is the bridge-supplied `available_shares`. It is refused (`BridgedSource`) while the order holds repaid Gemas.
- `cancel_instant_redeem` (owner, any time) and `expire_instant_redeem` (anyone, after `expires_at`) return the exact line.
- `InstantOrder::max_fill` is the largest affordable part: what an automatic filler with a budget would call. Nothing else is needed to add one.

### Treasury

`spendable_shares` is the single figure for Treasury withdrawals, Instant Redeem fills and prize funding (see above). The stake custody counts only realised fee shares as spendable (the finding of ticket 26: open Locks' fees were counted before). On Unlock, a stake owner's payout is `custody shares - paid - owed - fee`, and the fee is taken only from what is above the owner's Principal. The Treasury is also refilled when it redeems the Gemas it bought (`redeem_treasury`). `Unlock` needs the `EconomyConfig` account, so `set_economy` runs in the same batch as the upgrade. Every stake payout needs a fresh stake pool (`UpdateStakePoolBalance`, which anyone can call; the keeper does).

### Fee cash-in (ticket 11b)

The Platform and Studio counters on a Source are repaid by the Payout order but belong to nobody until `cash_in_fee(class)` pays them out. It is permissionless, one call per Source and class (0 Platform, 1 Studio), and redeems the counter's ready Gemas as the shares they were worth when the yield landed (holders-carry-slashes rule). Platform pays `Config.platform_recipient`. Studio pays the Account named by the admin's `set_tesoro_studio`: a Source has one Studio counter for all of Tesoro's own Games, so the recipient is a setting (outside studios get fee lines in their baskets, never a counter). The recipient must be the passed Account and its wallet needs a token account for the asset. A second call with nothing newly covered fails with `ZeroAmount` and moves nothing; the counter never goes negative. Prize Sources have no `SourceState`, so they cannot be named. The Leaderboard counter is harvested, not cashed in.

On EVM Sources the Solana side is `cash_in_fee_from_source(class, min_units)`, signed by the chain's registered source authority (the bridge). It debits the counter, adds the units to `Source.redeemed_units` and emits `FeeCashedIn{source, class, recipient, gemas, shares, units}`; the bridge pays that recipient's linked EVM address in the same transaction. `min_units` is the bridge's batch minimum: a smaller cash-in fails and changes nothing.

### Game registry and listing

See "Game registry and listing" above. Changes made after it was first written:

- `list_game(listed_until, approved_hash)` and `refresh_listing` bind the build by SHA-256 of the deployed bytes (trailing zeros ignored; at most 1,800,000 bytes). Measured on `vanguard.so`: `list_game` 402,500 compute units, `refresh_listing` 407,641, and 1,162,069 at the size cap, so both need a raised limit (1,400,000).
- `GameRecord.listing_epoch` bumps only when `list_game` sets a different hash. A Match stores it at open. `GameRecord::same_build` decides whether a pending backed join (and, once ticket 09 lands, a settlement) still follows the same build.
- Known limit: whether the loader's checked extend is active on mainnet was not confirmed, so the slot alone is never trusted.

### Recheck when these merge

- Ticket 09 (matching): the "Match lifecycle" and "Entry Tickets" bullets above; the line cap; instruction names; compute numbers; Match ids and the `MatchWon` event fields (`challenge`, `asset`, `opened_at` explicit); the per-Account Match cap; `open_backing` authorisation.
- Tickets 12 to 15 (Games), 16 and 17 (bridge and vaults): `docs/cross-chain.md` "Economy upgrade on the bridge and vaults".
- Ticket 08z (Holdings removal): drop `HoldingState`, `open_holding` and the Holding rows and text from this file.
