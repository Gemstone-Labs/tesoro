//! Railcar: a many-Player Game where the last three Players off share the Pot.
//!
//! A car is a `tesoro_core` many-seat Match (ADR 0015); Railcar decides when it leaves, runs the
//! ride and reports the result. Design and review: `.scratch/railcar/06-ride-decision.md`.
//!
//! * **Base.** `open_car` opens the one boarding car (core's open, signed by Railcar's
//!   `authority` PDA); Players board and step off through core directly. `check_departure` makes
//!   the car leave 30 s after it first held 5 Players (core's `first_min_at`; a step-off never
//!   restarts it), at once at 100, and the moment a 5th boards when fewer were aboard at that
//!   time. `finalize` reads the committed Table and sends core the result.
//! * **Rollup.** A car rides on Table `car_no % tables`, Tables take their cars strictly in order.
//!   `start_ride` copies the seats and asks MagicBlock VRF for one output; the callback keeps it
//!   and the ride it gives in the Table's Vault (a rollup-only account behind a private
//!   permission with no member) and starts the ride clock. `signal` (anyone) and `jump` (a Player)
//!   move the public Tell stage and, from the Impact slot on, end the ride and commit the Table,
//!   paid by the Sponsor. A Jump at or after the Impact slot ends the ride with that Player aboard.
//! * **Brakes (ticket 07).** `bind_brake` hands each seat's private Brake seat to its Player at
//!   the start of the ride; a Player's page sends `tick` instead of `signal`, with `brake` set when
//!   the Player presses it. The Brake schedule lives in the Vault; nothing public changes until
//!   the end, when the draw and every Brake are copied into the Table. Design and review:
//!   `.scratch/railcar/07-brake-decision.md`.
//!
//! Privacy rules this file keeps: nothing derived from the draw is written to the Table except
//! the Tell stage and false screws already passed and, at the end, the ride's end; nothing from
//! the Vault is logged or reaches an error code; `signal` before the Impact succeeds the same way
//! whether or not a stage moved; no error depends on the Vault or a Brake seat, and the work done
//! on them is the same whatever they hold (`ride` module).

pub mod engine;
pub mod ride;
pub mod state;

use anchor_lang::{prelude::*, system_program, Discriminator};
use ephemeral_rollups_sdk::{
    access_control::structs::PERMISSION_SEED,
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    vrf::{
        instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};
use table_kit::{
    create_hidden_seat, create_hidden_seat_keyed, match_state_gone, move_lamports, receipt_at,
    sponsor_can_commit, sponsor_commit, swap_seat_members_keyed, CommitGuard, SeatAccounts,
    SeatKeys, COMMIT_WINDOW_SECS, DELEGATION_PROGRAM,
};
use tesoro_core::{
    ledger::many_seat::{seat_index, ManyStage, Seat, SeatState},
    state::{
        Config as CoreConfig, EconomyConfig, GameRecord, ManySeatMatch, SeatPage, TesoroAccount,
        ACCOUNT_SEED, CONFIG_SEED as CORE_CONFIG_SEED, COUNTERS_SEED, ECONOMY_SEED, GAME_SEED,
    },
    util::acts_for,
};

pub use state::*;

// Placeholder: the real program keypair is an orchestrator hand-off (ticket 15).
declare_id!("DJkNxkAogb32VQm1TQMSVCbzHcaV3SDBy5kBmpqaNHxC");

/// Identity of MagicBlock's TEE validator (devnet), as Block Burst pins it: the validator a
/// delegation names is the only key that can commit state back.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

#[error_code]
pub enum RailcarError {
    #[msg("Only the upgrade authority may do this")]
    NotUpgradeAuthority,
    #[msg("Only the operator may do this")]
    NotOperator,
    #[msg("Invalid configuration")]
    BadConfig,
    #[msg("That Table index is not allowed")]
    BadTableSlot,
    #[msg("Delegation must name the TEE validator")]
    InvalidValidator,
    #[msg("A car is still boarding: board it")]
    CarBoarding,
    #[msg("Not this Table's next car")]
    WrongCar,
    #[msg("The car has not left")]
    NotDeparted,
    #[msg("A seat page of the car is missing")]
    PagesMissing,
    #[msg("Not valid in this phase of the ride")]
    WrongPhase,
    #[msg("The Table has no Vault yet")]
    VaultMissing,
    #[msg("The Table already has its Vault")]
    VaultExists,
    #[msg("No draw request is due")]
    DrawNotDue,
    #[msg("The randomness answer is not for the current request")]
    StaleRequest,
    #[msg("Not a Player of this ride, or not this seat")]
    NotAPlayer,
    #[msg("Already off the car")]
    AlreadyJumped,
    #[msg("The instruction names another car")]
    StaleBinding,
    #[msg("Core has not frozen the Table's previous car yet")]
    PreviousNotFrozen,
    #[msg("Not the car's Table, or the Table has no result for it")]
    BadTable,
    #[msg("The Table's seats differ from the car's")]
    SeatsDiffer,
    #[msg("Core has not frozen this car yet")]
    NotFrozen,
    #[msg("That car may still ride")]
    CannotSkip,
    #[msg("No commit is due")]
    CommitNotDue,
    #[msg("The Sponsor cannot pay a commit")]
    SponsorDry,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The ride is not revealed yet: send reveal_ride first")]
    NotRevealed,
    #[msg("The ride is already revealed")]
    AlreadyRevealed,
}

fn ride_err(e: ride::RideError) -> Error {
    match e {
        ride::RideError::NotAPlayer => error!(RailcarError::NotAPlayer),
        ride::RideError::AlreadyJumped => error!(RailcarError::AlreadyJumped),
        ride::RideError::Math => error!(RailcarError::Overflow),
    }
}

#[event]
pub struct CarOpened {
    pub car_no: u64,
    pub car: Pubkey,
    pub tesoro_match: Pubkey,
    pub table: u16,
}

#[event]
pub struct CarDeparted {
    pub car_no: u64,
    pub tesoro_match: Pubkey,
    pub seated: u8,
}

#[event]
pub struct RideStarted {
    pub car_no: u64,
    pub table: u16,
    pub seated: u8,
}

/// The draw is in and the ride clock runs from `ride_slot`.
#[event]
pub struct RideRunning {
    pub car_no: u64,
    pub ride_slot: u64,
}

#[event]
pub struct Jumped {
    pub car_no: u64,
    /// The core seat index.
    pub seat: u8,
    pub order: u8,
    pub ride_ms: u32,
}

#[event]
pub struct RideOver {
    pub car_no: u64,
    pub outcome: u8,
    pub reason: u8,
    pub over_ms: u32,
}

/// `reveal_ride` published a finished ride for the round history (event-CPI): everything the
/// ride revealed (the draw and every Brake) and every seat, so anyone can name each Player and
/// replay the ride. Keyed like core's Match records (`opener`, `n`).
#[event]
pub struct RideRevealed {
    pub opener: Pubkey,
    pub n: u64,
    pub car_no: u64,
    pub tesoro_match: Pubkey,
    pub outcome: u8,
    pub reason: u8,
    /// The draw; zero when it never came.
    pub draw: [u8; 32],
    pub brakes: Vec<RevealedBrake>,
    pub seats: Vec<RevealedSeat>,
}

/// One seated Player of a finished ride.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RevealedSeat {
    /// The core seat index.
    pub seat: u8,
    /// 0 aboard at Impact, else the place in the Jump order (1 = first off).
    pub order: u8,
    /// Ride ms of the Jump (0 aboard).
    pub jump_ms: u32,
    /// Gemas of the entry the result refunds.
    pub refund: u64,
    /// The Player's core Account.
    pub player: Pubkey,
    /// The Backer who funded a backed seat's entry; none when the Player funded it.
    pub backer: Option<Pubkey>,
    /// A backed seat's Player share of the winnings (the Offer's), in bps.
    pub share_bps: u16,
}

