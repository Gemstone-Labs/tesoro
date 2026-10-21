//! Matches on baskets and Tickets: open, join, start settling or refunding, run the chunks, close.
//!
//! * **Entry.** An entry is the Player's program-chosen draw: the front of the draw order. When it
//!   needs at most `MAX_DIRECT_LINES` lines it is drawn right here (`pot` is a fresh account that
//!   this instruction creates). Otherwise the Player first stages an Entry Ticket (`ticket.rs`)
//!   and `pot` is that complete Ticket: its account becomes the Pot, nothing is copied.
//! * **Backing.** With an accepted Offer the Backer's lines are drawn by the same order (directly
//!   or through a Backing Ticket) and the Player is never debited.
//! * **Ids.** A Match is `["match", opener Account, n]` where `n` is the opener's counter.
//! * **Room.** An entry needs no free slot: each whole line it takes off the pool frees one, and
//!   that slot is held for the line (`MatchState::room`, `room_reserved` in the spill header), so
//!   a refund finds its place however full the Account's stores are. Joining also holds, if it
//!   can, the slots the other side's lines can need (`MatchRecord::room_plan`); credits without
//!   a hold wait for free room like any credit (the chunk reports it, growing a store frees it).
//! * **Settle and refund** start in one atomic step (outcome, fees and plan frozen, receipt
//!   written, records emitted by event-CPI) and run in chunks anyone may call. `close_match`
//!   returns the rents once the run is complete.

use crate::books::OnchainBooks;
use crate::error::{core_err, MatchError, TesoroError};
use crate::instructions::economy::{draw_err, with_pool, with_pool_hold};
use crate::instructions::settlement::ChainSettlement;
use crate::instructions::ticket::{close_pot_account, release_room, ticket_err, try_hold};
use crate::ledger;
use crate::ledger::draw::TicketKind;
use crate::ledger::lifecycle::{
    self, LifecycleError, MatchMeta, MatchRecord, Outcome, Party, RefundBy, RunKind, Stage, Terms,
};
use crate::pots::*;
use crate::state::*;
use crate::storage::*;
use crate::util::*;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Lines an entry may use and still be drawn in one transaction (more needs an Entry Ticket).
/// Moving a line is in-place work (no account per line), so the cap is compute, not transaction
/// size: measured in `tests/integration.rs`, "the per-transaction line cap".
pub const MAX_DIRECT_LINES: usize = 16;
/// Steps one chunk may run.
pub const MAX_CHUNK_STEPS: u8 = 12;
/// A settlement receipt may be closed (rent back) this long after it was written.
pub const RECEIPT_KEEP_SECS: i64 = 14 * 24 * 60 * 60;

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub enum MatchResult {
    /// The entrant who opened the Match wins.
    Opener,
    /// The entrant who joined wins.
    Joiner,
    Draw,
    /// The table committed "started, nobody acted": each side pays the Platform Fee.
    NoShow,
}

pub(crate) fn lc_err(e: LifecycleError) -> Error {
    match e {
        LifecycleError::InvalidStage => core_err(ledger::CoreError::InvalidStatus),
        LifecycleError::Expired => core_err(ledger::CoreError::Expired),
        LifecycleError::NotExpired => core_err(ledger::CoreError::NotExpired),
        LifecycleError::PastAbsoluteDeadline => MatchError::PastAbsoluteDeadline.into(),
        LifecycleError::GameUpgraded => MatchError::GameUpgraded.into(),
        LifecycleError::NotAuthorised => TesoroError::Unauthorized.into(),
        LifecycleError::InvalidEntry => core_err(ledger::CoreError::InvalidEntry),
        LifecycleError::EntryMismatch => core_err(ledger::CoreError::EntryMismatch),
        LifecycleError::SelfMatch => core_err(ledger::CoreError::SelfMatch),
        LifecycleError::InvalidBps => core_err(ledger::CoreError::InvalidBps),
        LifecycleError::FeeTooHigh => core_err(ledger::CoreError::FeeTooHigh),
        LifecycleError::InvalidDeadline => core_err(ledger::CoreError::InvalidDeadline),
        LifecycleError::Math => core_err(ledger::CoreError::Math),
        LifecycleError::Inconsistent(why) => {
            msg!("match inconsistent: {}", why);
            MatchError::Inconsistent.into()
        }
        LifecycleError::MissingAccount => MatchError::AccountMissing.into(),
        LifecycleError::Draw(d) => draw_err(d),
        LifecycleError::Book(b) => core_err(b.into()),
    }
}

/// Whether the Game counts as listed right now, and its deploy slot. A program upgraded since the
/// admin approved it is unlisted. While the admin's listing is in force, a program that cannot be
/// read (closed, wrong accounts) is an error, not "unlisted": otherwise an opener could pass junk
/// to strip the Points from a Match their opponent is about to join.
fn listing(
    record: &GameRecord,
    game_program: &AccountInfo,
    program_data: &AccountInfo,
) -> Result<(bool, u64)> {
    let now = now()?;
    match crate::instructions::registry::read_deploy(game_program, program_data) {
        Ok(deploy) => Ok((record.is_listed(now, Some(deploy.slot)), deploy.slot)),
        Err(_) => {
            require!(record.listed_until <= now, TesoroError::GameProofInvalid);
            Ok((false, 0))
        }
    }
}

/// The slot the Game's build is judged by when a Match settles or is refunded: the Match's own
/// while the build is the one it opened under (including a program only extended), else the
/// current one, which differs. A ProgramData that is not the program's own is refused: it must
/// not read as "the Game was upgraded" and let anyone refund a healthy Match.
fn judged_slot(
    record: &GameRecord,
    m: &MatchState,
    game_program: &AccountInfo,
    program_data: &AccountInfo,
) -> Result<u64> {
    match crate::instructions::registry::read_deploy(game_program, program_data) {
        Ok(deploy) => Ok(if record.same_build(m, deploy.slot) {
            m.inner.deploy_slot
        } else {
            deploy.slot
        }),
        Err(_) => {
            let own_program_data = Pubkey::find_program_address(
                &[game_program.key.as_ref()],
                &crate::registry::LOADER_UPGRADEABLE,
            )
            .0;
            require!(
                game_program.owner != &crate::registry::LOADER_UPGRADEABLE
                    || *program_data.key == own_program_data,
                TesoroError::GameProofInvalid
            );
            Ok(if m.inner.deploy_slot == 0 {
                0
            } else {
                u64::MAX
            })
        }
    }
}

