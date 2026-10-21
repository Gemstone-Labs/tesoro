//! Entry and Backing Tickets (spec "Entry Tickets", "Backing"): open with storage first, stage the
//! next lines of the draw order, cancel or expire in chunks anyone may continue, close.
//!
//! A Ticket account is also the Pot of the side that consumes it (`crate::pots`), so nothing is
//! ever copied. Opening a Ticket reserves, in the Account's spill, as many slots as the Ticket's
//! storage holds lines, so cancelling or restaging can never find the pool without room.
//!
//! # Who may do what
//!
//! | | Entry Ticket | Backing Ticket |
//! |---|---|---|
//! | open | the owner | the Requester the Offer was accepted for (signature required) |
//! | stage | the owner | anyone (the program fixes order and destination) |
//! | cancel | the owner, or anyone once it expired | the Backer, or anyone once it expired |

use crate::books::OnchainBooks;
use crate::error::{core_err, BasketError, MatchError, TesoroError};
use crate::instructions::basket::{move_lamports, top_up};
use crate::instructions::economy::{book_err, store_err, with_pool};
use crate::ledger::draw::{DrawError, Ticket, TicketKind, TicketState, TICKET_WINDOW_SECS};
use crate::ledger::line_store::LineStore;
use crate::ledger::{CoreError, OfferStatus};
use crate::pots::*;
use crate::state::*;
use crate::storage::*;
use crate::util::now;
use anchor_lang::prelude::*;

/// Which Ticket to open.
#[derive(Clone, Copy, PartialEq, Eq, Debug, AnchorSerialize, AnchorDeserialize)]
pub enum TicketKindArg {
    Entry,
    Backing,
}

/// Largest Ticket an `init` can create (account creation by CPI is capped at 10,240 bytes);
/// `grow_ticket` adds the rest.
pub const MAX_INITIAL_TICKET_LINES: usize = (10_240 - POT_AT - 128) / crate::ledger::LINE_LEN;

pub(crate) fn ticket_err(e: DrawError) -> Error {
    match e {
        DrawError::InsufficientGemas => core_err(CoreError::InsufficientGemas),
        DrawError::TicketOpen => MatchError::TicketAlreadyOpen.into(),
        DrawError::NotOpen => MatchError::TicketNotOpen.into(),
        DrawError::Mismatch => MatchError::TicketMismatch.into(),
        DrawError::NotOwner => MatchError::NotTicketOwner.into(),
        DrawError::StorageNotReserved => MatchError::StorageNotReserved.into(),
        DrawError::TicketStorageFull => MatchError::TicketStorageFull.into(),
        DrawError::NotComplete => MatchError::TicketNotComplete.into(),
        DrawError::FasterGemasAvailable => MatchError::FasterGemasAvailable.into(),
        DrawError::NeedsTicket => MatchError::NeedsTicket.into(),
        DrawError::SpillFull => core_err(CoreError::SpillFull),
        DrawError::TooManyOffers => MatchError::TooManyOffers.into(),
        DrawError::ReservationShort | DrawError::WouldBreakReservation => {
            core_err(CoreError::ReservedGemas)
        }
        DrawError::NotExpired => MatchError::TicketNotExpired.into(),
        DrawError::ZeroAmount => core_err(CoreError::ZeroAmount),
        DrawError::Book(b) => book_err(b),
        DrawError::Store(_) => BasketError::BadStore.into(),
    }
}

// ---------------------------------------------------------------------------------------------
// Room in the spill
// ---------------------------------------------------------------------------------------------

/// Holds `slots` of the spill's free slots for Matches and Tickets in flight. The spill must have
/// them free on top of what is already held: the caller grows it first (`grow_store`,
/// `grow_store_sponsored`).
pub(crate) fn reserve_room(spill: &AccountInfo, slots: u32) -> Result<()> {
    if slots == 0 {
        return Ok(());
    }
    let mut data = spill.try_borrow_mut_data()?;
    let mut store = LineStore::new(&mut data[DISC..]).map_err(store_err)?;
    let free = store.capacity() - store.len();
    let held = store.room_reserved() as usize;
    require!(free >= held + slots as usize, MatchError::RoomNotReserved);
    store.set_room_reserved(held as u32 + slots);
    Ok(())
}

/// Gives back slots held by `reserve_room`.
pub(crate) fn release_room(spill: &AccountInfo, slots: u32) -> Result<()> {
    if slots == 0 {
        return Ok(());
    }
    let mut data = spill.try_borrow_mut_data()?;
    let mut store = LineStore::new(&mut data[DISC..]).map_err(store_err)?;
    let held = store.room_reserved();
    store.set_room_reserved(held.saturating_sub(slots));
    Ok(())
}

