//! Many-seat Matches (ADR 0015): open a car, take a seat, step off, depart, close an empty car.
//! Settling a ride: `many_seat_settle`.
//!
//! * **Accounts.** The Match is a `ManySeatMatch` at `["match", opener, n]` (the opener's
//!   `next_match`, as head-to-head). Seats are in `SeatPage`s `["seat_page", match, page]`, ten
//!   each, created in order by the join that needs one. Each Account in a seat has a `SeatMark`
//!   `["seat", match, account]`: one seat per Account per Match.
//! * **Entry.** A seat's entry is taken exactly as a head-to-head join takes it (`take_entry`: a
//!   direct draw into a fresh Pot, or a complete Entry Ticket), counted against the Entry Limit,
//!   and its room held (`cover_room`) so the lines can always come back.
//! * **Step-off.** Before departure the seat empties at once and the funder's mark carries the
//!   lines home (`return_stepped_off` continues when one transaction cannot move them all). The
//!   Entry Limit and the open-Match count are released at the step-off.
//! * **Backing.** With an accepted Offer of a listed Game the Backer funds the seat (as
//!   `join_match`): the Offer is spent, the Backer's limit counted the entry when it was made,
//!   refunds and the entry go back to the Backer, a place's winnings split by the Offer's share.
//!   The Backer has a seat mark too, so it funds one seat per car and rides in none of it.
//! * **Departure** is the Game's call, with at least the car's minimum seated.

use crate::books::OnchainBooks;
use crate::error::{core_err, seat_err, ManySeatError, MatchError, TesoroError};
use crate::instructions::basket::move_lamports;
use crate::instructions::matching::{
    add_hold, backer_side, check_store, judged_slot_at, lc_err, listing, take_entry, terms_of,
};
use crate::instructions::overflow::cover_room;
use crate::instructions::settlement::ChainSettlement;
use crate::instructions::ticket::{close_pot_account, release_room};
use crate::ledger::lifecycle::{LifecycleError, MatchId, MatchMeta, Settlement};
use crate::ledger::many_seat::{seat_index, ManySeatRecord, SeatFill, SeatState, SEATS_PER_PAGE};
use crate::pots::*;
use crate::state::*;
use crate::storage::*;
use crate::util::*;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::Discriminator;

/// Lines one step-off or return call moves at most. Measured worst case (every line merges into
/// one the funder still holds, each from its own Source): 8 lines 119,828 CU, 16 lines 210,876,
/// so 8 keeps a call under the 140,000 chunk budget (`tests/many_seat`).
pub const MAX_RETURN_LINES: u8 = 8;

#[event]
pub struct ManySeatOpened {
    pub match_state: Pubkey,
    pub game: Pubkey,
    pub entry: u64,
    pub min_seats: u8,
    pub max_seats: u8,
}

#[event]
pub struct SeatTaken {
    pub match_state: Pubkey,
    pub seat: u8,
    pub player: Pubkey,
    pub funder: Pubkey,
    pub seated: u8,
    pub min_since: i64,
}

#[event]
pub struct SeatSteppedOff {
    pub match_state: Pubkey,
    pub seat: u8,
    pub player: Pubkey,
    pub seated: u8,
    pub min_since: i64,
}

#[event]
pub struct SeatReturned {
    pub match_state: Pubkey,
    pub player: Pubkey,
    pub lines: u8,
    pub done: bool,
}

#[event]
pub struct ManySeatDeparted {
    pub match_state: Pubkey,
    pub seated: u8,
    pub ts: i64,
}

#[event]
pub struct ManySeatClosed {
    pub match_state: Pubkey,
}

/// Funds, allocates and assigns a PDA of this program (lamports someone pre-sent cannot block
/// it), as `overflow::create_record` does.
pub(crate) fn create_pda<'info>(
    info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
    len: usize,
) -> Result<()> {
    let need = Rent::get()?
        .minimum_balance(len)
        .saturating_sub(info.lamports());
    if need > 0 {
        system_program::transfer(
            CpiContext::new(
                system.clone(),
                system_program::Transfer {
                    from: payer.clone(),
                    to: info.clone(),
                },
            ),
            need,
        )?;
    }
    let signer: &[&[&[u8]]] = &[seeds];
    system_program::allocate(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Allocate {
                account_to_allocate: info.clone(),
            },
            signer,
        ),
        len as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Assign {
                account_to_assign: info.clone(),
            },
            signer,
        ),
        &crate::ID,
    )
}

/// Returns an account's rent to `to` and hands it back to the system program.
pub(crate) fn close_to(info: &AccountInfo, to: &AccountInfo) -> Result<()> {
    move_lamports(info, to, info.lamports())?;
    info.assign(&system_program::ID);
    info.resize(0)?;
    Ok(())
}

/// The seat page in `info`'s data: this program's, of a seat page's size and discriminator.
pub(crate) fn page_in<'d>(info: &AccountInfo, data: &'d mut [u8]) -> Result<&'d mut SeatPage> {
    require_keys_eq!(*info.owner, crate::ID, ManySeatError::WrongSeat);
    require!(
        data.len() == SeatPage::SPACE && data[..DISC] == *SeatPage::DISCRIMINATOR,
        ManySeatError::WrongSeat
    );
    Ok(bytemuck::from_bytes_mut(&mut data[DISC..]))
}

