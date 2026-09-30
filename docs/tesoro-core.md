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
Position: `open_position` (oracle), `open_native_position`, `take_native_advance`, `accrue_native_yield`, `sweep_native_surplus`, `set_price` (see Solana-native Positions below), `take_advance` (owner picks the Horizon, oracle supplies the price, both sign), `apply_yield` (oracle; idempotent by `seq`), `return_own`, `redeem` (refuses EVM-sourced Sources: they use `redeem_from_source`, co-signed by the chain's source authority, called by the bridge's `redeem_to_evm`), `claim_free_yield`, `unlock`.
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
4. At most `MAX_ENTRY_SOURCES = 2` Holdings per entry, which bounds accounts per instruction.
5. **Take N Gemas from a Pot** (fees, the Player's share): lines are merged by Source, sorted ascending by Source address, and drained in that order. Platform Fee first, then Studio Fee, then (for a backed win) the Player's share from what remains.
6. **Payout order** for `settle_match` / `refund_match`: payouts are merged by `(recipient, source)` and sorted by that pair. `remaining_accounts` carry, per payout, the recipient's `TesoroAccount` then its Holding of that Source.
7. **Redeem** pays a holder `held * redeemable / outstanding` at most (pro rata to holders, including escrowed and reserved Gemas in the denominator), so redemption never exceeds what the Source has accrued.

## Money rules as built

- **Advance**: 100% of `principal * rate_bps * months / (12 * 10_000)` in source units, converted at the issuance price, floored to whole Gemas. One open Advance per Position; a new one only when Debt is zero. Horizon 1 to 12.
- **Debt**: outstanding Gemas of the Position's open Source, in Gemas (source-unit view via `debt_units`). `YieldAccrued(cumulative)` repays it automatically; yield beyond the Advance goes to the owner as `free_yield`.
- **Principal never reduces Debt**: no ledger function reads Principal after sizing an Advance, and the only paths that lower Debt are `apply_yield` and `return_own` (property-tested).
- **Return**: only the Position owner, only their own-sourced Gemas, only up to Debt.
- **Redeem**: only up to accrued yield; `redeemed_units` versus `yield_units` is the redeemed-versus-pending split per Source.
- **Match**: entries 500 / 1,000 / 2,500; settle once (`Open`/`Active` to `Settled`/`Refunded`); fees `platform_bps + studio_bps` of the Pot (placeholders 200 + 300, capped at 5,000 together), snapshotted when the Match opens. Refund by the Game authority any time, by the opener of an unjoined Match, or by anyone after 1h.
- **Backing**: Request (Player, game, entry); Offer (Backer, game, entry, Player share of surplus in bps; directed at a Request or public with up to 8 applicants). Requests and Offers live 24h; an accepted Offer has 24h to be used. The Backer's Gemas are reserved on create. Win: Backer's entry first, then the Player's share of the surplus (after fees), the rest to the Backer. Loss: the Backer loses the entry, nothing more. No revoke after the Match starts (`Consumed`). The Player is never debited and only ever receives won Gemas.

## Game programs (CPI settlement)

A Game registers `(game program id, authority, studio_bps)`. `authority` may be a PDA of the Game program: `settle_match` and `extend_match_deadline` only require that the `game_authority` signer equals it, and a PDA signs by `invoke_signed` from the Game program. No change was needed for that. Block Puzzle (`docs/games/block-puzzle.md`) does exactly this with `PDA(["authority"], block_puzzle)`.

One change was strictly necessary: **`extend_match_deadline(new_deadline)`**. `join` sets the refund deadline to 1 h and anyone may refund an Active Match after it, which would let the losing Player of an async Game refund before the result is settled. The Game authority may push an Active, unexpired Match's deadline later (never earlier, at most 7 days from now, `MAX_MATCH_EXTENSION_SECS`); errors `InvalidDeadline`, `InvalidStatus`, `Expired`, `Unauthorized`. Covered by `only_the_game_authority_extends_a_deadline_forward_and_within_the_cap`. `refund_match` stays the liveness fallback: block_puzzle sets the deadline to its submission deadline plus 1 h, so its own settlement always comes first.

## Open questions

Conservative readings chosen where CONTEXT.md is silent. Raise before the build depends on them.

1. **Surplus base.** "The remainder is split by the Offer" is read as the remainder after Platform and Studio Fees. Alternative: split before fees.
2. **Who pays fees.** Fees come out of the loser's lines, so a winner always receives their own entry whole. Alternative: pro rata from the whole Pot.
3. **Two-Source entry cap.** An entry draws from at most 2 Holdings. A player holding many small Sources cannot enter until they consolidate by playing; a consolidation instruction may be needed.
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

Added additively (no existing account layout, seed or instruction signature changed). A native Position holds real `sim_lst` simSOL in a program-controlled vault; no oracle opens it, credits its yield or unlocks it. The yield is SIMULATED (sim_lst runs an accelerated clock, 1 month per ~10 min).

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
- `accrue_native_yield()`: permissionless crank. Cumulative accrued yield in SOL `= floor(V * r / 1e9) + paid - Principal` (V = shares still in the vault, r = current rate, paid = SOL already paid to redeemers); if it exceeds the applied cumulative it is applied exactly like `YieldAccrued` (Debt repaid first, the rest is free yield). Idempotent (same state = byte-identical no-op) and monotonic. Pass the open Advance's Source as the optional account when there is one.
- `redeem(amount)` on a native Source: `remaining_accounts = [custody (w), vault (w), holder simSOL token account (w), pool, token_program]`. Pays simSOL worth the redeemed units (`floor(units * 1e9 / rate)`) to the holder's own token account. Never more than accrued (the ledger bound), never touching Principal.
- `unlock()` on a native Position: same remaining accounts (destination = the owner's token account). Requires Debt zero; releases everything beyond the reserve below.
- `migrate_native_custody()`: anyone (payer covers rent); extends a custody opened before `tracked_shares` existed. Yield and cover are read from `NativeCustody.tracked_shares` (deposit minus payouts), never from the vault's token balance, so simSOL sent straight to the vault is not yield and cannot repay Debt (ADR 0001); it returns to the owner with the surplus at Unlock.
- `sweep_native_surplus()`: owner, after Unlock; releases whatever the vault holds beyond the reserve at the current rate (the reserve shrinks as the rate grows).

**Vault invariant.** While Locked the vault holds at least `ceil((Principal + owed) * 1e9 / rate)` shares, where `owed = cumulative_yield - free_yield - redeemed_units` is the yield applied to Sources and not yet paid to holders. After Unlock only `owed` is reserved, so yield owed to holders who have not redeemed stays in the vault, valued at the current rate, until they redeem. Every payout re-checks this (`VaultShortfall`). Free yield and un-cranked yield are not reserved: they return to the owner at Unlock. `claim_free_yield` is refused for native Positions for that reason. Rounding leaves at most a share or two of dust reserved.

Errors appended: `InvalidPool` 6007, `InvalidMint` 6008, `NativePosition` 6009, `NotNativePosition` 6010, `StalePrice` 6011; ledger `VaultShortfall`, `ZeroShares`.

Tests: `ledger/native.rs` (model property test over random Time/Advance/Crank/Redeem/ReturnOwn/Unlock sequences), `tests/native.rs` (LiteSVM with the real sim_lst, incl. a randomized on-chain sequence test reading the invariants back: Principal shares leave only via unlock, payouts <= accrued, vault covers Principal + owed, crank idempotent, wrong pool / mint / owner rejected). TS helper: `scripts/native-position`.

### How the app calls it

All with `TESORO_CORE_ID`, discriminators `sha256("global:<name>")[..8]` or the regenerated IDL (`pnpm build:programs`; the IDL gains `NativeCustody`, `PriceFeed` and a `Pool` type from sim_lst). Flow: `create_account` (once) -> sim_lst `faucet` -> one tx of `open_native_position(nonce, lst)` + `take_native_advance(months)` (source index = `advances` = 0) -> anyone calls `accrue_native_yield` (keeper or the app on view) -> `redeem` with the five remaining accounts -> `unlock` with the five remaining accounts -> optionally `sweep_native_surplus`. Keep the price feed fresh (`set_price` from the keeper, < 24 h old). Old IDL clients keep working for oracle Positions; `redeem` and `unlock` for those need no remaining accounts.