/// Counts a Match started by this opener-to-joiner pair.
fn record_pair(pair: &mut Account<PairState>, bump: u8, payer: Pubkey, now: i64) -> Result<()> {
    if pair.window_start == 0 && pair.count == 0 {
        pair.bump = bump;
        pair.payer = payer;
    }
    require!(pair.record(now), TesoroError::PairLimitReached);
    Ok(())
}

/// Fee terms of a Match. A listed Game whose Studio recipient is Tesoro's own studio pays its
/// Studio Fee into the Source's Studio counter (`studio_owner: None`, cashed in by `cash_in_fee`);
/// any other listed Game's Studio Fee is a Studio-class line in the recipient's basket, and an
/// unlisted Game's is ordinary won Gemas.
fn terms_of(
    config: &Config,
    economy: &EconomyConfig,
    game_record: &GameRecord,
    listed: bool,
) -> Terms {
    let tesoro_own = listed
        && economy.tesoro_studio != Pubkey::default()
        && game_record.studio_recipient == economy.tesoro_studio;
    Terms {
        platform_bps: config.platform_bps,
        studio_bps: game_record.studio_bps,
        studio_owner: (!tesoro_own).then(|| game_record.studio_recipient.to_bytes()),
        studio_priority: listed,
    }
}

/// Checks that `info` is the basket or spill of `owner` (program-owned, writable, PDA of the
/// stored bump).
fn check_store(info: &AccountInfo, seed: &[u8], owner: &Pubkey) -> Result<()> {
    use anchor_lang::Discriminator;
    require_keys_eq!(*info.owner, crate::ID, TesoroError::InvalidAccount);
    require!(info.is_writable, TesoroError::NotWritable);
    let data = info.try_borrow_data()?;
    let disc = if seed == BASKET_SEED {
        BasketHead::DISCRIMINATOR
    } else {
        SpillHead::DISCRIMINATOR
    };
    require!(
        data.len() >= DISC + crate::ledger::line_store::HEADER_LEN && data[..DISC] == *disc,
        TesoroError::InvalidAccount
    );
    let store = crate::ledger::line_store::LineStore::new(&data[DISC..])
        .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require!(
        store.account() == owner.to_bytes(),
        TesoroError::InvalidAccount
    );
    let expected =
        Pubkey::create_program_address(&[seed, owner.as_ref(), &[store.bump()]], &crate::ID)
            .map_err(|_| error!(TesoroError::InvalidAccount))?;
    require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
    Ok(())
}

/// Takes one side's entry out of its funder's pool into a Pot: a complete Ticket is consumed (its
/// account is the Pot), or, when `pot_info` is a fresh address, the entry is drawn right here
/// into a new account. Returns the Pot, the key of its account and who paid its rent.
#[allow(clippy::too_many_arguments)]
fn take_entry<'b, 'info>(
    pot_info: &'b AccountInfo<'info>,
    funder: &Pubkey,
    backing: bool,
    (game, entry, nonce, pot_lines): (&Pubkey, u64, u64, u32),
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    (basket, spill): (&AccountInfo<'info>, &AccountInfo<'info>),
    books: &mut OnchainBooks<'info, 'info>,
) -> Result<(OnchainPot<'b, 'info>, u32)> {
    let fresh = pot_info.owner == &system_program::ID && pot_info.data_is_empty();
    if fresh {
        require!(
            pot_lines >= 1 && (pot_lines as usize) <= MAX_DIRECT_LINES + 2,
            crate::error::BasketError::GrowTooLarge
        );
        let (address, bump) = ticket_address(funder, nonce);
        require_keys_eq!(address, *pot_info.key, MatchError::WrongPot);
        create_pot_account(
            pot_info,
            payer,
            system,
            (funder, nonce, bump),
            pot_lines as usize,
        )?;
        let mut pot = init_pot(pot_info, funder, bump)?;
        let mut hold = 0u32;
        with_pool_hold(basket, spill, &mut hold, |pool| {
            if backing {
                pool.draw_backing_direct_into(books, &mut pot, entry, MAX_DIRECT_LINES)
            } else {
                pool.draw_direct_into(books, &mut pot, entry, MAX_DIRECT_LINES)
            }
            .map_err(ticket_err)
        })?;
        let fields = HeadFields {
            kind: if backing {
                TicketKind::Backing
            } else {
                TicketKind::Entry
            },
            state: crate::ledger::draw::TicketState::Closed,
            storage_reserved: true,
            account: funder.to_bytes(),
            game: game.to_bytes(),
            nonce,
            target: entry,
            expires_at: 0,
            line_cap: pot_lines as usize,
            reserved_left: 0,
        };
        let extra = TicketExtra {
            bump,
            payer: *payer.key,
            spill_room: 0,
            sponsored_lamports: 0,
        };
        init_head(pot.bytes_mut(), &fields, &extra);
        Ok((pot, hold))
    } else {
        let (mut ticket, mut extra) = load_ticket(pot_info)?;
        require_keys_eq!(
            Pubkey::new_from_array(ticket.account),
            *funder,
            MatchError::TicketMismatch
        );
        require!(
            ticket.kind
                == if backing {
                    TicketKind::Backing
                } else {
                    TicketKind::Entry
                },
            MatchError::TicketMismatch
        );
        with_pool(basket, spill, |pool| {
            ticket
                .consume(pool, &game.to_bytes(), entry)
                .map_err(ticket_err)
        })?;
        // the slots the Ticket held for its lines are the Match's now
        let held = extra.spill_room;
        extra.spill_room = 0;
        save_ticket(&mut ticket, &extra);
        Ok((ticket.into_pot(), held))
    }
}