/// Writes `mark` into a seat mark account's data (checked by `mark_in` before).
fn write_mark(info: &AccountInfo, mark: &SeatMark) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    *bytemuck::from_bytes_mut::<SeatMark>(&mut data[DISC..SeatMark::SPACE]) = *mark;
    Ok(())
}

/// The mark of seat `seat`'s Backer in the car `match_key`, checked against the seat: this
/// program's mark, naming the car, the seat's funder and the seat, not returning. Only core
/// creates marks, at `["seat", match, account]`, so these fields identify it.
pub(crate) fn funder_mark_of(
    info: &AccountInfo,
    match_key: &Pubkey,
    funder: [u8; 32],
    seat: u8,
) -> Result<SeatMark> {
    let data = info.try_borrow_data()?;
    let mark = *mark_in(info, &data)?;
    require!(
        mark.match_key == match_key.to_bytes()
            && mark.account == funder
            && mark.seat == seat
            && mark.returning == 0,
        ManySeatError::WrongSeat
    );
    Ok(mark)
}

/// The seat mark in `info`'s data: this program's, of a seat mark's size and discriminator.
pub(crate) fn mark_in<'d>(info: &AccountInfo, data: &'d [u8]) -> Result<&'d SeatMark> {
    require_keys_eq!(*info.owner, crate::ID, ManySeatError::WrongSeat);
    require!(
        data.len() == SeatMark::SPACE && data[..DISC] == *SeatMark::DISCRIMINATOR,
        ManySeatError::WrongSeat
    );
    Ok(bytemuck::from_bytes(&data[DISC..]))
}

/// The Match id behind a seed (`MatchId::seed`).
fn id_of_seed(seed: &[u8; 40]) -> MatchId {
    let mut opener = [0u8; 32];
    opener.copy_from_slice(&seed[..32]);
    let mut n = [0u8; 8];
    n.copy_from_slice(&seed[32..]);
    MatchId {
        opener,
        n: u64::from_le_bytes(n),
    }
}

pub(crate) fn is_empty(info: &AccountInfo) -> bool {
    info.owner == &system_program::ID && info.data_is_empty()
}

// ---------------------------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------------------------

