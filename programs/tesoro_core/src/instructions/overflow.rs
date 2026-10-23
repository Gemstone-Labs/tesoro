//! Overflow records: where a credit goes when the Account's stores have no slot for it.
//!
//! A settle or refund chunk, a Ticket cancel and a Season payout credit lines to Accounts that
//! are not the caller. If such an Account's basket and spill are both at their maximum (or every
//! free slot is held for another Match), the credit must still land: the line is written into the
//! Account's **overflow record** for that scope, and the run goes on. Nothing waits for the
//! Account and nothing can freeze a Game's settlements by filling its own stores.
//!
//! * A record is `["overflow", owner, kind, id]` (`storage::overflow_address`): per Account and
//!   Match, per Season rank, or per prize route. Its body is a `LineStore` like a basket's, so a
//!   line moves in and out without being re-encoded.
//! * Its rent is reserved **before anything is debited**, by whoever pays for the entry's other
//!   storage: `open_match` and `join_match` create it when the Account's stores could not hold the
//!   slots the Match may need (see [`cover_room`]); a Season payout creates it in the same
//!   transaction as the payout. The payer is kept in the head.
//! * `claim_overflow` is permissionless: it moves lines into the owner's stores while there is room,
//!   and closes the record, returning the rent to its payer, once it is empty. A Match's record
//!   closes only after the Match is closed (its account is named in the remaining accounts), so
//!   an unused record is swept after `close_match`.
//! * Credits to the caller's own Account (Redeem, Instant Redeem, return, Offers) do not use it:
//!   the caller can make room, and the instruction fails with `SpillFull`, state unchanged.

use crate::books::OnchainBooks;
use crate::error::{MatchError, TesoroError};
use crate::instructions::basket::move_lamports;
use crate::instructions::economy::{draw_err, with_pool};
use crate::instructions::ticket::try_hold;
use crate::ledger::draw::{put_line, DrawError};
use crate::ledger::lifecycle::MatchId;
use crate::ledger::line_store::{Line, LineStore, HEADER_LEN};
use crate::ledger::Key;
use crate::state::*;
use crate::storage::*;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::Discriminator;
use anchor_lang::Key as _;
use std::collections::BTreeMap;

/// Most lines a join may reserve in the studio's overflow record (about 0.008 SOL of rent). A studio
/// whose stores are full and whose Pots need more than this cannot take new Matches.
pub const STUDIO_RECORD_MAX_LINES: usize = 8;

/// Whether a join may reserve `lines` lines in a studio's overflow record.
pub(crate) fn studio_record_fits(lines: usize) -> bool {
    lines <= STUDIO_RECORD_MAX_LINES
}

fn store_err(_: crate::ledger::line_store::LineStoreError) -> Error {
    error!(TesoroError::InvalidAccount)
}

/// The payer, kind and id a record keeps in its head.
pub(crate) fn head_of(data: &[u8]) -> Option<(Pubkey, u8, [u8; 40])> {
    if data.len() < OVERFLOW_STORE_AT + HEADER_LEN || data[..DISC] != *OverflowHead::DISCRIMINATOR {
        return None;
    }
    let payer = Pubkey::new_from_array(data[DISC..DISC + 32].try_into().ok()?);
    let kind = data[DISC + 32];
    let id: [u8; 40] = data[DISC + 33..DISC + 73].try_into().ok()?;
    Some((payer, kind, id))
}