/// Adds `slots` to `account`'s share of the Match's held room.
fn add_hold(room: &mut [RoomHold; ROOM_HOLDS], account: ledger::Key, slots: u32) -> Result<()> {
    if slots == 0 {
        return Ok(());
    }
    let at = room
        .iter()
        .position(|h| h.account == account)
        .or_else(|| room.iter().position(|h| h.account == [0u8; 32]))
        .ok_or_else(|| error!(MatchError::Inconsistent))?;
    room[at].account = account;
    room[at].left = room[at]
        .left
        .checked_add(slots)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    Ok(())
}

/// The basket of `owner` among `infos`, if the caller passed it.
fn basket_among<'info>(infos: &[AccountInfo<'info>], owner: &Pubkey) -> Option<AccountInfo<'info>> {
    infos
        .iter()
        .find(|i| check_store(i, BASKET_SEED, owner).is_ok())
        .cloned()
}

/// The spill of `owner` among `infos`, if the caller passed it.
fn spill_among<'info>(infos: &[AccountInfo<'info>], owner: &Pubkey) -> Option<AccountInfo<'info>> {
    infos
        .iter()
        .find(|i| check_store(i, SPILL_SEED, owner).is_ok())
        .cloned()
}

/// Holds, where the caller passed the stores and the room is there, the slots the credits the
/// Match can still make to each Account can need (`plan`), on top of what the Account already
/// holds. All or nothing per Account; whatever is not held waits for free room when the time
/// comes.
fn top_up_holds(
    room: &mut [RoomHold; ROOM_HOLDS],
    plan: &std::collections::BTreeMap<ledger::Key, usize>,
    stores: &[AccountInfo],
) -> Result<()> {
    for (account, want) in plan {
        let have = room
            .iter()
            .find(|h| h.account == *account)
            .map_or(0, |h| h.left as usize);
        if *want <= have {
            continue;
        }
        let owner = Pubkey::new_from_array(*account);
        let (Some(basket), Some(spill)) =
            (basket_among(stores, &owner), spill_among(stores, &owner))
        else {
            continue;
        };
        let extra = (*want - have) as u32;
        if try_hold(&basket, &spill, extra)? {
            add_hold(room, *account, extra)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------------------------

/// Opens a Match. `pot` is either a fresh address (the entry is drawn here into a new account of
/// `pot_lines` lines, address `["ticket", funder, pot_nonce]`) or a complete Entry Ticket (a
/// Backing Ticket when the entry is backed). With an accepted `offer` the Backer funds the entry.
/// `payer` pays the Match's and the Pot's rent, refunded when the Match closes.
#[derive(Accounts)]
#[instruction(game: Pubkey, entry: u64, n: u64, pot_nonce: u64, challenge: bool, asset: u8, pot_lines: u32)]
pub struct OpenMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub player_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(seeds = [GAME_SEED, game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program; the loader state is read by `listing`.
    #[account(address = game)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `listing` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
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
        init,
        payer = payer,
        space = MatchState::SPACE,
        seeds = [MATCH_SEED, player_account.key().as_ref(), &n.to_le_bytes()],
        bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    /// The accepted Offer, when the entry is backed.
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Option<Box<Account<'info, OfferState>>>,
    pub backer_account: Option<Box<Account<'info, TesoroAccount>>>,
    #[account(mut)]
    pub backer_counters: Option<Account<'info, AccountCounters>>,
    /// CHECK: the Backer's Protections address; a Backer who is away cannot fund a Match.
    pub backer_protections: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's basket, checked by `check_store`.
    #[account(mut)]
    pub backer_basket: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's spill, checked by `check_store`.
    #[account(mut)]
    pub backer_spill: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

/// The Backer's side of a backed entry, checked against the Offer.
struct Backer<'a, 'info> {
    account: &'a Account<'info, TesoroAccount>,
    counters: &'a mut Account<'info, AccountCounters>,
    protections: &'a AccountInfo<'info>,
    basket: AccountInfo<'info>,
    spill: AccountInfo<'info>,
}

fn counters_pda(account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[COUNTERS_SEED, account.as_ref()], &crate::ID).0
}

fn protections_pda(account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PROTECTIONS_SEED, account.as_ref()], &crate::ID).0
}

#[allow(clippy::too_many_arguments)]
fn backer_side<'a, 'info>(
    offer: &'a Option<Box<Account<'info, OfferState>>>,
    account: &'a Option<Box<Account<'info, TesoroAccount>>>,
    counters: &'a mut Option<Account<'info, AccountCounters>>,
    protections: &'a Option<UncheckedAccount<'info>>,
    basket: &'a Option<UncheckedAccount<'info>>,
    spill: &'a Option<UncheckedAccount<'info>>,
) -> Result<Backer<'a, 'info>> {
    let offer = offer
        .as_ref()
        .ok_or_else(|| error!(MatchError::BadBacking))?;
    let account = account
        .as_ref()
        .ok_or_else(|| error!(MatchError::BadBacking))?;
    let counters = counters
        .as_mut()
        .ok_or_else(|| error!(MatchError::BadBacking))?;
    let protections = protections
        .as_ref()
        .ok_or_else(|| error!(MatchError::BadBacking))?;
    let basket = basket
        .as_ref()
        .ok_or_else(|| error!(MatchError::BadBacking))?;
    let spill = spill
        .as_ref()
        .ok_or_else(|| error!(MatchError::BadBacking))?;
    let key = account.key();
    require!(
        key.to_bytes() == offer.inner.backer
            && Pubkey::find_program_address(
                &[ACCOUNT_SEED, account.authority.as_ref()],
                &crate::ID
            )
            .0 == key
            && counters.key() == counters_pda(&key)
            && protections.key() == protections_pda(&key),
        MatchError::BadBacking
    );
    check_store(&basket.to_account_info(), BASKET_SEED, &key)?;
    check_store(&spill.to_account_info(), SPILL_SEED, &key)?;
    Ok(Backer {
        account,
        counters,
        protections: protections.as_ref(),
        basket: basket.to_account_info(),
        spill: spill.to_account_info(),
    })
}

pub(crate) fn open_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenMatch<'info>>,
    game: Pubkey,
    entry: u64,
    n: u64,
    pot_nonce: u64,
    challenge: bool,
    asset: u8,
    pot_lines: u32,
) -> Result<()> {
    let ts = now()?;
    let (listed, deploy_slot) = listing(
        &ctx.accounts.game_record,
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    let player = ctx.accounts.player_account.key();
    // a backed Player puts none of their own Gemas at risk: nothing counts against their limit
    // (the Backer's limit counted the entry when the Offer was made)
    if ctx.accounts.offer.is_none() {
        count_entry(&ctx.accounts.protections.to_account_info(), entry)?;
    }
    {
        let counters = &mut ctx.accounts.counters;
        if counters.bump == 0 {
            counters.bump = ctx.bumps.counters;
        }
        require!(n == counters.next_match, MatchError::TicketMismatch);
        require!(
            counters.open_matches < MAX_OPEN_MATCHES,
            MatchError::TooManyOpenMatches
        );
        counters.next_match = n.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
        counters.open_matches += 1;
    }
    let backed = ctx.accounts.offer.is_some();
    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let payer = ctx.accounts.payer.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();
    let pot_info = ctx.accounts.pot.to_account_info();
    let own_basket = ctx.accounts.basket.to_account_info();
    let own_spill = ctx.accounts.spill.to_account_info();

    let (party, pot, hold) = if backed {
        require!(listed, TesoroError::GameNotListed);
        crate::util::require_can_play(&ctx.accounts.protections.to_account_info())?;
        let offer = ctx
            .accounts
            .offer
            .as_mut()
            .ok_or(error!(crate::error::MatchError::BadBacking))?;
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
        let (pot, hold) = take_entry(
            &pot_info,
            &funder,
            true,
            (&game, entry, pot_nonce, pot_lines),
            &payer,
            &system,
            (&backer.basket, &backer.spill),
            &mut books,
        )?;
        (
            Party {
                player: player.to_bytes(),
                funder: funder.to_bytes(),
                share_bps: share,
            },
            pot,
            hold,
        )
    } else {
        require_can_play(&ctx.accounts.protections.to_account_info())?;
        let (pot, hold) = take_entry(
            &pot_info,
            &player,
            false,
            (&game, entry, pot_nonce, pot_lines),
            &payer,
            &system,
            (&own_basket, &own_spill),
            &mut books,
        )?;
        (
            Party {
                player: player.to_bytes(),
                funder: player.to_bytes(),
                share_bps: 0,
            },
            pot,
            hold,
        )
    };
    let (entries, terms) = {
        let config = &ctx.accounts.config;
        (
            config.entries(),
            terms_of(
                config,
                &ctx.accounts.economy,
                &ctx.accounts.game_record,
                listed,
            ),
        )
    };
    let rec = MatchRecord::open(
        lifecycle::MatchId {
            opener: player.to_bytes(),
            n,
        },
        MatchMeta {
            challenge,
            asset,
            listed,
        },
        game.to_bytes(),
        ctx.accounts.game_record.settle_authority.to_bytes(),
        deploy_slot,
        terms,
        entry,
        &entries,
        party,
        &pot,
        ts,
    )
    .map_err(lc_err)?;
    let state = &mut ctx.accounts.match_state;
    state.bump = ctx.bumps.match_state;
    state.inner = rec;
    state.listed = listed;
    state.listing_epoch = ctx.accounts.game_record.listing_epoch;
    state.payer = payer.key();
    state.pots = [pot_info.key(), Pubkey::default()];
    // the slots the entry freed stay held for the lines that may come back
    state.room = [RoomHold::default(); ROOM_HOLDS];
    add_hold(&mut state.room, party.funder, hold)?;
    drop(pot);
    books.flush()
}

// ---------------------------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------------------------

/// Joins an Open Match with an equal entry (see `OpenMatch` for `pot`). The opener's two spills
/// (the Player's and the funder's, the same account passed twice when they are one) take the extra
/// room the joiner's lines add.
#[derive(Accounts)]
#[instruction(pot_nonce: u64, pot_lines: u32)]
pub struct JoinMatch<'info> {
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
            match_state.inner.id.opener.as_ref(),
            &match_state.inner.id.n.to_le_bytes()
        ],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    /// CHECK: the opener's Protections address; nobody joins a Match whose opener is away.
    #[account(
        seeds = [PROTECTIONS_SEED, match_state.inner.a.player.as_ref()],
        bump
    )]
    pub opener_protections: UncheckedAccount<'info>,
    /// CHECK: the opener Player's basket, checked by `check_store`.
    #[account(mut)]
    pub opener_basket: UncheckedAccount<'info>,
    /// CHECK: the opener Player's spill, checked by `check_store`.
    #[account(mut)]
    pub opener_spill: UncheckedAccount<'info>,
    /// CHECK: the opener's funder's basket (the same account as `opener_basket` when unbacked).
    #[account(mut)]
    pub opener_funder_basket: UncheckedAccount<'info>,
    /// CHECK: the opener's funder's spill (the same account as `opener_spill` when unbacked).
    #[account(mut)]
    pub opener_funder_spill: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = PairState::SPACE,
        seeds = [PAIR_SEED, match_state.inner.a.player.as_ref(), player_account.key().as_ref()],
        bump
    )]
    pub pair: Account<'info, PairState>,
    #[account(seeds = [GAME_SEED, match_state.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program the Match was opened for; the loader state is read by `listing`.
    #[account(address = Pubkey::new_from_array(match_state.inner.game))]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData; `listing` derives and checks it.
    pub program_data: UncheckedAccount<'info>,
    /// The accepted Offer, when the entry is backed.
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.inner.backer.as_ref(), &offer.nonce.to_le_bytes()],
        bump = offer.bump
    )]
    pub offer: Option<Box<Account<'info, OfferState>>>,
    pub backer_account: Option<Box<Account<'info, TesoroAccount>>>,
    #[account(mut)]
    pub backer_counters: Option<Account<'info, AccountCounters>>,
    /// CHECK: the Backer's Protections address; a Backer who is away cannot fund a Match.
    pub backer_protections: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's basket, checked by `check_store`.
    #[account(mut)]
    pub backer_basket: Option<UncheckedAccount<'info>>,
    /// CHECK: the Backer's spill, checked by `check_store`.
    #[account(mut)]
    pub backer_spill: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn join_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, JoinMatch<'info>>,
    pot_nonce: u64,
    pot_lines: u32,
) -> Result<()> {
    let ts = now()?;
    let backed = ctx.accounts.offer.is_some();
    let (game, entry, opener_player, opener_funder) = {
        let m = &ctx.accounts.match_state.inner;
        (
            Pubkey::new_from_array(m.game),
            m.entry,
            Pubkey::new_from_array(m.a.player),
            Pubkey::new_from_array(m.a.funder),
        )
    };
    if backed {
        // A backer's Gemas follow only a Game that is still the one the admin approved: if the
        // program was upgraded after the Match opened, the Match is refunded, not joined.
        let (listed, slot) = listing(
            &ctx.accounts.game_record,
            &ctx.accounts.game_program.to_account_info(),
            &ctx.accounts.program_data.to_account_info(),
        )?;
        require!(
            listed
                && ctx.accounts.match_state.listed
                && ctx
                    .accounts
                    .game_record
                    .same_build(&ctx.accounts.match_state, slot),
            TesoroError::GameNotListed
        );
    }
    record_pair(
        &mut ctx.accounts.pair,
        ctx.bumps.pair,
        ctx.accounts.payer.key(),
        ts,
    )?;
    let player = ctx.accounts.player_account.key();
    require_can_play(&ctx.accounts.opener_protections.to_account_info())?;
    if !backed {
        count_entry(&ctx.accounts.protections.to_account_info(), entry)?;
    }
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
    // the opener's stores, to hold the room the joiner's lines can need
    let opener_stores = [
        ctx.accounts.opener_basket.to_account_info(),
        ctx.accounts.opener_spill.to_account_info(),
        ctx.accounts.opener_funder_basket.to_account_info(),
        ctx.accounts.opener_funder_spill.to_account_info(),
    ];
    check_store(&opener_stores[0], BASKET_SEED, &opener_player)?;
    check_store(&opener_stores[1], SPILL_SEED, &opener_player)?;
    check_store(&opener_stores[2], BASKET_SEED, &opener_funder)?;
    check_store(&opener_stores[3], SPILL_SEED, &opener_funder)?;

    let mut books = OnchainBooks::load(ctx.remaining_accounts)?;
    let payer = ctx.accounts.payer.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();
    let pot_info = ctx.accounts.pot.to_account_info();
    let own_basket = ctx.accounts.basket.to_account_info();
    let own_spill = ctx.accounts.spill.to_account_info();
    let (party, pot, hold) = if backed {
        require_can_play(&ctx.accounts.protections.to_account_info())?;
        let offer = ctx
            .accounts
            .offer
            .as_mut()
            .ok_or(error!(crate::error::MatchError::BadBacking))?;
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
        let (pot, hold) = take_entry(
            &pot_info,
            &funder,
            true,
            (&game, entry, pot_nonce, pot_lines),
            &payer,
            &system,
            (&backer.basket, &backer.spill),
            &mut books,
        )?;
        (
            Party {
                player: player.to_bytes(),
                funder: funder.to_bytes(),
                share_bps: share,
            },
            pot,
            hold,
        )
    } else {
        require_can_play(&ctx.accounts.protections.to_account_info())?;
        let (pot, hold) = take_entry(
            &pot_info,
            &player,
            false,
            (&game, entry, pot_nonce, pot_lines),
            &payer,
            &system,
            (&own_basket, &own_spill),
            &mut books,
        )?;
        (
            Party {
                player: player.to_bytes(),
                funder: player.to_bytes(),
                share_bps: 0,
            },
            pot,
            hold,
        )
    };
    let state = &mut ctx.accounts.match_state;
    state.inner.join(party, &pot, ts).map_err(lc_err)?;
    // the joiner's freed slots stay held for the lines that may come back; the slots the other
    // side's lines can need are held too wherever the stores were passed and have the room
    add_hold(&mut state.room, party.funder, hold)?;
    let mut stores: Vec<AccountInfo<'info>> = vec![own_basket.clone(), own_spill.clone()];
    stores.extend(opener_stores);
    stores.extend(
        [&ctx.accounts.backer_basket, &ctx.accounts.backer_spill]
            .into_iter()
            .flatten()
            .map(|a| a.to_account_info()),
    );
    stores.extend(ctx.remaining_accounts.iter().cloned());
    let plan = state.inner.room_plan();
    top_up_holds(&mut state.room, &plan, &stores)?;
    state.pots[1] = pot_info.key();
    drop(pot);
    books.flush()
}