/// The Game opens an empty car for `entry` with its seat bounds. The opener's Account names it
/// (`n` is its `next_match`); the opener boards with `join_many_seat_match` like anyone else.
#[derive(Accounts)]
#[instruction(entry: u64, n: u64)]
pub struct OpenManySeatMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub opener_authority: Signer<'info>,
    /// The Game's settle authority (a server key, or the Game's PDA by CPI).
    pub game_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(seeds = [GAME_SEED, game_program.key().as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program; the loader state is read by `listing`.
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `listing` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, opener_authority.key().as_ref()],
        bump = opener_account.bump
    )]
    pub opener_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = AccountCounters::SPACE,
        seeds = [COUNTERS_SEED, opener_account.key().as_ref()],
        bump
    )]
    pub counters: Account<'info, AccountCounters>,
    #[account(
        init,
        payer = payer,
        space = ManySeatMatch::SPACE,
        seeds = [MATCH_SEED, opener_account.key().as_ref(), &n.to_le_bytes()],
        bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_many_seat_match(
    ctx: Context<OpenManySeatMatch>,
    entry: u64,
    n: u64,
    min_seats: u8,
    max_seats: u8,
    asset: u8,
) -> Result<()> {
    let ts = now()?;
    let record = &ctx.accounts.game_record;
    require_keys_eq!(
        ctx.accounts.game_authority.key(),
        record.settle_authority,
        ManySeatError::NotGame
    );
    let (listed, deploy_slot) = listing(
        record,
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    {
        let counters = &mut ctx.accounts.counters;
        if counters.bump == 0 {
            counters.bump = ctx.bumps.counters;
        }
        require!(n == counters.next_match, MatchError::TicketMismatch);
        counters.next_match = n.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    }
    let config = &ctx.accounts.config;
    let terms = terms_of(config, &ctx.accounts.economy, record, listed);
    let rec = ManySeatRecord::open(
        MatchId {
            opener: ctx.accounts.opener_account.key().to_bytes(),
            n,
        },
        MatchMeta {
            challenge: false,
            asset,
            listed,
        },
        (
            ctx.accounts.game_program.key().to_bytes(),
            record.settle_authority.to_bytes(),
            deploy_slot,
        ),
        terms,
        entry,
        &config.entries(),
        (min_seats, max_seats),
        ts,
    )
    .map_err(seat_err)?;
    {
        let mut state = ctx.accounts.match_state.load_init()?;
        state.bump = ctx.bumps.match_state;
        state.inner = rec;
        state.listing_epoch = record.listing_epoch.to_le_bytes();
        state.payer = ctx.accounts.payer.key().to_bytes();
    }
    emit!(ManySeatOpened {
        match_state: ctx.accounts.match_state.key(),
        game: ctx.accounts.game_program.key(),
        entry,
        min_seats,
        max_seats,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------------------------

/// Takes the lowest free seat of `page` (created when it is the car's next page). The entry is
/// taken as `join_match` takes it; `pot` is a fresh address or a complete Entry Ticket (a Backing
/// Ticket when backed). With an accepted `offer` the Backer funds the seat (a listed Game only)
/// and gets a seat mark too: one seat per Account per car, whether it rides or funds.
/// `remaining_accounts`: the books of the Sources the entry draws, and the funder's overflow
/// record for this Match when its stores may be short.
#[derive(Accounts)]
#[instruction(pot_nonce: u64, pot_lines: u32, page: u8)]
pub struct JoinManySeatMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub player_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, player_authority.key().as_ref()],
        bump = player_account.bump
    )]
    pub player_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = AccountCounters::SPACE,
        seeds = [COUNTERS_SEED, player_account.key().as_ref()],
        bump
    )]
    pub counters: Account<'info, AccountCounters>,
    /// CHECK: the Player Account's Protections address; empty when none is set (see `count_entry`).
    #[account(
        mut,
        seeds = [PROTECTIONS_SEED, player_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [BASKET_SEED, player_account.key().as_ref()],
        bump = basket.load()?.raw[STORE_BUMP_AT]
    )]
    pub basket: AccountLoader<'info, BasketHead>,
    #[account(
        mut,
        seeds = [SPILL_SEED, player_account.key().as_ref()],
        bump = spill.load()?.raw[STORE_BUMP_AT]
    )]
    pub spill: AccountLoader<'info, SpillHead>,
    /// CHECK: the Pot, a fresh address or a complete Ticket; checked by `take_entry`.
    #[account(mut)]
    pub pot: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    #[account(seeds = [GAME_SEED, match_state.load()?.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program the car was opened for; its loader state is read.
    #[account(address = Pubkey::new_from_array(match_state.load()?.inner.game))]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `judged_slot_at` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: the seat page `page` of the car; created here when it is the next one.
    #[account(mut, seeds = [SEAT_PAGE_SEED, match_state.key().as_ref(), &[page]], bump)]
    pub seat_page: UncheckedAccount<'info>,
    /// CHECK: the Player's seat mark in this car; must not exist yet, created here.
    #[account(
        mut,
        seeds = [SEAT_SEED, match_state.key().as_ref(), player_account.key().as_ref()],
        bump
    )]
    pub seat_mark: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// The accepted Offer, when the seat is backed.
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Option<Box<Account<'info, OfferState>>>,
    pub backer_account: Option<Box<Account<'info, TesoroAccount>>>,
    #[account(mut)]
    pub backer_counters: Option<Account<'info, AccountCounters>>,
    /// CHECK: the Backer's Protections address; a Backer who is away cannot fund a seat.
    pub backer_protections: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's basket, checked by `check_store`.
    #[account(mut)]
    pub backer_basket: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's spill, checked by `check_store`.
    #[account(mut)]
    pub backer_spill: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's seat mark in this car (`["seat", match, backer]`); must not exist yet,
    /// created here.
    #[account(mut)]
    pub funder_mark: Option<UncheckedAccount<'info>>,
    /// The seat key that plays this seat; the wallet itself when it wants none.
    pub seat_signer: Signer<'info>,
    /// CHECK: the seat key's marker in this car; must not exist yet, created here.
    #[account(
        mut,
        seeds = [SEAT_KEY_SEED, match_state.key().as_ref(), seat_signer.key().as_ref()],
        bump
    )]
    pub seat_key_mark: UncheckedAccount<'info>,
}

/// Refuses a mark that exists: the Account is in a seat of this car, or its lines from a
/// stepped-off seat are still on their way home.
fn require_no_mark(mark_info: &AccountInfo) -> Result<()> {
    if is_empty(mark_info) {
        return Ok(());
    }
    let returning = {
        let data = mark_info.try_borrow_data()?;
        mark_in(mark_info, &data)?.returning != 0
    };
    if returning {
        err!(ManySeatError::StillReturning)
    } else {
        err!(ManySeatError::AlreadySeated)
    }
}

/// Creates the seat mark of `account` for seat `seat` of the car `match_key`.
fn create_mark<'info>(
    mark_info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    (match_key, id): (&Pubkey, &MatchId),
    account: &Pubkey,
    bump: u8,
    seat: u8,
) -> Result<()> {
    create_pda(
        mark_info,
        payer,
        system,
        &[SEAT_SEED, match_key.as_ref(), account.as_ref(), &[bump]],
        SeatMark::SPACE,
    )?;
    let mut data = mark_info.try_borrow_mut_data()?;
    data[..DISC].copy_from_slice(SeatMark::DISCRIMINATOR);
    let mark: &mut SeatMark = bytemuck::from_bytes_mut(&mut data[DISC..SeatMark::SPACE]);
    mark.bump = bump;
    mark.seat = seat;
    mark.match_key = match_key.to_bytes();
    mark.account = account.to_bytes();
    mark.payer = payer.key.to_bytes();
    mark.match_seed = id.seed();
    Ok(())
}