/// Bytes of one `RevealedSeat` at most (a backed seat).
const REVEALED_SEAT_MAX: usize = 1 + 1 + 4 + 8 + 32 + 33 + 2;

/// `RideRevealed` as event-CPI data, written field by field into one buffer of the exact size while `reveal_ride`
/// reads the seats. A 100-seat reveal is up to 8.7 KB (under the 10,240 B CPI data limit) and Anchor's `emit_cpi!`
/// (a doubling buffer, then two copies) would need over three times that of the 32 KB heap.
struct RideReveal {
    data: Vec<u8>,
}

impl RideReveal {
    /// The head, the draw and every Brake; the seats follow with `seat`, in core seat order.
    fn new(opener: &Pubkey, n: u64, car_no: u64, tesoro_match: &Pubkey, t: &Table) -> Result<Self> {
        let seats = &t.seats[..usize::from(t.seated)];
        let brakes = seats.iter().filter(|s| s.brake_ms().is_some()).count();
        let cap = 8
            + 8
            + 32
            + 8
            + 8
            + 32
            + 1
            + 1
            + 32
            + 4
            + brakes * 5
            + 4
            + seats.len() * REVEALED_SEAT_MAX;
        let mut data = Vec::with_capacity(cap);
        data.extend_from_slice(anchor_lang::event::EVENT_IX_TAG_LE);
        data.extend_from_slice(RideRevealed::DISCRIMINATOR);
        opener.serialize(&mut data)?;
        n.serialize(&mut data)?;
        car_no.serialize(&mut data)?;
        tesoro_match.serialize(&mut data)?;
        t.outcome.serialize(&mut data)?;
        t.reason.serialize(&mut data)?;
        t.reveal_draw.serialize(&mut data)?;
        (brakes as u32).serialize(&mut data)?;
        for s in seats {
            if let Some(ms) = s.brake_ms() {
                RevealedBrake { seat: s.seat, ms }.serialize(&mut data)?;
            }
        }
        (seats.len() as u32).serialize(&mut data)?;
        Ok(Self { data })
    }

    fn seat(&mut self, s: &RideSeat, core: &Seat) -> Result<()> {
        let backed = core.funder() != core.player();
        RevealedSeat {
            seat: s.seat,
            order: s.order,
            jump_ms: s.jump_ms(),
            refund: s.refund(),
            player: Pubkey::new_from_array(core.player()),
            backer: backed.then(|| Pubkey::new_from_array(core.funder())),
            share_bps: core.share_bps(),
        }
        .serialize(&mut self.data)?;
        Ok(())
    }

    /// The event-CPI `emit_cpi!` would make, moving the buffer into the instruction.
    fn emit(self, authority: &AccountInfo, bump: u8) -> Result<()> {
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    *authority.key,
                    true,
                ),
            ],
            data: self.data,
        };
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            std::slice::from_ref(authority),
            &[&[b"__event_authority", &[bump]]],
        )
        .map_err(Into::into)
    }
}

/// One Player's Brake, made public with the ride's end.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RevealedBrake {
    /// The core seat index.
    pub seat: u8,
    /// Ride ms of the press.
    pub ms: u32,
}

/// The address of Table `index`.
pub fn table_address(index: u16) -> Pubkey {
    Pubkey::find_program_address(&[TABLE_SEED, &index.to_le_bytes()], &ID).0
}

/// The address of car `car_no`.
pub fn car_address(car_no: u64) -> Pubkey {
    Pubkey::find_program_address(&[CAR_SEED, &car_no.to_le_bytes()], &ID).0
}

/// The address of a Table's Vault.
pub fn vault_address(table: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, table.as_ref()], &ID)
}

/// The address of Table seat `seat`'s Brake seat.
pub fn brake_seat_address(table: &Pubkey, seat: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BRAKE_SEED, table.as_ref(), &[seat]], &ID)
}

/// Whether the core Match in `info` can still take seats: a Boarding car before its boarding
/// ends. A missing, closed or departed car cannot.
fn still_boarding(info: &AccountInfo, now: i64) -> Result<bool> {
    if info.key == &Pubkey::default()
        || info.owner != &tesoro_core::ID
        || info.data_len() != ManySeatMatch::SPACE
    {
        return Ok(false);
    }
    let data = info.try_borrow_data()?;
    if data[..8] != *ManySeatMatch::DISCRIMINATOR {
        return Ok(false);
    }
    let car: &ManySeatMatch = bytemuck::from_bytes(&data[8..ManySeatMatch::SPACE]);
    Ok(car.inner.stage() == ManyStage::Boarding && now < car.inner.boarding_ends())
}

/// Calls `f(core seat index, core seat)` for every seated seat of the car, page by page.
/// Every one of the car's `pages` pages must be among `infos`.
fn for_each_seated(
    infos: &[AccountInfo],
    match_key: &Pubkey,
    pages: u8,
    mut f: impl FnMut(u8, &Seat) -> Result<()>,
) -> Result<()> {
    for p in 0..pages {
        let info = infos
            .iter()
            .find(|i| is_page(i, match_key, p))
            .ok_or_else(|| error!(RailcarError::PagesMissing))?;
        let data = info.try_borrow_data()?;
        let page: &SeatPage = bytemuck::from_bytes(&data[8..SeatPage::SPACE]);
        for (slot, seat) in page.seats.iter().enumerate() {
            if seat.state() == SeatState::Seated {
                f(seat_index(p, slot), seat)?;
            }
        }
    }
    Ok(())
}

/// Core's seat page `p` of the car `match_key` (only core creates pages, at their PDA).
fn is_page(info: &AccountInfo, match_key: &Pubkey, p: u8) -> bool {
    if info.owner != &tesoro_core::ID || info.data_len() != SeatPage::SPACE {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else {
        return false;
    };
    if data[..8] != *SeatPage::DISCRIMINATOR {
        return false;
    }
    let page: &SeatPage = bytemuck::from_bytes(&data[8..SeatPage::SPACE]);
    page.match_key == match_key.to_bytes() && page.index == p
}

/// The core car's pages and seat count, read in place.
fn car_shape(info: &AccountInfo) -> Result<(u8, u8)> {
    require_keys_eq!(*info.owner, tesoro_core::ID, RailcarError::BadTable);
    let data = info.try_borrow_data()?;
    require!(
        data.len() == ManySeatMatch::SPACE && data[..8] == *ManySeatMatch::DISCRIMINATOR,
        RailcarError::BadTable
    );
    let car: &ManySeatMatch = bytemuck::from_bytes(&data[8..ManySeatMatch::SPACE]);
    Ok((car.inner.pages, car.inner.seated))
}

/// The core car's Match id (`opener`, `n`), read in place.
fn car_id(info: &AccountInfo) -> Result<(Pubkey, u64)> {
    require_keys_eq!(*info.owner, tesoro_core::ID, RailcarError::BadTable);
    let data = info.try_borrow_data()?;
    require!(
        data.len() == ManySeatMatch::SPACE && data[..8] == *ManySeatMatch::DISCRIMINATOR,
        RailcarError::BadTable
    );
    let car: &ManySeatMatch = bytemuck::from_bytes(&data[8..ManySeatMatch::SPACE]);
    let id = car.inner.id();
    Ok((Pubkey::new_from_array(id.opener), id.n))
}

/// The car's Table as base holds it (the rollup's last commit), checked to hold this car's
/// finished ride: its PDA by the stored bump, owned by the delegation program or Railcar,
/// `OVER`, this car and Match, `seated` seats.
fn finished_table<'a, 'info>(
    info: &'a AccountInfo<'info>,
    car: &Account<'_, Car>,
    seated: u8,
) -> Result<std::cell::Ref<'a, &'info mut [u8]>> {
    require!(
        info.owner == &DELEGATION_PROGRAM || info.owner == &ID,
        RailcarError::BadTable
    );
    let data = info.try_borrow_data()?;
    require!(
        data.len() == Table::SPACE && data[..8] == *Table::DISCRIMINATOR,
        RailcarError::BadTable
    );
    let t: &Table = bytemuck::from_bytes(&data[8..Table::SPACE]);
    let at =
        Pubkey::create_program_address(&[TABLE_SEED, &car.table.to_le_bytes(), &[t.bump]], &ID)
            .map_err(|_| error!(RailcarError::BadTable))?;
    require_keys_eq!(at, *info.key, RailcarError::BadTable);
    require!(
        t.phase == PHASE_OVER
            && t.car_no() == car.car_no
            && t.car == car.key().to_bytes()
            && t.tesoro_match == car.tesoro_match.to_bytes()
            && t.seated == seated,
        RailcarError::BadTable
    );
    Ok(data)
}

/// Commits the Table to base, paid by the Sponsor. An empty Sponsor leaves the result `dirty`
/// for `commit_table` after a refill instead of reverting the move that ended the ride.
fn commit_table_now<'info>(
    table: &AccountLoader<'info, Table>,
    sponsor: &Account<'info, Sponsor>,
    magic_context: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    fee_vault: &AccountInfo<'info>,
    now: i64,
) -> Result<()> {
    if !sponsor_can_commit(&sponsor.to_account_info()) {
        msg!("sponsor-dry: the result is not committed; refill the Sponsor, then commit_table");
        return Ok(());
    }
    {
        let mut t = table.load_mut()?;
        t.dirty = 0;
        t.commit_tries = t.commit_tries.saturating_add(1);
        t.set_commit_at(now);
    }
    let bump = [sponsor.bump];
    sponsor_commit(
        &sponsor.to_account_info(),
        &[SPONSOR_SEED, &bump],
        magic_context,
        magic_program,
        fee_vault,
        &TEE_VALIDATOR,
        &table.to_account_info(),
    )
}