// ---------------------------------------------------------------------------------------------
// Start settling or refunding
// ---------------------------------------------------------------------------------------------

fn kind_code(k: RunKind) -> u8 {
    match k {
        RunKind::Win { .. } => 0,
        RunKind::NoShow => 1,
        RunKind::Draw => 2,
        RunKind::Cancelled => 3,
        RunKind::Abandoned => 4,
        RunKind::GameUpgraded => 5,
        RunKind::ByGame => 6,
    }
}

fn write_receipt(
    receipt: &mut SettlementReceipt,
    bump: u8,
    match_key: Pubkey,
    payer: Pubkey,
    r: lifecycle::Receipt,
) {
    receipt.bump = bump;
    receipt.match_key = match_key;
    receipt.payer = payer;
    receipt.receipt = r;
}

fn started_event(m: &MatchState, kind: RunKind, fees: [u64; 3], ts: i64) -> MatchRunStarted {
    let r = &m.inner;
    let (b_player, b_funder) = r.b.map_or(([0u8; 32], [0u8; 32]), |b| (b.player, b.funder));
    MatchRunStarted {
        opener: Pubkey::new_from_array(r.id.opener),
        n: r.id.n,
        game: Pubkey::new_from_array(r.game),
        kind: kind_code(kind),
        winner: match kind {
            RunKind::Win { winner } => winner,
            _ => 255,
        },
        entry: r.entry,
        fees,
        a_player: Pubkey::new_from_array(r.a.player),
        a_funder: Pubkey::new_from_array(r.a.funder),
        b_player: Pubkey::new_from_array(b_player),
        b_funder: Pubkey::new_from_array(b_funder),
        challenge: r.meta.challenge,
        asset: r.meta.asset,
        opened_at: r.opened_at,
        ts,
    }
}