pub(crate) fn join_many_seat_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, JoinManySeatMatch<'info>>,
    pot_nonce: u64,
    pot_lines: u32,
    page: u8,
) -> Result<()> {
    let ts = now()?;
    let match_key = ctx.accounts.match_state.key();
    let player = ctx.accounts.player_account.key();
    let (game, entry, id) = {
        let state = ctx.accounts.match_state.load()?;
        let slot = judged_slot_at(
            &ctx.accounts.game_record,
            (state.inner.deploy_slot(), state.listing_epoch()),
            &ctx.accounts.game_program.to_account_info(),
            &ctx.accounts.program_data.to_account_info(),
        )?;
        require!(slot == state.inner.deploy_slot(), MatchError::GameUpgraded);
        (
            Pubkey::new_from_array(state.inner.game),
            state.inner.entry(),
            state.inner.id(),
        )
    };
    ctx.accounts
        .match_state
        .load_mut()?
        .inner
        .take_seat(ts)
        .map_err(seat_err)?;

    // one seat per Account: the mark must not exist (a returning one waits for its lines)
    let payer = ctx.accounts.payer.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();
    let mark_info = ctx.accounts.seat_mark.to_account_info();
    require_no_mark(&mark_info)?;
    let backed = ctx.accounts.offer.is_some();
    if backed {
        // a Backer's Gemas follow only a Game listed now, listed when the car opened, same build
        let (listed, slot) = listing(
            &ctx.accounts.game_record,
            &ctx.accounts.game_program.to_account_info(),
            &ctx.accounts.program_data.to_account_info(),
        )?;
        let car = ctx.accounts.match_state.load()?;
        require!(
            listed
                && car.inner.meta().listed
                && ctx.accounts.game_record.same_build_at(
                    car.inner.deploy_slot(),
                    car.listing_epoch(),
                    slot
                ),
            TesoroError::GameNotListed
        );
    }

    // one seat per seat key: a key another seat of this car already uses is refused
    let key_info = ctx.accounts.seat_key_mark.to_account_info();
    require!(is_empty(&key_info), MatchError::SeatKeyShared);
    let key_bump = [ctx.bumps.seat_key_mark];
    create_pda(
        &key_info,
        &payer,
        &system,
        &[
            SEAT_KEY_SEED,
            match_key.as_ref(),
            ctx.accounts.seat_signer.key.as_ref(),
            &key_bump,
        ],
        0,
    )?;

    // the page and the lowest free slot in it
    let page_info = ctx.accounts.seat_page.to_account_info();
    let slots = ctx.accounts.match_state.load()?.inner.page_slots(page);
    if is_empty(&page_info) {
        {
            let mut state = ctx.accounts.match_state.load_mut()?;
            require!(
                page == state.inner.pages && slots > 0,
                ManySeatError::BadPage
            );
            state.inner.pages += 1;
        }
        let bump = [ctx.bumps.seat_page];
        create_pda(
            &page_info,
            &payer,
            &system,
            &[SEAT_PAGE_SEED, match_key.as_ref(), &[page], &bump],
            SeatPage::SPACE,
        )?;
        let mut data = page_info.try_borrow_mut_data()?;
        data[..DISC].copy_from_slice(SeatPage::DISCRIMINATOR);
        let p: &mut SeatPage = bytemuck::from_bytes_mut(&mut data[DISC..SeatPage::SPACE]);
        p.match_key = match_key.to_bytes();
        p.payer = payer.key.to_bytes();
        p.bump = ctx.bumps.seat_page;
        p.index = page;
    }
    let slot = {
        let mut data = page_info.try_borrow_mut_data()?;
        let p = page_in(&page_info, &mut data)?;
        require!(
            p.match_key == match_key.to_bytes(),
            ManySeatError::WrongSeat
        );
        p.seats[..slots]
            .iter()
            .position(|s| s.state() == SeatState::Empty)
            .ok_or_else(|| error!(ManySeatError::PageFull))?
    };
    let seat = seat_index(page, slot);

    // Protections and the Entry Limit, then the open-Match count. A backed Player puts none of
    // their own Gemas at risk: the Backer's limit counted the entry when the Offer was made.
    let counted = if backed {
        require_can_play(&ctx.accounts.protections.to_account_info())?;
        None
    } else {
        count_entry(&ctx.accounts.protections.to_account_info(), entry)?
    };
    {
        let counters = &mut ctx.accounts.counters;
        if counters.bump == 0 {
            counters.bump = ctx.bumps.counters;
        }
        require!(
            counters.open_matches < MAX_OPEN_MATCHES,
            MatchError::TooManyOpenMatches
        );
        counters.open_matches += 1;
    }

    // the entry, from the Player or the Backer
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let pot_info = ctx.accounts.pot.to_account_info();
    let (funder, share_bps, stores, pot, freed) = if backed {
        let offer = ctx
            .accounts
            .offer
            .as_mut()
            .ok_or_else(|| error!(MatchError::BadBacking))?;
        offer
            .inner
            .consume(player.to_bytes(), game.to_bytes(), entry, ts)
            .map_err(core_err)?;
        let share = offer.inner.player_share_bps;
        let backer = backer_side(
            &ctx.accounts.offer,
            &ctx.accounts.backer_account,
            &mut ctx.accounts.backer_counters,
            &ctx.accounts.backer_protections,
            &ctx.accounts.backer_basket,
            &ctx.accounts.backer_spill,
        )?;
        require_can_play(backer.protections)?;
        backer.counters.open_offers = backer.counters.open_offers.saturating_sub(1);
        let funder = backer.account.key();
        let backer_bump = backer.counters.bump;
        let (pot, freed) = take_entry(
            &pot_info,
            &funder,
            true,
            (&game, entry, pot_nonce, pot_lines),
            (backer.counters, backer_bump),
            &payer,
            &system,
            (&backer.basket, &backer.spill),
            &mut books,
        )?;
        (funder, share, [backer.basket, backer.spill], pot, freed)
    } else {
        let stores = [
            ctx.accounts.basket.to_account_info(),
            ctx.accounts.spill.to_account_info(),
        ];
        let counters_bump = ctx.bumps.counters;
        let (pot, freed) = take_entry(
            &pot_info,
            &player,
            false,
            (&game, entry, pot_nonce, pot_lines),
            (&mut ctx.accounts.counters, counters_bump),
            &payer,
            &system,
            (&stores[0], &stores[1]),
            &mut books,
        )?;
        (player, 0, stores, pot, freed)
    };
    let lines = u32::try_from(pot.len()).map_err(|_| ProgramError::ArithmeticOverflow)?;
    drop(pot);
    // the slots the entry freed stay held for its lines; the split part of a line freed none, so
    // hold one more, or else the funder's overflow record for this Match takes it
    let mut room = [RoomHold::default(); ROOM_HOLDS];
    add_hold(&mut room, funder.to_bytes(), freed)?;
    let plan = std::collections::BTreeMap::from([(funder.to_bytes(), lines as usize)]);
    cover_room(
        &mut room,
        &plan,
        &stores,
        ctx.remaining_accounts,
        &id,
        &payer,
        &system,
        None,
    )?;
    let hold = room
        .iter()
        .find(|h| h.account == funder.to_bytes())
        .map_or(0, |h| h.left);

    {
        let mut data = page_info.try_borrow_mut_data()?;
        let p = page_in(&page_info, &mut data)?;
        p.seats[slot].fill(&SeatFill {
            player: player.to_bytes(),
            funder: funder.to_bytes(),
            signer: ctx.accounts.seat_signer.key().to_bytes(),
            share_bps,
            pot: pot_info.key.to_bytes(),
            pot_lines: lines,
            hold,
            counted: counted.map(|period| (entry, period)),
        });
    }

    create_mark(
        &mark_info,
        &payer,
        &system,
        (&match_key, &id),
        &player,
        ctx.bumps.seat_mark,
        seat,
    )?;
    if backed {
        // the Backer's mark: it funds no other seat and rides in none of this car
        let info = ctx
            .accounts
            .funder_mark
            .as_ref()
            .ok_or_else(|| error!(MatchError::BadBacking))?
            .to_account_info();
        let (key, bump) = Pubkey::find_program_address(
            &[SEAT_SEED, match_key.as_ref(), funder.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(key, *info.key, ManySeatError::WrongSeat);
        require_no_mark(&info)?;
        create_mark(
            &info,
            &payer,
            &system,
            (&match_key, &id),
            &funder,
            bump,
            seat,
        )?;
    }
    books.flush()?;
    let (seated, min_since) = {
        let car = ctx.accounts.match_state.load()?;
        (car.inner.seated, car.inner.min_since())
    };
    emit!(SeatTaken {
        match_state: match_key,
        seat,
        player,
        funder,
        seated,
        min_since,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Step off and return
// ---------------------------------------------------------------------------------------------

/// The accounts a return moves lines with: the Pot, who gets its rent, the sponsor.
struct ReturnAccounts<'a, 'info> {
    pot: &'a AccountInfo<'info>,
    pot_payer: &'a AccountInfo<'info>,
    sponsor: Option<&'a mut Account<'info, SponsorState>>,
    mark_info: &'a AccountInfo<'info>,
    mark_payer: &'a AccountInfo<'info>,
}

/// Moves up to `max_lines` of the mark's Pot lines (the last first) back to the funder, the
/// mark's hold first and the funder's overflow record for this Match when the stores are full.
/// When the Pot is empty it is closed, the hold left over is released and the mark closed.
/// Returns the lines moved and whether it is done. A line that cannot be placed stops the call;
/// the error is returned only when nothing moved.
fn return_lines<'info>(
    mark: &mut SeatMark,
    a: ReturnAccounts<'_, 'info>,
    remaining: &'info [AccountInfo<'info>],
    max_lines: u8,
) -> Result<(u8, bool)> {
    let max = max_lines.clamp(1, MAX_RETURN_LINES);
    require!(a.pot.key.to_bytes() == mark.pot, ManySeatError::WrongSeat);
    let funder = mark.funder;
    let (moved, left, extra) = {
        let (mut pot, extra) = load_pot(a.pot)?;
        require!(pot.owner() == funder, ManySeatError::WrongSeat);
        let mut settlement = ChainSettlement::load(remaining)?;
        settlement.set_holds(&[RoomHold {
            account: funder,
            left: mark.hold(),
        }]);
        settlement.set_match(&id_of_seed(&mark.match_seed));
        let mut moved = 0u8;
        while moved < max {
            let Some(line) = pot.last_line() else { break };
            match settlement.credit(&funder, &line) {
                Ok(_) => {}
                Err(e) if moved > 0 => {
                    msg!("return stopped: {:?}", e);
                    break;
                }
                Err(e) => return Err(lc_err(e)),
            }
            pot.pop_last()
                .map_err(|e| lc_err(LifecycleError::Draw(e)))?;
            moved += 1;
        }
        mark.set_hold(settlement.hold_of(&funder).unwrap_or(0));
        settlement.finish()?;
        (moved, pot.len(), extra)
    };
    if left > 0 {
        return Ok((moved, false));
    }
    require_keys_eq!(extra.payer, *a.pot_payer.key, TesoroError::InvalidAccount);
    close_pot_account(a.pot, a.pot_payer, a.sponsor, extra.sponsored_lamports)?;
    if mark.hold() > 0 {
        let funder = Pubkey::new_from_array(funder);
        let spill = remaining
            .iter()
            .find(|i| check_store(i, SPILL_SEED, &funder).is_ok())
            .ok_or_else(|| error!(MatchError::AccountMissing))?;
        release_room(spill, mark.hold())?;
        mark.set_hold(0);
    }
    require!(
        a.mark_payer.key.to_bytes() == mark.payer,
        TesoroError::InvalidAccount
    );
    close_to(a.mark_info, a.mark_payer)?;
    Ok((moved, true))
}

/// Steps the Player off seat `seat` before departure: the seat is free at once, the Entry Limit
/// and the open-Match count are released, and up to `max_lines` of the entry's lines go back in
/// this transaction (`return_stepped_off` moves the rest). Signed by the seat's Player, the
/// Game's authority, or anyone when the Player is on a Break or Self-Excluded, when boarding has
/// ended, or when the Game's build changed since the car opened (the Game accounts passed).
///
/// On a backed seat the Player's mark closes at once (the Player may board again) and the
/// Backer's mark (`funder_mark`) carries the Backer's lines home. The Offer stays used: a Backing
/// is spent when its Match is entered, and every refund goes to the Backer.
///
/// `remaining_accounts`: the funder's basket and spill, the books of the lines' Sources, and the
/// funder's overflow record for this Match if it has one.
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct StepOffManySeatMatch<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    #[account(
        mut,
        seeds = [
            SEAT_PAGE_SEED,
            match_state.key().as_ref(),
            &[seat / SEATS_PER_PAGE as u8]
        ],
        bump = seat_page.load()?.bump
    )]
    pub seat_page: AccountLoader<'info, SeatPage>,
    #[account(
        mut,
        seeds = [SEAT_SEED, match_state.key().as_ref(), seat_mark.load()?.account.as_ref()],
        bump = seat_mark.load()?.bump
    )]
    pub seat_mark: AccountLoader<'info, SeatMark>,
    /// CHECK: receives the mark's rent once the lines are home; checked against the mark.
    #[account(mut)]
    pub mark_payer: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [COUNTERS_SEED, seat_mark.load()?.account.as_ref()],
        bump = player_counters.bump
    )]
    pub player_counters: Account<'info, AccountCounters>,
    /// CHECK: the Player's Protections address (seeds from the seat's Player).
    #[account(
        mut,
        seeds = [PROTECTIONS_SEED, seat_mark.load()?.account.as_ref()],
        bump
    )]
    pub player_protections: UncheckedAccount<'info>,
    /// CHECK: the seat's Pot, checked against the seat.
    #[account(mut)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: whoever paid the Pot; checked against its head.
    #[account(mut)]
    pub pot_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
    #[account(seeds = [GAME_SEED, match_state.load()?.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Option<Box<Account<'info, GameRecord>>>,
    /// CHECK: the Game program the car was opened for.
    #[account(address = Pubkey::new_from_array(match_state.load()?.inner.game))]
    pub game_program: Option<UncheckedAccount<'info>>,
    /// CHECK: the program's ProgramData; `judged_slot_at` derives and checks it.
    pub program_data: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's mark of a backed seat (`funder_mark_of`); it carries the lines home.
    #[account(mut)]
    pub funder_mark: Option<UncheckedAccount<'info>>,
    /// CHECK: the seat key's marker, closed here to the mark's payer; checked by seeds against the
    /// seat's key. Absent (empty) for a seat boarded before seat keys.
    #[account(mut)]
    pub seat_key_mark: UncheckedAccount<'info>,
}