/// Moves the sponsor's rent for a fresh sponsored account to the relayer that fronted it, within
/// the caps; returns what was sponsored.
fn sponsor_rent<'info>(
    sponsor: &mut Account<'info, SponsorState>,
    relayer: &AccountInfo<'info>,
    account_sponsored_now: u64,
    delta: u64,
) -> Result<()> {
    require!(!sponsor.paused, BasketError::SponsorPaused);
    require_keys_eq!(
        sponsor.relayer,
        *relayer.key,
        BasketError::NotSponsorRelayer
    );
    require!(
        account_sponsored_now
            .checked_add(delta)
            .is_some_and(|v| v <= sponsor.per_account_cap),
        BasketError::AccountSponsorCap
    );
    let outstanding = sponsor
        .outstanding
        .checked_add(delta)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        outstanding <= sponsor.total_cap,
        BasketError::TotalSponsorCap
    );
    let sponsor_info = sponsor.to_account_info();
    let keep = Rent::get()?.minimum_balance(sponsor_info.data_len());
    require!(
        sponsor_info.lamports() >= delta && sponsor_info.lamports() - delta >= keep,
        BasketError::SponsorShort
    );
    move_lamports(&sponsor_info, relayer, delta)?;
    sponsor.outstanding = outstanding;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------------------------

/// Opens a Ticket with room for `lines` lines of storage. `payer` pays the rent, refundably; with
/// the sponsor accounts it is the relayer, made whole from the sponsor at once, within the caps.
///
/// An Entry Ticket is the owner's (`authority` is the owner's wallet). A Backing Ticket is for an
/// accepted Offer and needs the Requester's signature: `authority` is the Requester's wallet,
/// `owner` is the Backer's Account whose lines will be staged.
#[derive(Accounts)]
#[instruction(nonce: u64, kind: TicketKindArg, game: Pubkey, target: u64, lines: u32)]
pub struct OpenTicket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = requester.bump
    )]
    pub requester: Box<Account<'info, TesoroAccount>>,
    /// The Account whose lines are staged: the Requester's own (Entry) or the Backer's (Backing).
    #[account(
        seeds = [ACCOUNT_SEED, owner.authority.as_ref()],
        bump = owner.bump
    )]
    pub owner: Box<Account<'info, TesoroAccount>>,
    #[account(
        mut,
        seeds = [BASKET_SEED, owner.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, owner.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    #[account(
        init,
        payer = payer,
        space = ticket_len(lines as usize),
        seeds = [TICKET_SEED, owner.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub ticket: AccountLoader<'info, TicketHead>,
    /// The accepted Offer a Backing Ticket is for.
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Option<Box<Account<'info, OfferState>>>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_ticket(
    ctx: Context<OpenTicket>,
    nonce: u64,
    kind: TicketKindArg,
    game: Pubkey,
    target: u64,
    lines: u32,
) -> Result<()> {
    let ts = now()?;
    require!(
        lines >= 1 && (lines as usize) <= MAX_INITIAL_TICKET_LINES,
        BasketError::GrowTooLarge
    );
    let owner_key = ctx.accounts.owner.key();
    match kind {
        TicketKindArg::Entry => {
            require_keys_eq!(
                ctx.accounts.requester.key(),
                owner_key,
                TesoroError::Unauthorized
            );
        }
        TicketKindArg::Backing => {
            let offer = ctx
                .accounts
                .offer
                .as_mut()
                .ok_or_else(|| error!(MatchError::BadBacking))?;
            require!(!offer.inner.ticket_open, MatchError::TicketAlreadyOpen);
            require!(
                offer.inner.backer == owner_key.to_bytes()
                    && offer.inner.game == game.to_bytes()
                    && offer.inner.entry == target
                    && offer.inner.status == OfferStatus::Accepted
                    && offer.inner.player == Some(ctx.accounts.requester.key().to_bytes())
                    && ts < offer.inner.use_by,
                MatchError::OfferNotUsable
            );
            offer.inner.ticket_open = true;
        }
    }
    let basket_info = ctx.accounts.basket.to_account_info();
    let spill_info = ctx.accounts.spill.to_account_info();
    let ticket_info = ctx.accounts.ticket.to_account_info();
    let bump = ctx.bumps.ticket;
    let expires_at = ts
        .checked_add(TICKET_WINDOW_SECS)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    // reserve the spill room first: the Ticket can always return what it holds
    reserve_room(&spill_info, lines)?;
    let pages = init_pot(&ticket_info, &owner_key, bump)?;
    let mut ticket = with_pool(&basket_info, &spill_info, |pool| {
        match kind {
            TicketKindArg::Entry => {
                Ticket::open_entry_in(pool, game.to_bytes(), nonce, target, expires_at, pages)
            }
            TicketKindArg::Backing => {
                Ticket::open_backing_in(pool, game.to_bytes(), nonce, target, expires_at, pages)
            }
        }
        .map_err(ticket_err)
    })?;
    ticket.line_cap = lines as usize;
    ticket.storage_reserved = true;
    let mut extra = TicketExtra {
        bump,
        payer: ctx.accounts.payer.key(),
        spill_room: lines,
        sponsored_lamports: 0,
    };
    if let Some(sponsor) = ctx.accounts.sponsor.as_mut() {
        let rent = Rent::get()?.minimum_balance(ticket_len(lines as usize));
        sponsor_rent(sponsor, &ctx.accounts.payer.to_account_info(), 0, rent)?;
        extra.sponsored_lamports = rent;
    }
    let fields = HeadFields::of(&ticket);
    init_head(ticket.pages.bytes_mut(), &fields, &extra);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Grow
// ---------------------------------------------------------------------------------------------

/// Adds storage to an open Ticket (and the spill room that goes with it). Anyone may pay; with the
/// sponsor accounts the relayer fronts the rent and is made whole, within the caps.
#[derive(Accounts)]
pub struct GrowTicket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner.authority.as_ref()],
        bump = owner.bump
    )]
    pub owner: Box<Account<'info, TesoroAccount>>,
    #[account(
        mut,
        seeds = [SPILL_SEED, owner.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    /// CHECK: loaded and checked as a Ticket of `owner` by `load_ticket`.
    #[account(mut)]
    pub ticket: UncheckedAccount<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn grow_ticket(ctx: Context<GrowTicket>, extra_lines: u32) -> Result<()> {
    require!(extra_lines > 0, BasketError::NothingToResize);
    require!(
        extra_lines as usize <= MAX_GROW_LINES,
        BasketError::GrowTooLarge
    );
    let info = ctx.accounts.ticket.to_account_info();
    let spill_info = ctx.accounts.spill.to_account_info();
    let (new_lines, mut extra, sponsored_now) = {
        let (t, x) = load_ticket(&info)?;
        require_keys_eq!(
            Pubkey::new_from_array(t.account),
            ctx.accounts.owner.key(),
            MatchError::TicketMismatch
        );
        require!(
            matches!(t.state, TicketState::Open),
            MatchError::TicketNotOpen
        );
        let cap = t.pages.capacity();
        let lines = cap
            .checked_add(extra_lines as usize)
            .filter(|n| *n <= MAX_BASKET_LINES)
            .ok_or(BasketError::StoreAtMaximum)?;
        (lines, x, x.sponsored_lamports)
    };
    reserve_room(&spill_info, extra_lines)?;
    let delta = top_up(&info, ticket_len(new_lines))?;
    if let Some(sponsor) = ctx.accounts.sponsor.as_mut() {
        sponsor_rent(
            sponsor,
            &ctx.accounts.payer.to_account_info(),
            sponsored_now,
            delta,
        )?;
        extra.sponsored_lamports = sponsored_now + delta;
    }
    if delta > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            delta,
        )?;
    }
    info.resize(ticket_len(new_lines))?;
    let (mut t, _) = load_ticket(&info)?;
    t.line_cap = new_lines;
    extra.spill_room = extra
        .spill_room
        .checked_add(extra_lines)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    save_ticket(&mut t, &extra);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