/// Only a registered Game's authority may settle its Matches. Starting freezes the outcome, the
/// fees and the payout plan, writes the receipt and emits the start record (and, for a win, the
/// `MatchWon` the Season ranking reads). The payouts follow in `match_chunk` calls anyone may
/// make. The Game's deployed build must still be the one the Match opened under (else only a
/// refund can start).
#[event_cpi]
#[derive(Accounts)]
pub struct SettleMatch<'info> {
    pub game_authority: Signer<'info>,
    /// Pays the receipt's rent (refundable to it 14 days later).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [GAME_SEED, match_state.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program; the loader state is read by `judged_slot`.
    #[account(address = Pubkey::new_from_array(match_state.inner.game))]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.inner.id.opener.as_ref(),
            &match_state.inner.id.n.to_le_bytes()
        ],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    #[account(
        init,
        payer = payer,
        space = SettlementReceipt::SPACE,
        seeds = [RECEIPT_SEED, match_state.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, SettlementReceipt>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn settle_match(ctx: Context<SettleMatch>, result: MatchResult) -> Result<()> {
    let ts = now()?;
    let slot = judged_slot(
        &ctx.accounts.game_record,
        &ctx.accounts.match_state,
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    let outcome = match result {
        MatchResult::Opener => Outcome::Winner(0),
        MatchResult::Joiner => Outcome::Winner(1),
        MatchResult::Draw => Outcome::Draw,
        MatchResult::NoShow => Outcome::NoShow,
    };
    let lb = ctx.accounts.config.leaderboard_terms();
    let authority = ctx.accounts.game_authority.key().to_bytes();
    // the record's authority is the Game's at open; the registry may have changed it since, and a
    // change applies only to Matches opened after it
    let receipt = ctx
        .accounts
        .match_state
        .inner
        .start_settle(ts, &authority, slot, outcome, lb.bps)
        .map_err(lc_err)?;
    write_receipt(
        &mut ctx.accounts.receipt,
        ctx.bumps.receipt,
        ctx.accounts.match_state.key(),
        ctx.accounts.payer.key(),
        receipt,
    );
    let m = &ctx.accounts.match_state;
    let run = m
        .inner
        .run()
        .ok_or_else(|| error!(MatchError::Inconsistent))?;
    let fees = run.fees;
    let started = started_event(m, run.kind, fees, ts);
    if let RunKind::Win { winner } = run.kind {
        let r = &m.inner;
        let (side, other) = if winner == 0 {
            (Some(r.a), r.b)
        } else {
            (r.b, Some(r.a))
        };
        if let Some(side) = side {
            emit_cpi!(MatchWon {
                opener: Pubkey::new_from_array(r.id.opener),
                n: r.id.n,
                game: Pubkey::new_from_array(r.game),
                entry: r.entry,
                player: Pubkey::new_from_array(side.player),
                funder: Pubkey::new_from_array(side.funder),
                points: if m.listed {
                    ledger::points_for_win(r.entry)
                } else {
                    0
                },
                pool_fee: fees[2],
                season: ledger::season_at(ts).unwrap_or(0),
                ts,
                loser: Pubkey::new_from_array(other.map_or([0u8; 32], |o| o.player)),
                challenge: r.meta.challenge,
                asset: r.meta.asset,
                opened_at: r.opened_at,
            });
        }
    }
    emit_cpi!(started);
    Ok(())
}

/// Starts refunding an Open or Active Match: every Pot line goes back exactly (the chunks follow).
/// The Game's authority, or the opener of a Match nobody joined, may start it at once; anybody
/// may once the deadline passed, or the Game was redeployed since the Match opened.
#[event_cpi]
#[derive(Accounts)]
pub struct RefundMatch<'info> {
    pub caller: Signer<'info>,
    /// Pays the receipt's rent (refundable to it 14 days later).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [GAME_SEED, match_state.inner.game.as_ref()], bump = game_record.bump)]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the Game program; the loader state is read by `judged_slot`.
    #[account(address = Pubkey::new_from_array(match_state.inner.game))]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.inner.id.opener.as_ref(),
            &match_state.inner.id.n.to_le_bytes()
        ],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    #[account(
        init,
        payer = payer,
        space = SettlementReceipt::SPACE,
        seeds = [RECEIPT_SEED, match_state.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, SettlementReceipt>,
    /// CHECK: the opener's Protections address. Optional: when the opener of a Match nobody joined
    /// is on a Break or Self-Excluded, anyone may refund it at once.
    #[account(
        seeds = [PROTECTIONS_SEED, match_state.inner.a.player.as_ref()],
        bump
    )]
    pub opener_protections: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn refund_match(ctx: Context<RefundMatch>) -> Result<()> {
    let ts = now()?;
    let caller = ctx.accounts.caller.key();
    let slot = judged_slot(
        &ctx.accounts.game_record,
        &ctx.accounts.match_state,
        &ctx.accounts.game_program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
    )?;
    let m = &ctx.accounts.match_state.inner;
    let open = m.stage() == Stage::Open;
    let opener_wallet_account =
        Pubkey::find_program_address(&[ACCOUNT_SEED, caller.as_ref()], &crate::ID).0;
    let by = if caller.to_bytes() == m.settle_authority {
        RefundBy::Game(m.settle_authority)
    } else if open
        && (opener_wallet_account.to_bytes() == m.a.player
            || match &ctx.accounts.opener_protections {
                Some(p) => is_away(&p.to_account_info())?,
                None => false,
            })
    {
        RefundBy::Opener(m.a.player)
    } else {
        RefundBy::Anyone
    };
    let receipt = ctx
        .accounts
        .match_state
        .inner
        .start_refund(ts, by, slot)
        .map_err(lc_err)?;
    write_receipt(
        &mut ctx.accounts.receipt,
        ctx.bumps.receipt,
        ctx.accounts.match_state.key(),
        ctx.accounts.payer.key(),
        receipt,
    );
    let m = &ctx.accounts.match_state;
    let started = started_event(m, receipt.kind, [0; 3], ts);
    emit_cpi!(started);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------------------------

/// Runs up to `max_steps` steps of a Settling or Refunding Match. Anyone may call it, in any
/// order, as often as needed: progress is in the Match record, a finished one does nothing.
/// `remaining_accounts` hold what the steps touch (see `settlement`): the baskets and spills that
/// are credited, the book and pages of each Source, and for fee cuts the Source, its Position and
/// the kind's custody and rate account.
#[event_cpi]
#[derive(Accounts)]
pub struct MatchChunk<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.inner.id.opener.as_ref(),
            &match_state.inner.id.n.to_le_bytes()
        ],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    /// CHECK: side 0's Pot, checked against the Match.
    #[account(mut, address = match_state.pots[0] @ MatchError::WrongPot)]
    pub pot_a: UncheckedAccount<'info>,
    /// CHECK: side 1's Pot, checked against the Match; absent while nobody joined.
    #[account(mut)]
    pub pot_b: Option<UncheckedAccount<'info>>,
}