/// Checks that `info` is the overflow record of `owner` for `kind` and `id`: program-owned,
/// writable, and at the address its own bump gives. Returns who paid for it.
pub(crate) fn check_record(
    info: &AccountInfo,
    owner: &Pubkey,
    kind: u8,
    id: &[u8; 40],
) -> Result<Pubkey> {
    require_keys_eq!(*info.owner, crate::ID, MatchError::OverflowRecordInvalid);
    require!(info.is_writable, TesoroError::NotWritable);
    let data = info.try_borrow_data()?;
    let (payer, k, i) = head_of(&data).ok_or_else(|| error!(MatchError::OverflowRecordInvalid))?;
    require!(k == kind && i == *id, MatchError::OverflowRecordInvalid);
    let store = LineStore::new(&data[OVERFLOW_STORE_AT..])
        .map_err(|_| error!(MatchError::OverflowRecordInvalid))?;
    require!(
        store.account() == owner.to_bytes(),
        MatchError::OverflowRecordInvalid
    );
    let expected = Pubkey::create_program_address(
        &[
            OVERFLOW_SEED,
            owner.as_ref(),
            &[kind],
            &id[..32],
            &id[32..],
            &[store.bump()],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(MatchError::OverflowRecordInvalid))?;
    require_keys_eq!(expected, *info.key, MatchError::OverflowRecordInvalid);
    Ok(payer)
}

/// Funds, allocates and assigns the record PDA (a record someone pre-funded cannot block it) and
/// formats it empty with room for `lines` lines.
fn create_record<'info>(
    record: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    (owner, kind, id, bump): (&Pubkey, u8, &[u8; 40], u8),
    lines: usize,
) -> Result<()> {
    let len = overflow_len(lines);
    let need = Rent::get()?
        .minimum_balance(len)
        .saturating_sub(record.lamports());
    if need > 0 {
        system_program::transfer(
            CpiContext::new(
                system.clone(),
                system_program::Transfer {
                    from: payer.clone(),
                    to: record.clone(),
                },
            ),
            need,
        )?;
    }
    let signer: &[&[&[u8]]] = &[&[
        OVERFLOW_SEED,
        owner.as_ref(),
        &[kind],
        &id[..32],
        &id[32..],
        &[bump],
    ]];
    system_program::allocate(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Allocate {
                account_to_allocate: record.clone(),
            },
            signer,
        ),
        len as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Assign {
                account_to_assign: record.clone(),
            },
            signer,
        ),
        &crate::ID,
    )?;
    let mut data = record.try_borrow_mut_data()?;
    data[..DISC].copy_from_slice(OverflowHead::DISCRIMINATOR);
    data[DISC..DISC + 32].copy_from_slice(&payer.key.to_bytes());
    data[DISC + 32] = kind;
    data[DISC + 33..DISC + 73].copy_from_slice(id);
    LineStore::init(&mut data[OVERFLOW_STORE_AT..], owner.to_bytes(), bump).map_err(store_err)?;
    Ok(())
}

/// Makes sure the overflow record of `owner` for `kind` and `id` exists among `candidates` with
/// room for at least `lines` lines (at most [`MAX_OVERFLOW_LINES`]), the rent coming from
/// `payer`. The caller names the record's address up front; a record that was not named is an
/// error.
pub(crate) fn reserve_record<'info>(
    candidates: &[AccountInfo<'info>],
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    owner: &Pubkey,
    kind: u8,
    id: &[u8; 40],
    lines: usize,
) -> Result<()> {
    let (address, bump) = overflow_address(owner, kind, id);
    let record = candidates
        .iter()
        .find(|i| *i.key == address)
        .ok_or_else(|| error!(MatchError::OverflowRecordMissing))?;
    require!(record.is_writable, TesoroError::NotWritable);
    let lines = lines.clamp(1, MAX_OVERFLOW_LINES);
    if record.owner == &system_program::ID && record.data_is_empty() {
        return create_record(record, payer, system, (owner, kind, id, bump), lines);
    }
    check_record(record, owner, kind, id)?;
    let have = {
        let data = record.try_borrow_data()?;
        LineStore::new(&data[OVERFLOW_STORE_AT..])
            .map_err(store_err)?
            .capacity()
    };
    if have >= lines {
        return Ok(());
    }
    let len = overflow_len(lines);
    let need = Rent::get()?
        .minimum_balance(len)
        .saturating_sub(record.lamports());
    if need > 0 {
        system_program::transfer(
            CpiContext::new(
                system.clone(),
                system_program::Transfer {
                    from: payer.clone(),
                    to: record.clone(),
                },
            ),
            need,
        )?;
    }
    record.resize(len)?;
    Ok(())
}

/// Holds, where the stores are passed and the room is there, the slots each Account's credits in
/// this Match can need (`plan`), on top of what it holds already. When an Account's stores cannot
/// give them, its overflow record for this Match is reserved instead (rent from `payer`), with
/// room for the lines that have no hold. An Account in `plan` whose stores are missing is an
/// error for the studio named in `must_pass` (a Game's own studio cannot make its settlements
/// depend on stores nobody sees) and skipped for any other Account; the same goes for its
/// record.
#[allow(clippy::too_many_arguments)]
pub(crate) fn cover_room<'info>(
    room: &mut [RoomHold; ROOM_HOLDS],
    plan: &BTreeMap<Key, usize>,
    stores: &[AccountInfo<'info>],
    records: &[AccountInfo<'info>],
    id: &MatchId,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    must_pass: Option<Key>,
) -> Result<()> {
    let seed = id.seed();
    for (account, want) in plan {
        let have = room
            .iter()
            .find(|h| h.account == *account)
            .map_or(0, |h| h.left as usize);
        if *want <= have {
            continue;
        }
        let owner = Pubkey::new_from_array(*account);
        let (Some(basket), Some(spill)) = (
            store_among(stores, &owner, true),
            store_among(stores, &owner, false),
        ) else {
            require!(must_pass != Some(*account), MatchError::StudioStoresMissing);
            continue;
        };
        let extra = (*want - have) as u32;
        if try_hold(&basket, &spill, extra)? {
            crate::instructions::matching::add_hold(room, *account, extra)?;
        } else {
            // The studio's record is paid by whoever joins, and a studio can keep its stores full on
            // purpose, so the rent a join can be asked for is capped: past the cap the join is
            // refused and the studio has to make room. Entrants' own records are their own cost.
            require!(
                must_pass != Some(*account) || studio_record_fits(extra as usize),
                MatchError::StudioStoresFull
            );
            // A record nobody named is skipped for an entrant's own Accounts (entering must
            // never fail for room: the credit then waits like before); the studio's is
            // required, or its owner could stop the Game's settlements by filling its stores.
            let (address, _) = overflow_address(&owner, OVERFLOW_MATCH, &seed);
            if must_pass != Some(*account) && !records.iter().any(|i| *i.key == address) {
                continue;
            }
            reserve_record(
                records,
                payer,
                system,
                &owner,
                OVERFLOW_MATCH,
                &seed,
                extra as usize,
            )?;
        }
    }
    Ok(())
}

fn store_among<'info>(
    infos: &[AccountInfo<'info>],
    owner: &Pubkey,
    basket: bool,
) -> Option<AccountInfo<'info>> {
    let seed = if basket { BASKET_SEED } else { SPILL_SEED };
    infos
        .iter()
        .find(|i| crate::instructions::matching::check_store(i, seed, owner).is_ok())
        .cloned()
}