/// Moves the next lines of the draw order into the Ticket (and, when faster Gemas arrived since,
/// first returns the slowest staged lines). `remaining_accounts` are the books (and pages) of the
/// Sources a split or a merge touches.
#[derive(Accounts)]
pub struct StageEntry<'info> {
    pub signer: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner.authority.as_ref()],
        bump = owner.bump
    )]
    pub owner: Box<Account<'info, TesoroAccount>>,
    #[account(
        mut,
        seeds = [BASKET_SEED, owner.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, owner.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    /// CHECK: loaded and checked as a Ticket of `owner` by `load_ticket`.
    #[account(mut)]
    pub ticket: UncheckedAccount<'info>,
}

pub(crate) fn stage_entry<'info>(
    ctx: Context<'_, '_, 'info, 'info, StageEntry<'info>>,
    max_ops: u8,
) -> Result<()> {
    let ticket_info = ctx.accounts.ticket.to_account_info();
    let (mut t, extra) = load_ticket(&ticket_info)?;
    require_keys_eq!(
        Pubkey::new_from_array(t.account),
        ctx.accounts.owner.key(),
        MatchError::TicketMismatch
    );
    let owner_signs = ctx.accounts.signer.key() == ctx.accounts.owner.authority;
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    with_pool(
        &ctx.accounts.basket.to_account_info(),
        &ctx.accounts.spill.to_account_info(),
        |pool| {
            t.stage(pool, &mut books, max_ops as usize, owner_signs)
                .map(drop)
                .map_err(ticket_err)
        },
    )?;
    save_ticket(&mut t, &extra);
    books.flush()
}

// ---------------------------------------------------------------------------------------------
// Cancel and expiry
// ---------------------------------------------------------------------------------------------

