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
Position: `open_position` (oracle), `take_advance` (owner picks the Horizon, oracle supplies the price, both sign), `apply_yield` (oracle; idempotent by `seq`), `return_own`, `redeem`, `claim_free_yield`, `unlock`.
Match: `open_match`, `join_match`, `open_match_backed`, `join_match_backed`, `settle_match` (registered Game authority only), `refund_match`.
Backing: `create_request`, `cancel_request`, `create_offer`, `accept_directed`, `apply_offer`, `accept_applicant`, `cancel_offer`, `expire_offer`.

Ledger errors surface as custom error `6100 + CoreError::code()`; program errors (`Unauthorized` = 6000, `GameNotRegistered` = 6001, `InvalidAccount` = 6003, ...) as usual.

### Trusted seam: `oracle_authority`

`Config.oracle_authority` signs `open_position` (the `PositionLocked` fact), `take_advance` (issuance price) and `apply_yield` (`YieldAccrued`). It is a single trusted key for now. The LayerZero receiver replaces it for messages and Pyth for the price; the instruction bodies do not change, only who may call them.

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