/// The end of a ride, in the transaction that ended it: the result goes to base.
fn end_ride<'info>(
    table: &AccountLoader<'info, Table>,
    sponsor: &Account<'info, Sponsor>,
    magic: (
        &AccountInfo<'info>,
        &AccountInfo<'info>,
        &AccountInfo<'info>,
    ),
    now: i64,
) -> Result<()> {
    let (car_no, outcome, reason, over_ms) = {
        let t = table.load()?;
        (t.car_no(), t.outcome, t.reason, t.over_ms())
    };
    emit!(RideOver {
        car_no,
        outcome,
        reason,
        over_ms,
    });
    commit_table_now(table, sponsor, magic.0, magic.1, magic.2, now)
}

/// The VRF request for the Table's car: the program chooses the input (Table, car, request
/// number) and the answer is accepted only for this request.
fn draw_request(
    t: &mut Table,
    table: &Pubkey,
    vault: &Pubkey,
    payer: &Pubkey,
    queue: &Pubkey,
    slot: u64,
) -> Result<anchor_lang::solana_program::instruction::Instruction> {
    let nonce = t.vrf_nonce();
    let marker = Table::request_marker(table, nonce);
    t.set_vrf_nonce(nonce.checked_add(1).ok_or(RailcarError::Overflow)?);
    t.set_req_nonce(nonce);
    t.req_pending = 1;
    t.set_req_slot(slot);
    t.req_count = t.req_count.checked_add(1).ok_or(RailcarError::Overflow)?;
    let caller_seed = anchor_lang::solana_program::hash::hashv(&[
        b"tesoro/railcar/draw",
        table.as_ref(),
        &t.car_no().to_le_bytes(),
        &nonce.to_le_bytes(),
    ])
    .to_bytes();
    let meta = |pubkey: Pubkey, is_writable: bool| SerializableAccountMeta {
        pubkey,
        is_signer: false,
        is_writable,
    };
    Ok(create_request_scoped_randomness_ix(
        RequestRandomnessParams {
            payer: *payer,
            oracle_queue: *queue,
            callback_program_id: ID,
            callback_discriminator: instruction::DrawCallback::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![
                meta(*table, true),
                meta(*vault, true),
                meta(marker, false),
            ]),
            ..Default::default()
        },
    ))
}

#[ephemeral]
#[program]
pub mod railcar {
    use super::*;

    // ------------------------------------------------------------------------------------
    // Base: setup
    // ------------------------------------------------------------------------------------

    /// Base, upgrade authority only. Names the operator and the number of Tables; the number is
    /// fixed once the first car opened (a car's Table is `car_no % tables`).
    pub fn set_config(ctx: Context<SetConfig>, operator: Pubkey, tables: u16) -> Result<()> {
        require!(
            operator != Pubkey::default() && (MIN_TABLES..=MAX_TABLES).contains(&tables),
            RailcarError::BadConfig
        );
        let config = &mut ctx.accounts.config;
        require!(
            config.next_car == 0 || config.tables == tables,
            RailcarError::BadConfig
        );
        config.bump = ctx.bumps.config;
        config.operator = operator;
        config.tables = tables;
        Ok(())
    }

    /// Base, operator. Creates Table `index`, funded for its Vault's rent.
    pub fn create_table(ctx: Context<CreateTable>, index: u16) -> Result<()> {
        require!(
            index < ctx.accounts.config.tables,
            RailcarError::BadTableSlot
        );
        ctx.accounts.table.load_init()?.init(ctx.bumps.table, index);
        fund(
            &ctx.accounts.system_program,
            &ctx.accounts.operator,
            &ctx.accounts.table.to_account_info(),
            TABLE_BUFFER_LAMPORTS,
        )
    }

    /// Base, operator. Creates the Sponsor that pays commits; `lamports` is its first balance.
    pub fn create_sponsor(ctx: Context<CreateSponsor>, lamports: u64) -> Result<()> {
        ctx.accounts.sponsor.bump = ctx.bumps.sponsor;
        fund(
            &ctx.accounts.system_program,
            &ctx.accounts.operator,
            &ctx.accounts.sponsor.to_account_info(),
            lamports,
        )
    }

    /// Base, operator. Creates a reserve the operator later empties into the Sponsor.
    pub fn create_fuel(ctx: Context<CreateFuel>, n: u8, lamports: u64) -> Result<()> {
        ctx.accounts.fuel.bump = ctx.bumps.fuel;
        ctx.accounts.fuel.n = n;
        fund(
            &ctx.accounts.system_program,
            &ctx.accounts.operator,
            &ctx.accounts.fuel.to_account_info(),
            lamports,
        )
    }

    /// Base, operator. Delegates a Table to the TEE validator, once.
    pub fn delegate_table(ctx: Context<DelegateTable>, index: u16) -> Result<()> {
        let config = tee_config(&ctx.accounts.validator)?;
        ctx.accounts.delegate_table(
            &ctx.accounts.operator,
            &[TABLE_SEED, &index.to_le_bytes()],
            config,
        )?;
        Ok(())
    }

    /// Base, operator. Delegates the Sponsor, once.
    pub fn delegate_sponsor(ctx: Context<DelegateSponsor>) -> Result<()> {
        let config = tee_config(&ctx.accounts.validator)?;
        ctx.accounts
            .delegate_sponsor(&ctx.accounts.operator, &[SPONSOR_SEED], config)?;
        Ok(())
    }