/// Puts `line` into the overflow record `info` (merge into the line with the same key through
/// the Source's book, or insert). `Ok(false)` when the record is full; nothing changed then.
pub(crate) fn put_in_record(
    info: &AccountInfo,
    books: &mut dyn crate::ledger::draw::SourceBooks,
    line: &Line,
) -> std::result::Result<bool, DrawError> {
    let mut data = info
        .try_borrow_mut_data()
        .map_err(|_| DrawError::Store(crate::ledger::line_store::LineStoreError::BadStore))?;
    let mut store = LineStore::new(&mut data[OVERFLOW_STORE_AT..])?;
    put_line(&mut store, books, line)
}

/// Credits a prize line to `owner`'s stores; if neither has a slot, writes it to the overflow
/// record of `kind` and `id` instead, creating it with `payer`'s lamports in the same
/// transaction (so nothing is debited from the prize without the line landing somewhere).
/// The record and the system program are among `candidates`; without the record the credit
/// stays `SpillFull`, nothing changed. Returns whether the line went to the record.
#[allow(clippy::too_many_arguments)]
pub(crate) fn credit_prize<'info>(
    basket: &AccountInfo,
    spill: &AccountInfo,
    owner: &Pubkey,
    line: &Line,
    candidates: &[AccountInfo<'info>],
    payer: &AccountInfo<'info>,
    kind: u8,
    id: &[u8; 40],
) -> Result<bool> {
    use crate::instructions::prize::try_put_prize;
    if with_pool(basket, spill, |pool| try_put_prize(pool, line))? {
        return Ok(false);
    }
    let (address, _) = overflow_address(owner, kind, id);
    let system = candidates
        .iter()
        .find(|i| *i.key == system_program::ID)
        .filter(|_| candidates.iter().any(|i| *i.key == address))
        .ok_or_else(|| crate::error::core_err(crate::ledger::CoreError::SpillFull))?;
    reserve_record(candidates, payer, system, owner, kind, id, 1)?;
    let record = candidates
        .iter()
        .find(|i| *i.key == address)
        .ok_or_else(|| error!(MatchError::OverflowRecordMissing))?;
    let mut books = OnchainBooks::load(&[])?;
    require!(
        put_in_record(record, &mut books, line).map_err(draw_err)?,
        MatchError::OverflowRecordInvalid
    );
    Ok(true)
}

/// The id of a Season prize step's overflow record: the Season number, the rank and the line.
pub fn season_overflow_id(season: u32, rank: u8, line: u8) -> [u8; 40] {
    let mut id = [0u8; 40];
    id[..4].copy_from_slice(&season.to_le_bytes());
    id[4] = rank;
    id[5] = line;
    id
}

/// The id of a prize route's funding line: the Season number and the route's custody.
pub fn route_overflow_id(season: u32, custody: &Pubkey) -> [u8; 40] {
    let mut id = [0u8; 40];
    id[..4].copy_from_slice(&season.to_le_bytes());
    id[4..36].copy_from_slice(&custody.to_bytes());
    id
}