pub(crate) fn match_chunk<'info>(
    ctx: Context<'_, '_, 'info, 'info, MatchChunk<'info>>,
    max_steps: u8,
) -> Result<()> {
    let steps = max_steps.clamp(1, MAX_CHUNK_STEPS) as u32;
    let a_info = ctx.accounts.pot_a.to_account_info();
    let b_info = ctx.accounts.pot_b.as_ref().map(|p| p.to_account_info());
    let state = &mut ctx.accounts.match_state;
    let (pot_a, _) = load_pot(&a_info)?;
    let pot_b = match (&b_info, state.inner.b.is_some()) {
        (Some(info), true) => {
            require_keys_eq!(*info.key, state.pots[1], MatchError::WrongPot);
            Some(load_pot(info)?.0)
        }
        (None, true) => return err!(MatchError::NotJoined),
        _ => None,
    };
    let mut pots: lifecycle::Pots<AccountWindow> = [Some(pot_a), pot_b];
    let mut settlement = ChainSettlement::load(ctx.remaining_accounts)?;
    settlement.set_holds(&state.room);
    let report = state
        .inner
        .chunk(&mut pots, &mut settlement, steps)
        .map_err(lc_err)?;
    for hold in state.room.iter_mut() {
        if let Some(left) = settlement.hold_of(&hold.account) {
            hold.left = left;
        }
    }
    settlement.finish()?;
    let (opener, n) = (
        Pubkey::new_from_array(state.inner.id.opener),
        state.inner.id.n,
    );
    let kind = state.inner.run().map(|r| kind_code(r.kind)).unwrap_or(0);
    drop(pots);
    emit_cpi!(MatchChunkDone {
        opener,
        n,
        chunk_no: report.chunk_no,
        steps: report.steps,
        done: report.done,
        blocked: report.blocked.is_some(),
    });
    if report.done {
        emit_cpi!(MatchSettled {
            opener,
            n,
            kind,
            chunks: report.chunk_no,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------------------------

/// Closes a finished Match: the Pots must be empty. The rents go back to whoever paid them
/// (sponsor first for a sponsored Pot), the slots held in the spills are released and the
/// players' counts of open Matches go down. Anyone may call it.
///
/// `remaining_accounts`: the spills of the Match's Accounts (opener, opener's funder, joiner,
/// joiner's funder) and the counters of the two Players.
#[derive(Accounts)]
pub struct CloseMatch<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.inner.id.opener.as_ref(),
            &match_state.inner.id.n.to_le_bytes()
        ],
        bump = match_state.bump,
        close = match_payer
    )]
    pub match_state: Box<Account<'info, MatchState>>,
    /// CHECK: whoever paid the Match's rent.
    #[account(mut, address = match_state.payer @ TesoroError::InvalidAccount)]
    pub match_payer: UncheckedAccount<'info>,
    /// CHECK: side 0's Pot, checked against the Match.
    #[account(mut, address = match_state.pots[0] @ MatchError::WrongPot)]
    pub pot_a: UncheckedAccount<'info>,
    /// CHECK: whoever paid side 0's Pot.
    #[account(mut)]
    pub pot_a_payer: UncheckedAccount<'info>,
    /// CHECK: side 1's Pot, checked against the Match.
    #[account(mut)]
    pub pot_b: Option<UncheckedAccount<'info>>,
    /// CHECK: whoever paid side 1's Pot.
    #[account(mut)]
    pub pot_b_payer: Option<UncheckedAccount<'info>>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Option<Account<'info, SponsorState>>,
}