    /// Base, operator. Delegates a fuel reserve.
    pub fn delegate_fuel(ctx: Context<DelegateFuel>, n: u8) -> Result<()> {
        let config = tee_config(&ctx.accounts.validator)?;
        ctx.accounts
            .delegate_fuel(&ctx.accounts.operator, &[FUEL_SEED, &[n]], config)?;
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // Base: boarding
    // ------------------------------------------------------------------------------------

    /// Base, the opening Player. Opens the next car (core's many-seat open for 500 Gemas, 5 to
    /// 100 seats, signed by Railcar's authority) when no car can still take seats. The opener
    /// boards with core's join like everyone else, in the same transaction.
    pub fn open_car(ctx: Context<OpenCar>, n: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            !still_boarding(&ctx.accounts.boarding_match.to_account_info(), now)?,
            RailcarError::CarBoarding
        );
        let bump = [ctx.bumps.authority];
        let signer: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        tesoro_core::cpi::open_many_seat_match(
            CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::OpenManySeatMatch {
                    payer: ctx.accounts.payer.to_account_info(),
                    opener_authority: ctx.accounts.opener.to_account_info(),
                    game_authority: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.core_config.to_account_info(),
                    economy: ctx.accounts.economy.to_account_info(),
                    game_record: ctx.accounts.game_record.to_account_info(),
                    game_program: ctx.accounts.game_program.to_account_info(),
                    program_data: ctx.accounts.program_data.to_account_info(),
                    opener_account: ctx.accounts.opener_account.to_account_info(),
                    counters: ctx.accounts.counters.to_account_info(),
                    match_state: ctx.accounts.match_state.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                signer,
            ),
            ENTRY_GEMAS,
            n,
            MIN_SEATS,
            MAX_SEATS,
            0,
        )?;
        let config = &mut ctx.accounts.config;
        let car_no = config.next_car;
        let table = u16::try_from(car_no % u64::from(config.tables))
            .map_err(|_| error!(RailcarError::Overflow))?;
        let car = &mut ctx.accounts.car;
        car.bump = ctx.bumps.car;
        car.car_no = car_no;
        car.tesoro_match = ctx.accounts.match_state.key();
        car.table = table;
        car.tables = config.tables;
        car.opened_at = now;
        car.payer = ctx.accounts.payer.key();
        config.next_car = car_no.checked_add(1).ok_or(RailcarError::Overflow)?;
        config.boarding_match = car.tesoro_match;
        emit!(CarOpened {
            car_no,
            car: car.key(),
            tesoro_match: car.tesoro_match,
            table,
        });
        Ok(())
    }