/// Season recording reads the Pool's basket and spill, so a prize line still waiting in the Pool's
/// overflow record for `season` and a route would be left out of the budget. Every registered route's
/// record address is named in `records` (an account that does not exist yet is fine); one that holds
/// Gemas stops the recording until `claim_overflow` has moved them into the Pool's stores.
pub(crate) fn require_routes_claimed(
    records: &[AccountInfo],
    pool: &Pubkey,
    season: u32,
    routes: &[Pubkey],
) -> Result<()> {
    for custody in routes {
        let id = route_overflow_id(season, custody);
        let (address, _) = overflow_address(pool, OVERFLOW_ROUTE, &id);
        let record = records
            .iter()
            .find(|i| *i.key == address)
            .ok_or_else(|| error!(MatchError::OverflowRecordMissing))?;
        if record.owner == &system_program::ID {
            continue;
        }
        require_keys_eq!(*record.owner, crate::ID, MatchError::OverflowRecordInvalid);
        let data = record.try_borrow_data()?;
        require!(head_of(&data).is_some(), MatchError::OverflowRecordInvalid);
        let store = LineStore::new(&data[OVERFLOW_STORE_AT..])
            .map_err(|_| error!(MatchError::OverflowRecordInvalid))?;
        require!(
            !store.lines().any(|l| l.amount > 0),
            MatchError::PoolOverflowUnclaimed
        );
    }
    Ok(())
}

/// Returns an empty record's rent to whoever paid it and hands the account back to the system
/// program.
fn close_record<'info>(record: &AccountInfo<'info>, payer: &AccountInfo<'info>) -> Result<()> {
    move_lamports(record, payer, record.lamports())?;
    record.assign(&system_program::ID);
    record.resize(0)?;
    Ok(())
}

/// Whether the Match an `OVERFLOW_MATCH` record belongs to is closed: its account (named among
/// `infos`) no longer belongs to this program. Not named means not proven, so not closed.
fn match_is_closed(id: &[u8; 40], infos: &[AccountInfo]) -> bool {
    let (address, _) =
        Pubkey::find_program_address(&[MATCH_SEED, &id[..32], &id[32..40]], &crate::ID);
    infos
        .iter()
        .find(|i| *i.key == address)
        .is_some_and(|i| *i.owner != crate::ID || i.data_is_empty())
}

/// Moves up to `max` lines of an overflow record into its owner's stores, in the record's order,
/// while there is room, and closes the record once it is empty (rent to its payer). Anyone may
/// call it. The Source books of lines that merge into a line the owner holds are remaining
/// accounts, like `claim_spill`.
#[derive(Accounts)]
pub struct ClaimOverflow<'info> {
    #[account(
        seeds = [ACCOUNT_SEED, account.authority.as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [BASKET_SEED, account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    /// CHECK: the record of this Account; `check_record` proves it from its own head.
    #[account(mut)]
    pub record: UncheckedAccount<'info>,
    /// CHECK: whoever paid the record; checked against its head.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

pub(crate) fn claim_overflow<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClaimOverflow<'info>>,
    max: u8,
) -> Result<()> {
    let owner = ctx.accounts.account.key();
    let record = ctx.accounts.record.to_account_info();
    let (head_payer, kind, id) = {
        let data = record.try_borrow_data()?;
        head_of(&data).ok_or_else(|| error!(MatchError::OverflowRecordInvalid))?
    };
    let payer = check_record(&record, &owner, kind, &id)?;
    require_keys_eq!(payer, head_payer, MatchError::OverflowRecordInvalid);
    require_keys_eq!(
        *ctx.accounts.payer.key,
        payer,
        MatchError::OverflowRecordInvalid
    );
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let mut moved = 0u32;
    let left = with_pool(
        &ctx.accounts.basket.to_account_info(),
        &ctx.accounts.spill.to_account_info(),
        |pool| {
            let mut data = record.try_borrow_mut_data()?;
            let mut store = LineStore::new(&mut data[OVERFLOW_STORE_AT..]).map_err(store_err)?;
            while moved < max as u32 {
                let Some(line) = store.get(0) else { break };
                match pool.put(&mut books, &line) {
                    Ok(_) => {}
                    Err(DrawError::SpillFull) => break,
                    Err(e) => return Err(draw_err(e)),
                }
                store.remove_at(0).map_err(store_err)?;
                moved += 1;
            }
            Ok(store.len() as u32)
        },
    )?;
    books.flush()?;
    // A Match's record is still a place for its chunks to write until the Match is closed: closing
    // it early would let anyone undo the hold the studio's join paid for. It closes once the Match
    // account is gone (the caller names that account among the remaining ones).
    let may_close = kind != OVERFLOW_MATCH || match_is_closed(&id, ctx.remaining_accounts);
    if left == 0 && may_close {
        close_record(&record, &ctx.accounts.payer.to_account_info())?;
    }
    emit!(OverflowClaimed {
        account: owner,
        kind,
        moved,
        left,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_studio_record_is_capped_so_a_join_cannot_be_made_to_pay_for_a_big_one() {
        assert!(studio_record_fits(1));
        assert!(studio_record_fits(STUDIO_RECORD_MAX_LINES));
        assert!(!studio_record_fits(STUDIO_RECORD_MAX_LINES + 1));
    }
}