pub(crate) fn close_match<'info>(
    ctx: Context<'_, '_, 'info, 'info, CloseMatch<'info>>,
) -> Result<()> {
    let state = &ctx.accounts.match_state;
    require!(
        state.inner.stage() == Stage::Closed,
        MatchError::MatchNotClosed
    );
    let rec = state.inner.clone();
    // the Pots are empty and go back to their payers
    let pots: [(Option<AccountInfo<'info>>, Option<AccountInfo<'info>>); 2] = [
        (
            Some(ctx.accounts.pot_a.to_account_info()),
            Some(ctx.accounts.pot_a_payer.to_account_info()),
        ),
        (
            ctx.accounts.pot_b.as_ref().map(|p| p.to_account_info()),
            ctx.accounts
                .pot_b_payer
                .as_ref()
                .map(|p| p.to_account_info()),
        ),
    ];
    for (side, (pot, payer)) in pots.iter().enumerate() {
        let Some(pot) = pot else {
            require!(side == 1 && rec.b.is_none(), MatchError::NotJoined);
            continue;
        };
        let payer = payer
            .as_ref()
            .ok_or_else(|| error!(MatchError::AccountMissing))?;
        if side == 1 {
            require_keys_eq!(*pot.key, state.pots[1], MatchError::WrongPot);
        }
        require!(pot_total(pot)? == 0, MatchError::PotNotEmpty);
        let (_, extra) = load_pot(pot)?;
        require_keys_eq!(extra.payer, *payer.key, TesoroError::InvalidAccount);
        close_pot_account(
            pot,
            payer,
            ctx.accounts.sponsor.as_mut(),
            extra.sponsored_lamports,
        )?;
    }
    // the room the Match still held, and the open-Match count of each Player
    let mut players: Vec<ledger::Key> = vec![rec.a.player];
    if let Some(b) = rec.b {
        players.push(b.player);
    }
    let mut owed: Vec<RoomHold> = state.room.iter().filter(|h| h.left > 0).copied().collect();
    let mut counted: Vec<ledger::Key> = Vec::new();
    for info in ctx.remaining_accounts {
        if info.owner != &crate::ID || !info.is_writable {
            continue;
        }
        let (is_spill, is_counters) = {
            let data = info.try_borrow_data()?;
            let has = |d: &[u8]| data.len() >= DISC && data[..DISC] == *d;
            (
                has(<SpillHead as anchor_lang::Discriminator>::DISCRIMINATOR),
                has(<AccountCounters as anchor_lang::Discriminator>::DISCRIMINATOR),
            )
        };
        if is_spill {
            let owner = {
                let d = info.try_borrow_data()?;
                crate::ledger::line_store::LineStore::new(&d[DISC..])
                    .map_err(|_| error!(TesoroError::InvalidAccount))?
                    .account()
            };
            check_store(info, SPILL_SEED, &Pubkey::new_from_array(owner))?;
            if let Some(at) = owed.iter().position(|h| h.account == owner) {
                release_room(info, owed[at].left)?;
                owed.remove(at);
            }
        } else if is_counters {
            let mut c = Account::<AccountCounters>::try_from(info)?;
            for player in &players {
                if c.key() == counters_pda(&Pubkey::new_from_array(*player))
                    && !counted.contains(player)
                {
                    c.open_matches = c.open_matches.saturating_sub(1);
                    counted.push(*player);
                }
            }
            c.exit(&crate::ID)?;
        }
    }
    require!(
        owed.is_empty() && players.iter().all(|k| counted.contains(k)),
        MatchError::AccountMissing
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Receipt, deadline, pair counters
// ---------------------------------------------------------------------------------------------

/// Closes a settlement receipt 14 days after it was written; the rent goes back to whoever paid.
/// A table whose result slot waits for the receipt has long released it by then.
#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        close = payer,
        seeds = [RECEIPT_SEED, receipt.match_key.as_ref()],
        bump = receipt.bump
    )]
    pub receipt: Account<'info, SettlementReceipt>,
    /// CHECK: receives the rent; must be the key that paid it.
    #[account(mut, address = receipt.payer @ TesoroError::InvalidAccount)]
    pub payer: UncheckedAccount<'info>,
}