    /// Base, anyone. Makes a Boarding car leave when it is due: at once when full; otherwise 30 s
    /// after it first held 5 Players (a step-off never moves that time), with 5 or more aboard,
    /// so a car short of 5 at that time leaves in the call after a 5th boards. Anything else is a
    /// no-op, so a join's transaction can always carry it.
    pub fn check_departure(ctx: Context<CheckDeparture>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let seated = {
            let m = ctx.accounts.match_state.load()?;
            let r = &m.inner;
            if r.stage() != ManyStage::Boarding || now >= r.boarding_ends() {
                return Ok(());
            }
            let first = r.first_min_at();
            let due = r.seated == r.max_seats
                || (first != 0
                    && r.seated >= r.min_seats
                    && now >= first.saturating_add(COUNTDOWN_SECS));
            if !due {
                return Ok(());
            }
            r.seated
        };
        let bump = [ctx.bumps.authority];
        let signer: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        tesoro_core::cpi::depart_many_seat_match(CpiContext::new_with_signer(
            ctx.accounts.tesoro_program.to_account_info(),
            tesoro_core::cpi::accounts::DepartManySeatMatch {
                game_authority: ctx.accounts.authority.to_account_info(),
                game_record: ctx.accounts.game_record.to_account_info(),
                game_program: ctx.accounts.game_program.to_account_info(),
                program_data: ctx.accounts.program_data.to_account_info(),
                match_state: ctx.accounts.match_state.to_account_info(),
            },
            signer,
        ))?;
        emit!(CarDeparted {
            car_no: ctx.accounts.car.car_no,
            tesoro_match: ctx.accounts.car.tesoro_match,
            seated,
        });
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // Base: the result
    // ------------------------------------------------------------------------------------

    /// Base, anyone. Reads base's committed copy of the car's Table and sends core the result, by
    /// CPI signed by Railcar's authority: the places and early refunds, or a full refund. The
    /// Table must name this car and Match, be over, and hold exactly the car's seated Players.
    /// `remaining_accounts`: every seat page of the car. Closes the car (its job is done).
    pub fn finalize<'info>(ctx: Context<'_, '_, 'info, 'info, Finalize<'info>>) -> Result<()> {
        let car = &ctx.accounts.car;
        let match_key = car.tesoro_match;
        let (pages, seated) = car_shape(&ctx.accounts.match_state.to_account_info())?;
        require!(car.revealed, RailcarError::NotRevealed);
        let result = {
            let info = ctx.accounts.table.to_account_info();
            let data = finished_table(&info, car, seated)?;
            let t: &Table = bytemuck::from_bytes(&data[8..Table::SPACE]);
            let mut n = 0usize;
            for_each_seated(ctx.remaining_accounts, &match_key, pages, |seat, core| {
                let s = t.seats.get(n).ok_or(RailcarError::SeatsDiffer)?;
                require!(
                    s.seat == seat && s.account == core.player(),
                    RailcarError::SeatsDiffer
                );
                n += 1;
                Ok(())
            })?;
            require!(n == usize::from(seated), RailcarError::SeatsDiffer);
            ride::result(t).ok_or(RailcarError::BadTable)?
        };
        let bump = [ctx.bumps.authority];
        let signer: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.tesoro_program.to_account_info(),
            tesoro_core::cpi::accounts::SettleManySeatMatch {
                game_authority: ctx.accounts.authority.to_account_info(),
                payer: ctx.accounts.caller.to_account_info(),
                config: ctx.accounts.core_config.to_account_info(),
                game_record: ctx.accounts.game_record.to_account_info(),
                game_program: ctx.accounts.game_program.to_account_info(),
                program_data: ctx.accounts.program_data.to_account_info(),
                match_state: ctx.accounts.match_state.to_account_info(),
                receipt: ctx.accounts.receipt.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.core_event_authority.to_account_info(),
                program: ctx.accounts.tesoro_program.to_account_info(),
            },
            signer,
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());
        tesoro_core::cpi::settle_many_seat_match(cpi, result)
    }

    /// Base, anyone, once per car, after the rollup committed the car's finished ride and before
    /// `finalize` (which waits for it). Publishes the ride for the round history: the draw, every
    /// Brake, and every seat with its Player, Backer, Offer share, Jump and refund
    /// (`RideRevealed`). Checks the committed Table as `finalize` does. `remaining_accounts`:
    /// every seat page of the car.
    pub fn reveal_ride<'info>(ctx: Context<'_, '_, 'info, 'info, RevealRide<'info>>) -> Result<()> {
        let car = &ctx.accounts.car;
        require!(!car.revealed, RailcarError::AlreadyRevealed);
        let match_key = car.tesoro_match;
        let info = ctx.accounts.match_state.to_account_info();
        let (pages, seated) = car_shape(&info)?;
        let (opener, n) = car_id(&info)?;
        let reveal = {
            let info = ctx.accounts.table.to_account_info();
            let data = finished_table(&info, car, seated)?;
            let t: &Table = bytemuck::from_bytes(&data[8..Table::SPACE]);
            let mut reveal = RideReveal::new(&opener, n, car.car_no, &match_key, t)?;
            let mut k = 0usize;
            for_each_seated(ctx.remaining_accounts, &match_key, pages, |seat, core| {
                let s = t.seats.get(k).ok_or(RailcarError::SeatsDiffer)?;
                require!(
                    s.seat == seat && s.account == core.player(),
                    RailcarError::SeatsDiffer
                );
                reveal.seat(s, core)?;
                k += 1;
                Ok(())
            })?;
            require!(k == usize::from(seated), RailcarError::SeatsDiffer);
            reveal
        };
        ctx.accounts.car.revealed = true;
        reveal.emit(
            &ctx.accounts.event_authority.to_account_info(),
            ctx.bumps.event_authority,
        )
    }

    /// Base, anyone. Closes a car core has frozen (its receipt exists) or closed (an empty car);
    /// the rent goes back to whoever paid it.
    pub fn close_car(ctx: Context<CloseCar>) -> Result<()> {
        let key = ctx.accounts.car.tesoro_match;
        require!(
            receipt_at(&ctx.accounts.receipt, &key).is_some()
                || match_state_gone(&ctx.accounts.match_state, &key),
            RailcarError::NotFrozen
        );
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // Rollup: the Table
    // ------------------------------------------------------------------------------------

    /// Rollup, anyone, once per Table. Creates the Vault as an ephemeral account behind a private
    /// permission with no member; the Table pays its rent. It is never closed while the Table
    /// runs.
    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        let (index, table_bump) = {
            let t = ctx.accounts.table.load()?;
            require!(t.vault_ready == 0, RailcarError::VaultExists);
            (t.index, t.bump)
        };
        let table_key = ctx.accounts.table.key();
        let table_bump = [table_bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &index, &table_bump];
        let vault_bump = [ctx.bumps.vault];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, table_key.as_ref(), &vault_bump];
        let vault_info = ctx.accounts.vault.to_account_info();
        create_hidden_seat(
            &SeatAccounts {
                table: &ctx.accounts.table.to_account_info(),
                seat: &vault_info,
                permission: &ctx.accounts.vault_permission.to_account_info(),
                vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: &ctx.accounts.magic_program.to_account_info(),
                permission_program: &ctx.accounts.permission_program.to_account_info(),
            },
            table_seeds,
            vault_seeds,
            (8 + Vault::INIT_SPACE) as u32,
            None,
        )?;
        {
            let mut data = vault_info.try_borrow_mut_data()?;
            Vault::blank(ctx.bumps.vault, table_key).try_serialize(&mut &mut data[..])?;
        }
        ctx.accounts.table.load_mut()?.vault_ready = 1;
        Ok(())
    }

    /// Rollup, anyone. Puts the Table's next car on it once that car has left: copies its seated
    /// Players from every seat page (remaining accounts) and asks for the draw. A Table whose
    /// last ride is over is reset first, once core has frozen that car (its receipt).
    pub fn start_ride(ctx: Context<StartRide>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let car = &ctx.accounts.car;
        let match_key = car.tesoro_match;
        let (pages, seated, entry) = {
            let m = ctx.accounts.match_state.load()?;
            require!(
                m.inner.game == ID.to_bytes()
                    && m.inner.stage() == ManyStage::Departed
                    && m.inner.departed_at() != 0,
                RailcarError::NotDeparted
            );
            (m.inner.pages, m.inner.seated, m.inner.entry())
        };
        let ix = {
            let mut t = ctx.accounts.table.load_mut()?;
            require!(t.vault_ready == 1, RailcarError::VaultMissing);
            if t.phase == PHASE_OVER {
                let previous = Pubkey::new_from_array(t.tesoro_match);
                require!(
                    receipt_at(&ctx.accounts.previous_receipt, &previous).is_some(),
                    RailcarError::PreviousNotFrozen
                );
                t.reset();
            }
            require!(t.phase == PHASE_IDLE, RailcarError::WrongPhase);
            require!(
                car.table == t.index() && car.car_no == t.next_car(),
                RailcarError::WrongCar
            );
            let mut n = 0usize;
            for_each_seated(ctx.remaining_accounts, &match_key, pages, |seat, core| {
                let s = t.seats.get_mut(n).ok_or(RailcarError::Overflow)?;
                s.seat = seat;
                s.account = core.player();
                n += 1;
                Ok(())
            })?;
            require!(n == usize::from(seated), RailcarError::PagesMissing);
            t.set_car_no(car.car_no);
            t.car = car.key().to_bytes();
            t.tesoro_match = match_key.to_bytes();
            t.set_entry(entry);
            t.seated = seated;
            t.aboard = seated;
            t.phase = PHASE_DRAWING;
            t.set_started_slot(slot);
            t.set_next_car(
                car.car_no
                    .checked_add(u64::from(car.tables))
                    .ok_or(RailcarError::Overflow)?,
            );
            draw_request(
                &mut t,
                &ctx.accounts.table.key(),
                &ctx.accounts.vault.key(),
                &ctx.accounts.payer.key(),
                &ctx.accounts.oracle_queue.key(),
                slot,
            )?
        };
        ctx.accounts.vault.reset(car.car_no);
        ctx.accounts.vault.exit(&ID)?;
        emit!(RideStarted {
            car_no: car.car_no,
            table: car.table,
            seated,
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Rollup, anyone. Passes over the Table's next car when it will never ride: it was closed
    /// (core froze or closed its Match), its Match is gone, or core has frozen it.
    pub fn skip_car(ctx: Context<SkipCar>) -> Result<()> {
        let mut t = ctx.accounts.table.load_mut()?;
        let next = t.next_car();
        let config = &ctx.accounts.config;
        require!(next < config.next_car, RailcarError::CannotSkip);
        let info = ctx.accounts.car.to_account_info();
        require_keys_eq!(*info.key, car_address(next), RailcarError::WrongCar);
        let done = if info.owner == &system_program::ID && info.data_is_empty() {
            true
        } else {
            let data = info.try_borrow_data()?;
            require_keys_eq!(*info.owner, ID, RailcarError::WrongCar);
            let car = Car::try_deserialize(&mut &data[..])?;
            require_keys_eq!(
                ctx.accounts.match_state.key(),
                car.tesoro_match,
                RailcarError::WrongCar
            );
            match_state_gone(&ctx.accounts.match_state, &car.tesoro_match)
                || receipt_at(&ctx.accounts.receipt, &car.tesoro_match).is_some()
        };
        require!(done, RailcarError::CannotSkip);
        t.set_next_car(
            next.checked_add(u64::from(config.tables))
                .ok_or(RailcarError::Overflow)?,
        );
        Ok(())
    }

    /// Rollup, anyone. Asks again when no answer came within `DRAW_RETRY_SLOTS`, at most
    /// `MAX_DRAW_REQUESTS` in all, never once the draw is in.
    pub fn request_draw(ctx: Context<RequestDraw>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let ix = {
            let mut t = ctx.accounts.table.load_mut()?;
            require!(
                t.phase == PHASE_DRAWING && !ctx.accounts.vault.ready,
                RailcarError::DrawNotDue
            );
            let window_end = t
                .started_slot()
                .checked_add(DRAW_WINDOW_SLOTS)
                .ok_or(RailcarError::Overflow)?;
            let retry_at = t
                .req_slot()
                .checked_add(DRAW_RETRY_SLOTS)
                .ok_or(RailcarError::Overflow)?;
            require!(
                t.req_count < MAX_DRAW_REQUESTS && slot >= retry_at && slot <= window_end,
                RailcarError::DrawNotDue
            );
            draw_request(
                &mut t,
                &ctx.accounts.table.key(),
                &ctx.accounts.vault.key(),
                &ctx.accounts.payer.key(),
                &ctx.accounts.oracle_queue.key(),
                slot,
            )?
        };
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Rollup, called by the VRF program only. Keeps the output and the ride it gives in the
    /// Vault if it answers the one outstanding request of this car inside the draw window, and
    /// starts the ride clock.
    pub fn draw_callback(ctx: Context<DrawCallback>, randomness: [u8; 32]) -> Result<()> {
        let clock = Clock::get()?;
        let mut t = ctx.accounts.table.load_mut()?;
        let vault = &mut ctx.accounts.vault;
        let window_end = t
            .started_slot()
            .checked_add(DRAW_WINDOW_SLOTS)
            .ok_or(RailcarError::Overflow)?;
        require!(
            t.phase == PHASE_DRAWING
                && t.req_pending == 1
                && !vault.ready
                && vault.car_no == t.car_no()
                && clock.slot <= window_end,
            RailcarError::StaleRequest
        );
        vault.store(randomness);
        t.req_pending = 0;
        t.set_ride_slot(clock.slot);
        t.set_ride_ts(clock.unix_timestamp);
        t.phase = PHASE_RIDING;
        emit!(RideRunning {
            car_no: t.car_no(),
            ride_slot: clock.slot,
        });
        Ok(())
    }

    /// Rollup, anyone (each open page sends one about every second). Moves the public Tell
    /// stage; from the Impact slot on it ends the ride and commits the Table. A draw that never
    /// came voids the ride once its window is over.
    pub fn signal(ctx: Context<Signal>) -> Result<()> {
        let clock = Clock::get()?;
        let over = {
            let mut t = ctx.accounts.table.load_mut()?;
            let v = &ctx.accounts.vault;
            match t.phase {
                PHASE_RIDING => {
                    require!(v.ready && v.car_no == t.car_no(), RailcarError::WrongPhase);
                    if ride::advance(&mut t, v, clock.slot) {
                        ride::conclude(&mut t, v, ride::impact_ms(v), clock.unix_timestamp);
                        true
                    } else {
                        false
                    }
                }
                PHASE_DRAWING => {
                    let window_end = t
                        .started_slot()
                        .checked_add(DRAW_WINDOW_SLOTS)
                        .ok_or(RailcarError::Overflow)?;
                    if clock.slot > window_end {
                        ride::void(&mut t, None, REASON_NO_DRAW, clock.unix_timestamp);
                        true
                    } else {
                        false
                    }
                }
                _ => return err!(RailcarError::WrongPhase),
            }
        };
        if over {
            let a = &ctx.accounts;
            end_ride(
                &a.table,
                &a.sponsor,
                (
                    &a.magic_context.to_account_info(),
                    &a.magic_program.to_account_info(),
                    &a.magic_fee_vault.to_account_info(),
                ),
                clock.unix_timestamp,
            )?;
        }
        Ok(())
    }

    /// Rollup, the Player of Table seat `seat`: the wallet of the seat's core Account or the
    /// seat's key (`tesoro_core::util::acts_for`, as core checks a seat's signer). Before
    /// the Impact slot the Player is off: the Jump takes the next place in the order. At or after
    /// it the Jump does not count: the ride ends with the Player aboard. When the last Player
    /// aboard Jumps, the ride ends then. `car_no` makes a transaction held back from an earlier
    /// ride worthless on a later one.
    pub fn jump(ctx: Context<Jump>, car_no: u64, seat: u8) -> Result<()> {
        let clock = Clock::get()?;
        let over = {
            let mut t = ctx.accounts.table.load_mut()?;
            let v = &ctx.accounts.vault;
            require!(t.car_no() == car_no, RailcarError::StaleBinding);
            require!(
                t.phase == PHASE_RIDING && v.ready && v.car_no == car_no,
                RailcarError::WrongPhase
            );
            let i = usize::from(seat);
            require!(i < usize::from(t.seated), RailcarError::NotAPlayer);
            let s = t.seats[i];
            require!(
                acts_for(
                    &Pubkey::new_from_array(s.account),
                    &ctx.accounts.player.key(),
                    &Pubkey::new_from_array(s.signer)
                ),
                RailcarError::NotAPlayer
            );
            if ride::advance(&mut t, v, clock.slot) {
                ride::conclude(&mut t, v, ride::impact_ms(v), clock.unix_timestamp);
                true
            } else {
                let empty = ride::jump(&mut t, i, clock.slot).map_err(ride_err)?;
                let s = t.seats[i];
                emit!(Jumped {
                    car_no,
                    seat: s.seat,
                    order: s.order,
                    ride_ms: s.jump_ms(),
                });
                if empty {
                    let ms = t.ride_ms(clock.slot);
                    ride::conclude(&mut t, v, ms, clock.unix_timestamp);
                }
                empty
            }
        };
        if over {
            let a = &ctx.accounts;
            end_ride(
                &a.table,
                &a.sponsor,
                (
                    &a.magic_context.to_account_info(),
                    &a.magic_program.to_account_info(),
                    &a.magic_fee_vault.to_account_info(),
                ),
                clock.unix_timestamp,
            )?;
        }
        Ok(())
    }

    /// Rollup, anyone, once per seat per ride (a repeat does nothing). Hands Table seat `seat`'s
    /// Brake seat to this ride's Player: created the first time the seat index rides on this
    /// Table, otherwise zeroed and its permission members swapped. The members come from the
    /// Table seat only: the wallet of its core Account and the seat key core recorded. Pages bind
    /// every seat while the draw is asked for, so a binding never marks a Player who means to
    /// Brake; no Brake counts until every seat is bound.
    pub fn bind_brake(ctx: Context<BindBrake>, car_no: u64, seat: u8) -> Result<()> {
        let (index, table_bump, keys) = {
            let t = ctx.accounts.table.load()?;
            require!(t.car_no() == car_no, RailcarError::StaleBinding);
            require!(
                t.phase == PHASE_DRAWING || t.phase == PHASE_RIDING,
                RailcarError::WrongPhase
            );
            let i = usize::from(seat);
            require!(i < usize::from(t.seated), RailcarError::NotAPlayer);
            let s = &t.seats[i];
            let account = &ctx.accounts.player_account;
            require!(
                account.key().to_bytes() == s.account,
                RailcarError::NotAPlayer
            );
            let keys = SeatKeys {
                player: account.authority,
                signer: Pubkey::new_from_array(s.signer),
            };
            (t.index, t.bump, keys)
        };
        let info = ctx.accounts.brake_seat.to_account_info();
        let exists = !info.data_is_empty();
        if exists {
            require_keys_eq!(*info.owner, ID, RailcarError::BadTable);
            let held = BrakeSeat::try_deserialize(&mut &info.try_borrow_data()?[..])?;
            if held.bound_to(car_no) {
                return Ok(());
            }
        }
        let table_key = ctx.accounts.table.key();
        let table_bump = [table_bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &index, &table_bump];
        let seat_index = [seat];
        let seat_bump = [ctx.bumps.brake_seat];
        let seat_seeds: &[&[u8]] = &[BRAKE_SEED, table_key.as_ref(), &seat_index, &seat_bump];
        let accounts = SeatAccounts {
            table: &ctx.accounts.table.to_account_info(),
            seat: &info,
            permission: &ctx.accounts.brake_permission.to_account_info(),
            vault: &ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: &ctx.accounts.magic_program.to_account_info(),
            permission_program: &ctx.accounts.permission_program.to_account_info(),
        };
        let record = BrakeSeat {
            version: BrakeSeat::VERSION,
            bump: ctx.bumps.brake_seat,
            table: table_key,
            seat,
            bound: 1,
            car_no,
            used: 0,
            press_ms: 0,
            reserved: [0; 16],
        };
        if exists {
            // the last ride's Player loses the seat only after its data is gone
            info.try_borrow_mut_data()?.fill(0);
            swap_seat_members_keyed(&accounts, table_seeds, seat_seeds, Some(keys))?;
        } else {
            create_hidden_seat_keyed(
                &accounts,
                table_seeds,
                seat_seeds,
                (8 + BrakeSeat::INIT_SPACE) as u32,
                Some(keys),
            )?;
        }
        record.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        let mut t = ctx.accounts.table.load_mut()?;
        t.brakes_bound = t
            .brakes_bound
            .checked_add(1)
            .ok_or(RailcarError::Overflow)?;
        Ok(())
    }

    /// Rollup, the Player of Table seat `seat` (wallet or seat key, as `jump`): a Player page's
    /// signal, about every second, with `brake` = 1 when the Player presses their Brake (a `u8`,
    /// not a `bool`: Borsh's bool decoding branches, so a press would cost one compute unit less). It moves
    /// the Tell stage and ends the ride from the Impact slot on, as `signal` does; before that, a
    /// Brake by a Player aboard who has not Braked on this ride sets the slow period's end to
    /// max(now, end) + 5 s. Anything else about the Brake does nothing (no error): a refusal would
    /// tell anyone who simulates the transaction that this Player has Braked. A Brake at or after
    /// the Impact slot ends the ride and does not count.
    pub fn tick(ctx: Context<Tick>, car_no: u64, seat: u8, brake: u8) -> Result<()> {
        let clock = Clock::get()?;
        let over = {
            let mut t = ctx.accounts.table.load_mut()?;
            let v = &mut ctx.accounts.vault;
            require!(t.car_no() == car_no, RailcarError::StaleBinding);
            require!(
                t.phase == PHASE_RIDING && v.ready && v.car_no == car_no,
                RailcarError::WrongPhase
            );
            let i = usize::from(seat);
            require!(i < usize::from(t.seated), RailcarError::NotAPlayer);
            let s = t.seats[i];
            require!(
                acts_for(
                    &Pubkey::new_from_array(s.account),
                    &ctx.accounts.player.key(),
                    &Pubkey::new_from_array(s.signer)
                ),
                RailcarError::NotAPlayer
            );
            // binding is public (its permission change); a tick of an unbound seat would show
            // its message to the seat's previous Player
            require!(
                ctx.accounts.brake_seat.bound_to(car_no),
                RailcarError::WrongPhase
            );
            if ride::advance(&mut t, v, clock.slot) {
                ride::conclude(&mut t, v, ride::impact_ms(v), clock.unix_timestamp);
                true
            } else {
                let ms = t.ride_ms(clock.slot);
                ride::tick(&t, v, &mut ctx.accounts.brake_seat, seat, ms, brake);
                false
            }
        };
        if over {
            let a = &ctx.accounts;
            end_ride(
                &a.table,
                &a.sponsor,
                (
                    &a.magic_context.to_account_info(),
                    &a.magic_program.to_account_info(),
                    &a.magic_fee_vault.to_account_info(),
                ),
                clock.unix_timestamp,
            )?;
        }
        Ok(())
    }

    /// Rollup, anyone. Commits the Table to base, paid by the Sponsor: a result's first commit,
    /// or a repeat of a commit that may have been lost, with Block Burst's doubling wait while
    /// the result is younger than core's refund window.
    pub fn commit_table(ctx: Context<CommitTable>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let t = ctx.accounts.table.load()?;
            let owed = t.dirty == 1;
            let guard = CommitGuard {
                tries: t.commit_tries,
                last_at: t.commit_at(),
            };
            let young = t
                .over_at()
                .checked_add(COMMIT_WINDOW_SECS)
                .is_some_and(|end| now < end);
            let due = t
                .commit_at()
                .checked_add(guard.wait_secs())
                .is_some_and(|at| now >= at);
            require!(
                t.phase == PHASE_OVER && (owed || (young && due)),
                RailcarError::CommitNotDue
            );
        }
        require!(
            sponsor_can_commit(&ctx.accounts.sponsor.to_account_info()),
            RailcarError::SponsorDry
        );
        commit_table_now(
            &ctx.accounts.table,
            &ctx.accounts.sponsor,
            &ctx.accounts.magic_context.to_account_info(),
            &ctx.accounts.magic_program.to_account_info(),
            &ctx.accounts.magic_fee_vault.to_account_info(),
            now,
        )
    }

    /// Rollup, operator. Moves lamports from a fuel reserve into the Sponsor.
    pub fn refill_sponsor(ctx: Context<RefillSponsor>, amount: u64) -> Result<()> {
        let keep = Rent::get()?.minimum_balance(8 + Fuel::INIT_SPACE);
        move_lamports(
            &ctx.accounts.fuel.to_account_info(),
            &ctx.accounts.sponsor.to_account_info(),
            amount,
            keep,
        )
        .map_err(|_| error!(RailcarError::Overflow))
    }
}

/// Funds a new PDA with `lamports` from the operator.
fn fund<'info>(
    system: &Program<'info, System>,
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system.to_account_info(),
            system_program::Transfer {
                from: from.to_account_info(),
                to: to.clone(),
            },
        ),
        lamports,
    )
}