pub(crate) fn step_off_many_seat_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, StepOffManySeatMatch<'info>>,
    seat: u8,
    max_lines: u8,
) -> Result<()> {
    let ts = now()?;
    let match_key = ctx.accounts.match_state.key();
    let slot = seat as usize % SEATS_PER_PAGE;
    let s = {
        let p = ctx.accounts.seat_page.load()?;
        require!(
            p.match_key == match_key.to_bytes(),
            ManySeatError::WrongSeat
        );
        p.seats[slot]
    };
    let mut mark = *ctx.accounts.seat_mark.load()?;
    require!(
        s.state() == SeatState::Seated
            && mark.returning == 0
            && mark.seat == seat
            && s.player() == mark.account,
        ManySeatError::WrongSeat
    );

    // who may
    // the car's fields this needs, read in place (the record is large: no copy)
    let (deploy_slot, listing_epoch, settle_authority, boarding_ends, id) = {
        let car = ctx.accounts.match_state.load()?;
        (
            car.inner.deploy_slot(),
            car.listing_epoch(),
            car.inner.settle_authority,
            car.inner.boarding_ends(),
            car.inner.id(),
        )
    };
    let caller = ctx.accounts.caller.key();
    let upgraded = match (
        &ctx.accounts.game_record,
        &ctx.accounts.game_program,
        &ctx.accounts.program_data,
    ) {
        (Some(record), Some(program), Some(data)) => {
            judged_slot_at(
                record,
                (deploy_slot, listing_epoch),
                &program.to_account_info(),
                &data.to_account_info(),
            )? != deploy_slot
        }
        _ => false,
    };
    require!(
        acts_for(
            &Pubkey::new_from_array(s.player()),
            &caller,
            &Pubkey::new_from_array(s.signer()),
        )
            || caller.to_bytes() == settle_authority
            || ts >= boarding_ends
            || upgraded
            || is_away(&ctx.accounts.player_protections.to_account_info())?,
        ManySeatError::NotYourSeat
    );

    // the seat empties; what it counted is released
    let (seated, min_since) = {
        let mut state = ctx.accounts.match_state.load_mut()?;
        state.inner.leave_seat().map_err(seat_err)?;
        (state.inner.seated, state.inner.min_since())
    };
    ctx.accounts.player_counters.open_matches =
        ctx.accounts.player_counters.open_matches.saturating_sub(1);
    if let Some((gemas, period)) = s.counted() {
        release_entry(
            &ctx.accounts.player_protections.to_account_info(),
            gemas,
            period,
        )?;
    }
    ctx.accounts.seat_page.load_mut()?.seats[slot].clear();
    let key_info = ctx.accounts.seat_key_mark.to_account_info();
    let (key_mark, _) = Pubkey::find_program_address(
        &[SEAT_KEY_SEED, match_key.as_ref(), &s.signer()],
        &crate::ID,
    );
    require_keys_eq!(key_mark, *key_info.key, ManySeatError::WrongSeat);
    if !is_empty(&key_info) {
        require!(
            ctx.accounts.mark_payer.key.to_bytes() == mark.payer,
            TesoroError::InvalidAccount
        );
        close_to(&key_info, &ctx.accounts.mark_payer.to_account_info())?;
    }
    let player = Pubkey::new_from_array(mark.account);
    // the mark that carries the lines home: the funder's
    let mark_info = if s.funder() == s.player() {
        ctx.accounts.seat_mark.to_account_info()
    } else {
        let info = ctx
            .accounts
            .funder_mark
            .as_ref()
            .ok_or_else(|| error!(MatchError::AccountMissing))?
            .to_account_info();
        let funder_mark = funder_mark_of(&info, &match_key, s.funder(), seat)?;
        // the Player's mark closes now: the Player may board again at once
        require!(
            ctx.accounts.mark_payer.key.to_bytes() == mark.payer,
            TesoroError::InvalidAccount
        );
        close_to(
            &ctx.accounts.seat_mark.to_account_info(),
            &ctx.accounts.mark_payer.to_account_info(),
        )?;
        mark = funder_mark;
        info
    };
    mark.returning = 1;
    mark.match_seed = id.seed();
    mark.funder = s.funder();
    mark.pot = s.pot();
    mark.set_hold(s.hold());
    emit!(SeatSteppedOff {
        match_state: match_key,
        seat,
        player,
        seated,
        min_since,
    });

    let (lines, done) = return_lines(
        &mut mark,
        ReturnAccounts {
            pot: &ctx.accounts.pot.to_account_info(),
            pot_payer: &ctx.accounts.pot_payer.to_account_info(),
            sponsor: ctx.accounts.sponsor.as_mut(),
            mark_info: &mark_info,
            mark_payer: &ctx.accounts.mark_payer.to_account_info(),
        },
        ctx.remaining_accounts,
        max_lines,
    )?;
    if !done {
        write_mark(&mark_info, &mark)?;
    }
    emit!(SeatReturned {
        match_state: match_key,
        player: Pubkey::new_from_array(mark.account),
        lines,
        done,
    });
    Ok(())
}