pub(crate) fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
    require!(
        now()?
            >= ctx
                .accounts
                .receipt
                .receipt
                .at
                .saturating_add(RECEIPT_KEEP_SECS),
        MatchError::ReceiptTooNew
    );
    Ok(())
}

/// A registered Game's authority pushes an Open or Active Match's refund deadline out, so an async
/// Game can outlast the default 1h window (an Open Match waits longer for an opponent too). Never
/// moves it earlier; at most 7 days from now, and never past the absolute deadline (7 days after
/// the Match opened), which nothing moves.
#[derive(Accounts)]
pub struct ExtendMatchDeadline<'info> {
    pub game_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [
            MATCH_SEED,
            match_state.inner.id.opener.as_ref(),
            &match_state.inner.id.n.to_le_bytes()
        ],
        bump = match_state.bump
    )]
    pub match_state: Box<Account<'info, MatchState>>,
}

pub(crate) fn extend_match_deadline(
    ctx: Context<ExtendMatchDeadline>,
    new_deadline: i64,
) -> Result<()> {
    require!(
        ctx.accounts.match_state.inner.settle_authority
            == ctx.accounts.game_authority.key().to_bytes(),
        TesoroError::Unauthorized
    );
    ctx.accounts
        .match_state
        .inner
        .extend_deadline(now()?, new_deadline)
        .map_err(lc_err)
}

/// Returns the rent of a pair counter once its window has ended. Anyone may call; the rent goes
/// back to whoever paid it.
#[derive(Accounts)]
#[instruction(opener: Pubkey, joiner: Pubkey)]
pub struct ClosePair<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        close = payer,
        seeds = [PAIR_SEED, opener.as_ref(), joiner.as_ref()],
        bump = pair.bump
    )]
    pub pair: Account<'info, PairState>,
    /// CHECK: receives the rent; must be the key that paid for the counter.
    #[account(mut, address = pair.payer)]
    pub payer: UncheckedAccount<'info>,
}

pub(crate) fn close_pair(ctx: Context<ClosePair>, _opener: Pubkey, _joiner: Pubkey) -> Result<()> {
    let ended = ctx
        .accounts
        .pair
        .window_start
        .saturating_add(PAIR_WINDOW_SECS);
    require!(now()? >= ended, TesoroError::PairWindowOpen);
    Ok(())
}