/// The only delegation config Railcar accepts: the TEE validator, no automatic commits (an
/// automatic commit would publish the Table mid-ride).
fn tee_config(validator: &Option<AccountInfo>) -> Result<DelegateConfig> {
    require!(
        validator.as_ref().is_some_and(|v| v.key() == TEE_VALIDATOR),
        RailcarError::InvalidValidator
    );
    Ok(DelegateConfig {
        validator: Some(TEE_VALIDATOR),
        commit_frequency_ms: u32::MAX,
    })
}

// -----------------------------------------------------------------------------------------
// Accounts
// -----------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed, payer = authority, space = 8 + RailcarConfig::INIT_SPACE,
        seeds = [CONFIG_SEED], bump
    )]
    pub config: Account<'info, RailcarConfig>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ RailcarError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::Railcar>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ RailcarError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct CreateTable<'info> {
    #[account(mut, address = config.operator @ RailcarError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RailcarConfig>,
    #[account(
        init, payer = operator, space = Table::SPACE,
        seeds = [TABLE_SEED, &index.to_le_bytes()], bump
    )]
    pub table: AccountLoader<'info, Table>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateSponsor<'info> {
    #[account(mut, address = config.operator @ RailcarError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RailcarConfig>,
    #[account(init, payer = operator, space = 8 + Sponsor::INIT_SPACE, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: Account<'info, Sponsor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(n: u8)]
pub struct CreateFuel<'info> {
    #[account(mut, address = config.operator @ RailcarError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RailcarConfig>,
    #[account(init, payer = operator, space = 8 + Fuel::INIT_SPACE, seeds = [FUEL_SEED, &[n]], bump)]
    pub fuel: Account<'info, Fuel>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(index: u16)]
pub struct DelegateTable<'info> {
    #[account(mut, address = config.operator @ RailcarError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RailcarConfig>,
    /// CHECK: the Table PDA to delegate
    #[account(mut, del, seeds = [TABLE_SEED, &index.to_le_bytes()], bump)]
    pub table: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by `tee_config`
    pub validator: Option<AccountInfo<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSponsor<'info> {
    #[account(mut, address = config.operator @ RailcarError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RailcarConfig>,
    /// CHECK: the Sponsor PDA to delegate
    #[account(mut, del, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by `tee_config`
    pub validator: Option<AccountInfo<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(n: u8)]