/// Moves up to `max_lines` more lines of a stepped-off seat back to its funder, in any stage of
/// the car (also after it closed). Anyone may call it; it closes the Pot and the mark at the end.
#[derive(Accounts)]
pub struct ReturnSteppedOff<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            SEAT_SEED,
            seat_mark.load()?.match_key.as_ref(),
            seat_mark.load()?.account.as_ref()
        ],
        bump = seat_mark.load()?.bump,
        constraint = seat_mark.load()?.returning != 0 @ ManySeatError::WrongSeat
    )]
    pub seat_mark: AccountLoader<'info, SeatMark>,
    /// CHECK: receives the mark's rent once the lines are home; checked against the mark.
    #[account(mut)]
    pub mark_payer: UncheckedAccount<'info>,
    /// CHECK: the stepped-off seat's Pot, checked against the mark.
    #[account(mut)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: whoever paid the Pot; checked against its head.
    #[account(mut)]
    pub pot_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
}

pub(crate) fn return_stepped_off<'info>(
    ctx: Context<'_, '_, 'info, 'info, ReturnSteppedOff<'info>>,
    max_lines: u8,
) -> Result<()> {
    let mark_info = ctx.accounts.seat_mark.to_account_info();
    let mut mark = *ctx.accounts.seat_mark.load()?;
    let (lines, done) = return_lines(
        &mut mark,
        ReturnAccounts {
            pot: &ctx.accounts.pot.to_account_info(),
            pot_payer: &ctx.accounts.pot_payer.to_account_info(),
            sponsor: ctx.accounts.sponsor.as_mut(),
            mark_info: &mark_info,
            mark_payer: &ctx.accounts.mark_payer.to_account_info(),
        },
        ctx.remaining_accounts,
        max_lines,
    )?;
    if !done {
        *ctx.accounts.seat_mark.load_mut()? = mark;
    }
    emit!(SeatReturned {
        match_state: Pubkey::new_from_array(mark.match_key),
        player: Pubkey::new_from_array(mark.account),
        lines,
        done,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Depart, close
// ---------------------------------------------------------------------------------------------

/// The Game ends boarding: the seats taken now are the ride. Refused below the car's minimum,
/// once boarding has ended, and when the Game's build changed since the car opened.
#[derive(Accounts)]
pub struct DepartManySeatMatch<'info> {
    pub game_authority: Signer<'info>,
    #[account(seeds = [GAME_SEED, match_state.load()?.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program the car was opened for; its loader state is read.
    #[account(address = Pubkey::new_from_array(match_state.load()?.inner.game))]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `judged_slot_at` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
}

pub(crate) fn depart_many_seat_match(ctx: Context<DepartManySeatMatch>) -> Result<()> {
    let ts = now()?;
    let (deploy_slot, listing_epoch) = {
        let car = ctx.accounts.match_state.load()?;
        (car.inner.deploy_slot(), car.listing_epoch())
    };
    let slot = judged_slot_at(
        &ctx.accounts.game_record,
        (deploy_slot, listing_epoch),
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    let authority = ctx.accounts.game_authority.key().to_bytes();
    let seated = {
        let mut state = ctx.accounts.match_state.load_mut()?;
        state.inner.depart(ts, &authority, slot).map_err(seat_err)?;
        state.inner.seated
    };
    emit!(ManySeatDeparted {
        match_state: ctx.accounts.match_state.key(),
        seated,
        ts,
    });
    Ok(())
}

/// Closes a car with no seat left: empty before it left, or paid with every seat closed
/// (`close_many_seat`). Its pages and the Match go back to whoever paid them. Anyone may call it.
/// `remaining_accounts`: every seat page in order, each followed by the key that paid it.
#[derive(Accounts)]
pub struct CloseManySeatMatch<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.load()?.inner.opener.as_ref(),
            &match_state.load()?.inner.n
        ],
        bump = match_state.load()?.bump,
        close = match_payer
    )]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    /// CHECK: whoever paid the Match's rent.
    #[account(mut, address = Pubkey::new_from_array(match_state.load()?.payer) @ TesoroError::InvalidAccount)]
    pub match_payer: UncheckedAccount<'info>,
}