/// Starts cancelling a Ticket (the owner at any time; for a Backing Ticket the Backer is the
/// owner; anyone once it expired) and returns up to `max_lines` staged lines, slowest first, to
/// the basket or the spill. Idempotent: anyone may call it again until the Ticket is Cancelled.
#[derive(Accounts)]
pub struct CancelTicket<'info> {
    pub signer: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner.authority.as_ref()],
        bump = owner.bump
    )]
    pub owner: Box<Account<'info, TesoroAccount>>,
    #[account(
        mut,
        seeds = [BASKET_SEED, owner.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, owner.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    /// CHECK: loaded and checked as a Ticket of `owner` by `load_ticket`.
    #[account(mut)]
    pub ticket: UncheckedAccount<'info>,
    /// The Offer of a Backing Ticket: required to finish cancelling one, so the Offer is free again.
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Option<Box<Account<'info, OfferState>>>,
}

pub(crate) fn cancel_ticket<'info>(
    ctx: Context<'_, '_, 'info, 'info, CancelTicket<'info>>,
    max_lines: u8,
) -> Result<()> {
    let ts = now()?;
    let ticket_info = ctx.accounts.ticket.to_account_info();
    let spill_info = ctx.accounts.spill.to_account_info();
    let (mut t, mut extra) = load_ticket(&ticket_info)?;
    require_keys_eq!(
        Pubkey::new_from_array(t.account),
        ctx.accounts.owner.key(),
        MatchError::TicketMismatch
    );
    let by_owner = ctx.accounts.signer.key() == ctx.accounts.owner.authority;
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let done = with_pool(
        &ctx.accounts.basket.to_account_info(),
        &spill_info,
        |pool| {
            t.begin_cancel(pool, ts, by_owner).map_err(ticket_err)?;
            t.cancel_step(pool, &mut books, max_lines as usize)
                .map(|s| s.done)
                .map_err(ticket_err)
        },
    )?;
    if done {
        if t.kind == TicketKind::Backing {
            let offer = ctx
                .accounts
                .offer
                .as_mut()
                .ok_or_else(|| error!(MatchError::BadBacking))?;
            require!(
                offer.inner.backer == ctx.accounts.owner.key().to_bytes()
                    && offer.inner.entry == t.target
                    && offer.inner.game == t.game,
                MatchError::BadBacking
            );
            offer.inner.ticket_open = false;
        }
        let held = extra.spill_room;
        extra.spill_room = 0;
        save_ticket(&mut t, &extra);
        drop(t);
        release_room(&spill_info, held)?;
    } else {
        save_ticket(&mut t, &extra);
    }
    books.flush()
}

// ---------------------------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------------------------

/// Closes a Cancelled Ticket: the rent goes back to the sponsor first (up to what it fronted),
/// the rest to whoever paid. Anyone may call it.
#[derive(Accounts)]
pub struct CloseTicket<'info> {
    pub caller: Signer<'info>,
    /// CHECK: loaded and checked as a Ticket by `load_ticket`.
    #[account(mut)]
    pub ticket: UncheckedAccount<'info>,
    /// CHECK: must be the key that paid; checked against the Ticket.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
}

pub(crate) fn close_ticket(ctx: Context<CloseTicket>) -> Result<()> {
    let info = ctx.accounts.ticket.to_account_info();
    let extra = {
        let (t, x) = load_ticket(&info)?;
        require!(
            t.state == TicketState::Cancelled && t.pages.is_empty(),
            MatchError::TicketNotOpen
        );
        require!(x.spill_room == 0, MatchError::Inconsistent);
        x
    };
    require_keys_eq!(
        extra.payer,
        *ctx.accounts.payer.key,
        TesoroError::InvalidAccount
    );
    close_pot_account(
        &info,
        &ctx.accounts.payer.to_account_info(),
        ctx.accounts.sponsor.as_mut(),
        extra.sponsored_lamports,
    )
}

/// Closes a Ticket or Pot account: rent to the sponsor first (what it fronted), the rest to the
/// payer; the account is handed back to the system program.
pub(crate) fn close_pot_account<'info>(
    info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    sponsor: Option<&mut Account<'info, SponsorState>>,
    sponsored: u64,
) -> Result<()> {
    let total = info.lamports();
    let mut to_payer = total;
    if let Some(sponsor) = sponsor {
        let back = sponsored.min(total);
        if back > 0 {
            move_lamports(info, &sponsor.to_account_info(), back)?;
            sponsor.outstanding = sponsor.outstanding.saturating_sub(back);
            to_payer = total - back;
        }
    } else {
        require!(sponsored == 0, BasketError::SponsorShort);
    }
    move_lamports(info, payer, to_payer)?;
    info.assign(&anchor_lang::system_program::ID);
    info.resize(0)?;
    Ok(())
}