pub struct DelegateFuel<'info> {
    #[account(mut, address = config.operator @ RailcarError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RailcarConfig>,
    /// CHECK: the fuel PDA to delegate
    #[account(mut, del, seeds = [FUEL_SEED, &[n]], bump)]
    pub fuel: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by `tee_config`
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(n: u64)]
pub struct OpenCar<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub opener: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RailcarConfig>>,
    #[account(
        init, payer = payer, space = 8 + Car::INIT_SPACE,
        seeds = [CAR_SEED, &config.next_car.to_le_bytes()], bump
    )]
    pub car: Box<Account<'info, Car>>,
    /// CHECK: the core Match of the car named boarding (the default key before the first car),
    /// read by hand in `still_boarding`.
    #[account(address = config.boarding_match @ RailcarError::CarBoarding)]
    pub boarding_match: UncheckedAccount<'info>,
    /// CHECK: the new core Match, created by tesoro_core at `["match", opener Account, n]`.
    #[account(mut)]
    pub match_state: UncheckedAccount<'info>,
    #[account(seeds = [CORE_CONFIG_SEED], bump = core_config.bump, seeds::program = tesoro_core::ID)]
    pub core_config: Box<Account<'info, CoreConfig>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump, seeds::program = tesoro_core::ID)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(
        seeds = [GAME_SEED, crate::ID.as_ref()],
        bump = game_record.bump,
        seeds::program = tesoro_core::ID
    )]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: this Game's own program account (tesoro_core reads its deploy slot).
    #[account(address = crate::ID)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: this program's ProgramData, checked by tesoro_core.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, opener.key().as_ref()],
        bump = opener_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub opener_account: Box<Account<'info, TesoroAccount>>,
    /// CHECK: the opener's counters, created if needed by tesoro_core.
    #[account(
        mut,
        seeds = [COUNTERS_SEED, opener_account.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub counters: UncheckedAccount<'info>,
    /// CHECK: Railcar's settle authority PDA; signs core's open.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckDeparture<'info> {
    #[account(seeds = [CAR_SEED, &car.car_no.to_le_bytes()], bump = car.bump)]
    pub car: Box<Account<'info, Car>>,
    #[account(mut, address = car.tesoro_match @ RailcarError::WrongCar)]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    #[account(
        seeds = [GAME_SEED, crate::ID.as_ref()],
        bump = game_record.bump,
        seeds::program = tesoro_core::ID
    )]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: this Game's own program account.
    #[account(address = crate::ID)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: this program's ProgramData, checked by tesoro_core.
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: Railcar's settle authority PDA; signs core's departure.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RevealRide<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CAR_SEED, &car.car_no.to_le_bytes()], bump = car.bump)]
    pub car: Box<Account<'info, Car>>,
    /// CHECK: the car's Table as base holds it; checked by `finished_table`.
    pub table: UncheckedAccount<'info>,
    /// CHECK: the car's core Match, read in place (owner and discriminator checked).
    #[account(address = car.tesoro_match @ RailcarError::WrongCar)]
    pub match_state: UncheckedAccount<'info>,
    /// CHECK: tesoro_core's event authority, read-only and unused: listed so the history's
    /// webhook and catch-up (which follow tesoro_core) see this transaction.
    #[account(seeds = [b"__event_authority"], bump, seeds::program = tesoro_core::ID)]
    pub core_event_authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    /// Pays the settlement receipt's rent in tesoro_core.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [CAR_SEED, &car.car_no.to_le_bytes()],
        bump = car.bump,
        close = car_payer
    )]
    pub car: Box<Account<'info, Car>>,
    /// CHECK: receives the car's rent; must be the key that paid it.
    #[account(mut, address = car.payer)]
    pub car_payer: UncheckedAccount<'info>,
    /// CHECK: the car's Table as base holds it (owned by the delegation program while
    /// delegated); its address (from its stored bump), owner and contents are checked in
    /// `finalize`.
    pub table: UncheckedAccount<'info>,
    /// CHECK: the car's core Match; tesoro_core checks it in the settle.
    #[account(mut, address = car.tesoro_match @ RailcarError::WrongCar)]
    pub match_state: UncheckedAccount<'info>,
    #[account(seeds = [CORE_CONFIG_SEED], bump = core_config.bump, seeds::program = tesoro_core::ID)]
    pub core_config: Box<Account<'info, CoreConfig>>,
    #[account(
        seeds = [GAME_SEED, crate::ID.as_ref()],
        bump = game_record.bump,
        seeds::program = tesoro_core::ID
    )]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: Railcar's settle authority PDA; signs the CPI.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this Game's own program account.
    #[account(address = crate::ID)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: this program's ProgramData, checked by tesoro_core.
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: the settlement receipt, created by tesoro_core, which checks its address
    /// `["settled", match]` (deriving it here too would repeat core's bump search).
    #[account(mut)]
    pub receipt: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: tesoro_core's event authority PDA.
    #[account(seeds = [b"__event_authority"], bump, seeds::program = tesoro_core::ID)]
    pub core_event_authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}