pub(crate) fn close_many_seat_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, CloseManySeatMatch<'info>>,
) -> Result<()> {
    let match_key = ctx.accounts.match_state.key();
    let pages = {
        let mut state = ctx.accounts.match_state.load_mut()?;
        state.inner.close_car().map_err(seat_err)?;
        state.inner.pages as usize
    };
    let infos = ctx.remaining_accounts;
    require!(infos.len() == 2 * pages, ManySeatError::PagesMissing);
    for (i, pair) in infos.chunks_exact(2).enumerate() {
        let (page, payer) = (&pair[0], &pair[1]);
        let loader = AccountLoader::<SeatPage>::try_from(page)?;
        let expected = {
            let p = loader.load()?;
            require!(
                p.match_key == match_key.to_bytes() && p.index as usize == i,
                ManySeatError::PagesMissing
            );
            require!(
                p.seats.iter().all(|s| s.state() == SeatState::Empty),
                ManySeatError::NotEmpty
            );
            Pubkey::new_from_array(p.payer)
        };
        require_keys_eq!(expected, *payer.key, TesoroError::InvalidAccount);
        require!(page.is_writable, TesoroError::NotWritable);
        close_to(page, payer)?;
    }
    emit!(ManySeatClosed {
        match_state: match_key,
    });
    Ok(())
}

// A page is created by one system-program call, which caps an account at 10,240 bytes.
const _: () = assert!(SeatPage::SPACE <= 10_240);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_their_declared_sizes() {
        assert_eq!(SeatPage::SPACE, 8 + 72 + 1_920);
        assert_eq!(std::mem::size_of::<SeatPage>(), SeatPage::SPACE - DISC);
        assert_eq!(std::mem::size_of::<SeatMark>(), SeatMark::SPACE - DISC);
        assert_eq!(
            std::mem::size_of::<ManySeatMatch>(),
            ManySeatMatch::SPACE - DISC
        );
    }
}