#[derive(Accounts)]
pub struct CloseCar<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [CAR_SEED, &car.car_no.to_le_bytes()],
        bump = car.bump,
        close = car_payer
    )]
    pub car: Box<Account<'info, Car>>,
    /// CHECK: receives the rent; must be the key that paid it.
    #[account(mut, address = car.payer)]
    pub car_payer: UncheckedAccount<'info>,
    /// CHECK: the settlement receipt of the car's Match, verified by `receipt_at`.
    pub receipt: UncheckedAccount<'info>,
    /// CHECK: the car's core Match, checked by key in `match_state_gone`.
    pub match_state: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: the Vault PDA, created here as an ephemeral account.
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the Vault
    #[account(mut, seeds = [PERMISSION_SEED, vault.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub vault_permission: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Magic Program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct StartRide<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [CAR_SEED, &car.car_no.to_le_bytes()], bump = car.bump)]
    pub car: Box<Account<'info, Car>>,
    #[account(address = car.tesoro_match @ RailcarError::WrongCar)]
    pub match_state: AccountLoader<'info, ManySeatMatch>,
    /// CHECK: core's receipt of the Table's previous car (when the Table is over), read by
    /// `receipt_at`.
    pub previous_receipt: UncheckedAccount<'info>,
    /// CHECK: validated by the VRF program
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SkipCar<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RailcarConfig>>,
    /// CHECK: the Table's next car at `["car", next]`, read by hand (it may be closed).
    pub car: UncheckedAccount<'info>,
    /// CHECK: that car's core Match, checked against the car.
    pub match_state: UncheckedAccount<'info>,
    /// CHECK: its settlement receipt, read by `receipt_at`.
    pub receipt: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestDraw<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(seeds = [VAULT_SEED, table.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: validated by the VRF program
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct DrawCallback<'info> {
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: names the request this answer is for: `["vrfreq", table, nonce]` of the one
    /// outstanding request. The account itself need not exist.
    #[account(
        constraint = request.key() == Table::request_marker(&table.key(), table.load()?.req_nonce())
            @ RailcarError::StaleRequest
    )]
    pub request: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct Signal<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(seeds = [VAULT_SEED, table.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: the TEE validator's magic fee vault, checked in `sponsor_commit`.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct Jump<'info> {
    /// The seat's Player: the wallet of its core Account, or the seat key core recorded for it.
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(seeds = [VAULT_SEED, table.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: the TEE validator's magic fee vault, checked in `sponsor_commit`.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(car_no: u64, seat: u8)]
pub struct BindBrake<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    /// The seat's core Account (checked against the Table seat): its wallet becomes a member.
    pub player_account: Box<Account<'info, TesoroAccount>>,
    /// CHECK: the Brake seat PDA, created here as an ephemeral account or read by hand.
    #[account(mut, seeds = [BRAKE_SEED, table.key().as_ref(), &[seat]], bump)]
    pub brake_seat: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the Brake seat
    #[account(mut, seeds = [PERMISSION_SEED, brake_seat.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub brake_permission: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Magic Program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
#[instruction(car_no: u64, seat: u8)]
pub struct Tick<'info> {
    /// The seat's Player: the wallet of its core Account, or the seat key core recorded for it.
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [BRAKE_SEED, table.key().as_ref(), &[seat]],
        bump = brake_seat.bump,
    )]
    pub brake_seat: Box<Account<'info, BrakeSeat>>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: the TEE validator's magic fee vault, checked in `sponsor_commit`.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitTable<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.index], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: the TEE validator's magic fee vault, checked in `sponsor_commit`.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefillSponsor<'info> {
    #[account(address = config.operator @ RailcarError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RailcarConfig>,
    #[account(mut, seeds = [FUEL_SEED, &[fuel.n]], bump = fuel.bump)]
    pub fuel: Account<'info, Fuel>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
}
