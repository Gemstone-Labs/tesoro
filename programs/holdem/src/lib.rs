//! Heads-up No-Limit Hold'em as a Tesoro Game, on persistent tables.
//!
//! Matches run on **tables** that stay delegated to MagicBlock's TEE rollup across Matches (see
//! the protocol note `table-protocol.md` and `crates/table_kit`). A table holds the public Match
//! and a ring of results. Its two **Hole** seats are rollup-only accounts behind private
//! permissions, created once and kept for the table's life.
//!
//! * base: `assign_match` binds a tesoro_core Match to one table and epoch (write-once);
//!   `finalize` reads the committed, still-delegated table and settles through tesoro_core.
//! * rollup: `begin_match`, `seat_players`, `check_in`, then per hand `contribute_entropy`,
//!   `request_vrf`, the oracle callback, `deal`, `act` and `claim_timeout`; `commit_table`,
//!   `wipe_seats`, `reset_table` after the Match, and the ring / void / expire recovery paths.
//!
//! The shuffle has no Deck. Each Player's secret goes only into their own Hole and is frozen
//! before the one VRF request of the hand; the answer is split into a half per Hole. `deal`
//! derives the seed from both secrets, both halves, the table epoch, the Match, the hand and the
//! request number, draws the nine cards used, writes each Player's hole cards, stores the board
//! as two XOR shares (one per Hole) and zeroes every secret and half. Nothing holds the deck or
//! the seed afterwards.
//!
//! Privacy rules this file keeps (`hidden-info.md`): a Hole always has a private permission, from
//! creation until retirement; between Matches its data is zeroed and its member swapped to nobody
//! and then to the next Player, and only `wipe_seats` and `seat_players` do that, never inside a
//! live Match and never on a Player's call; no hidden value is logged or reaches an error code.

pub mod deal;
pub mod engine;
pub mod eval;
pub mod state;

#[cfg(test)]
mod keeper_fixtures;

use anchor_lang::{prelude::*, system_program};
use deal::{Contributions, HandContext};
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
    absence_outcome, assignment_absent, close_private_seat, create_hidden_seat, match_state_gone,
    may_skip, move_lamports, read_table, receipt_at, sponsor_commit, swap_seat_members,
    table_wait_over, KitError, SeatAccounts, OUTCOME_DRAW, OUTCOME_NO_SHOW, OUTCOME_WIN0,
    OUTCOME_WIN1, SLOT_DONE, SLOT_RESERVED,
};
use tesoro_core::{
    instructions::MatchResult,
    ledger::lifecycle::Stage,
    state::{
        Config as CoreConfig, GameRecord, MatchState, TesoroAccount, ACCOUNT_SEED,
        CONFIG_SEED as CORE_CONFIG_SEED, GAME_SEED, MATCH_SEED as CORE_MATCH_SEED,
    },
};

pub use state::*;

declare_id!("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE");

/// Identity of MagicBlock's TEE validator (devnet). Delegation is pinned to it: the validator a
/// delegation names is the only key that can commit state back, so a caller-chosen validator (or
/// none, which the delegation program reads as the public default validator) would let a Player
/// commit a table they won, or leave the table outside the TEE.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

#[error_code]
pub enum HoldemError {
    #[msg("Signer is not a Player of this Match")]
    NotAPlayer,
    #[msg("Entropy already contributed for this hand")]
    AlreadyContributed,
    #[msg("Both Players must contribute entropy and the VRF output must arrive first")]
    EntropyIncomplete,
    #[msg("The hand is already dealt, or its randomness already requested")]
    AlreadyDealt,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unknown speed")]
    InvalidSpeed,
    #[msg("Match already started")]
    AlreadyStarted,
    #[msg("Match is not live")]
    NotLive,
    #[msg("Not valid in this phase of the hand")]
    WrongPhase,
    #[msg("It is not your turn")]
    NotYourTurn,
    #[msg("Cannot check facing a bet")]
    CannotCheck,
    #[msg("Nothing to call")]
    NothingToCall,
    #[msg("The opponent is all-in")]
    OpponentAllIn,
    #[msg("Raise below the minimum")]
    RaiseTooSmall,
    #[msg("Not enough chips")]
    NotEnoughChips,
    #[msg("Deadline has not passed")]
    NotTimedOut,
    #[msg("The tesoro_core Match is not an Active Match of this Game")]
    BadTesoroMatch,
    #[msg("The Match is not over")]
    MatchNotOver,
    #[msg("Already settled or refunded in tesoro_core")]
    AlreadyFinalized,
    #[msg("Delegation must name the TEE validator")]
    InvalidValidator,
    #[msg("A permission for this account is missing or is not a real permission")]
    PermissionNotReady,
    #[msg("Only the upgrade authority may do this")]
    NotUpgradeAuthority,
    #[msg("Only the operator may do this")]
    NotOperator,
    #[msg("Invalid configuration")]
    BadConfig,
    #[msg("That table index or generation is not allowed")]
    BadTableSlot,
    #[msg("The Assignment names another table, generation or epoch")]
    NotAssigned,
    #[msg("The seats are not open")]
    SeatsNotOpen,
    #[msg("The seats are already open or still open")]
    SeatsOpen,
    #[msg("The table has no seats yet")]
    SeatsMissing,
    #[msg("A seat still holds data from an earlier Match")]
    SeatNotBlank,
    #[msg("The result ring is full")]
    RingFull,
    #[msg("The ring has no result for this Match and epoch")]
    NoResult,
    #[msg("The evidence that frees the slot is missing or too recent")]
    NoReceipt,
    #[msg("The ring slot is not in the state this needs")]
    BadSlot,
    #[msg("The table has no result to commit")]
    NotDirty,
    #[msg("The table result has not been committed yet")]
    NotCommitted,
    #[msg("The table is not ready to be reset")]
    ResetTooEarly,
    #[msg("Not the table of this Assignment, or not a valid table")]
    BadTable,
    #[msg("Not the TEE validator's fee vault")]
    BadFeeVault,
    #[msg("The start deadline has passed")]
    StartWindowPassed,
    #[msg("That secret was already used at this seat")]
    SecretReused,
    #[msg("The randomness answer is not for the current request")]
    StaleRequest,
    #[msg("That Match is not a joined Match without a table")]
    NotUntabled,
    #[msg("The Match has not waited long enough for a table")]
    TableWaitNotOver,
    #[msg("This Assignment cannot be given up yet, or any more")]
    CannotSkip,
}

impl From<KitError> for HoldemError {
    fn from(e: KitError) -> Self {
        match e {
            KitError::RingFull | KitError::RingDuplicate => HoldemError::RingFull,
            KitError::RingSlot => HoldemError::BadSlot,
            KitError::BadTable => HoldemError::BadTable,
            KitError::BadFeeVault => HoldemError::BadFeeVault,
            KitError::Overflow => HoldemError::Overflow,
            KitError::CommitNotDue => HoldemError::NotDirty,
        }
    }
}

fn kit<T>(r: core::result::Result<T, KitError>) -> Result<T> {
    r.map_err(|e| error!(HoldemError::from(e)))
}

/// The address of a table.
pub fn table_address(generation: u16, index: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()],
        &ID,
    )
    .0
}

/// The address of a seat.
pub fn hole_address(table: &Pubkey, seat: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HOLE_SEED, table.as_ref(), &[seat]], &ID)
}

/// The speed a Match plays at, carried in the tesoro_core Match record (`meta.asset`): 0 is
/// standard, 1 turbo.
pub fn check_speed(asset: u8) -> Result<u8> {
    require!(
        asset == SPEED_STANDARD || asset == SPEED_TURBO,
        HoldemError::InvalidSpeed
    );
    Ok(asset)
}

fn seat_of(players: &[Pubkey; 2], key: &Pubkey) -> Result<usize> {
    players
        .iter()
        .position(|p| p == key)
        .ok_or_else(|| error!(HoldemError::NotAPlayer))
}

/// The table is running a Match whose seats belong to its Players.
fn require_live(table: &Table) -> Result<()> {
    require!(
        table.phase == TABLE_LIVE && table.seats_open && table.game.status == STATUS_LIVE,
        HoldemError::NotLive
    );
    Ok(())
}

/// What a hand's transitions leave behind, called after every move that can end a hand or the
/// Match: a finished hand's cards and shares are wiped from the seats, and a finished Match writes
/// its result into the ring.
fn after_move(table: &mut Table, holes: [&mut Hole; 2], now: i64) -> Result<()> {
    if table.game.phase == PHASE_SHUFFLE || table.game.phase == PHASE_NONE {
        for hole in holes {
            hole.clear_hand();
        }
    }
    conclude(table, now)
}

/// Writes the Match's result into the ring slot reserved at the start and marks the table Over.
fn conclude(table: &mut Table, now: i64) -> Result<()> {
    let outcome = match table.game.status {
        STATUS_LIVE => return Ok(()),
        STATUS_OVER if table.game.winner == 0 => OUTCOME_WIN0,
        STATUS_OVER => OUTCOME_WIN1,
        _ if table.game.no_show => OUTCOME_NO_SHOW,
        _ => OUTCOME_DRAW,
    };
    let (slot, key, epoch) = (table.slot, table.tesoro_match, table.epoch);
    kit(table.ring.record(slot, &key, epoch, outcome, now))?;
    table.phase = TABLE_OVER;
    table.over_at = now;
    table.dirty = true;
    table.commit.on_result();
    table.req_pending = false;
    table.vrf_ready = false;
    Ok(())
}

#[ephemeral]
#[program]
pub mod holdem {
    use super::*;

    // ------------------------------------------------------------------------------------
    // Base layer
    // ------------------------------------------------------------------------------------

    /// Base, upgrade authority only. Names the operator, the current table generation (which may
    /// only rise) and how many tables a generation may have.
    pub fn set_config(
        ctx: Context<SetConfig>,
        operator: Pubkey,
        generation: u16,
        max_tables: u16,
    ) -> Result<()> {
        require!(
            operator != Pubkey::default() && (1..=MAX_TABLES_HARD).contains(&max_tables),
            HoldemError::BadConfig
        );
        let config = &mut ctx.accounts.config;
        require!(generation >= config.generation, HoldemError::BadConfig);
        config.bump = ctx.bumps.config;
        config.operator = operator;
        config.generation = generation;
        config.max_tables = max_tables;
        Ok(())
    }

    /// Base, operator. Creates a table of the current generation, funded for its seats' rent.
    pub fn create_table(ctx: Context<CreateTable>, generation: u16, index: u16) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            generation == config.generation && index < config.max_tables,
            HoldemError::BadTableSlot
        );
        **ctx.accounts.table = Table::new(ctx.bumps.table, generation, index);
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

    /// Base, operator. Delegates a table to the TEE validator, once.
    pub fn delegate_table(ctx: Context<DelegateTable>, generation: u16, index: u16) -> Result<()> {
        let config = tee_config(&ctx.accounts.validator)?;
        ctx.accounts.delegate_table(
            &ctx.accounts.operator,
            &[TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()],
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

    /// Base, operator. Binds an Active tesoro_core Match of this Game to a table and its current
    /// epoch, once. The Players and the speed are copied from the Match, the start deadline is
    /// fixed here, and the Match's refund timer is held past the whole table window.
    pub fn assign_match(
        ctx: Context<AssignMatch>,
        generation: u16,
        index: u16,
        epoch: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            generation == config.generation && index < config.max_tables,
            HoldemError::BadTableSlot
        );
        let tesoro = &ctx.accounts.tesoro_match;
        let speed = check_speed(tesoro.inner.meta.asset)?;
        require!(
            tesoro.inner.stage() == Stage::Active
                && tesoro.inner.game == ID.to_bytes()
                && tesoro.inner.a.player == ctx.accounts.account_a.key().to_bytes()
                && tesoro
                    .inner
                    .b
                    .as_ref()
                    .is_some_and(|b| b.player == ctx.accounts.account_b.key().to_bytes()),
            HoldemError::BadTesoroMatch
        );
        let now = Clock::get()?.unix_timestamp;
        let authority_bump = [ctx.bumps.authority];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &authority_bump]];
        tesoro_core::cpi::extend_match_deadline(
            CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::ExtendMatchDeadline {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                },
                signer_seeds,
            ),
            now.checked_add(TABLE_WINDOW_SECS)
                .ok_or(HoldemError::Overflow)?,
        )?;
        let a = &mut ctx.accounts.assignment;
        a.bump = ctx.bumps.assignment;
        a.tesoro_match = ctx.accounts.tesoro_match.key();
        a.generation = generation;
        a.index = index;
        a.epoch = epoch;
        a.players = [
            ctx.accounts.account_a.authority,
            ctx.accounts.account_b.authority,
        ];
        a.speed = speed;
        a.start_deadline = now
            .checked_add(START_WINDOW_SECS)
            .ok_or(HoldemError::Overflow)?;
        a.payer = ctx.accounts.operator.key();
        Ok(())
    }

    /// Base, permissionless. Refunds a joined Match that no table was ever assigned to, once it has
    /// waited `TABLE_WAIT_SECS`, by CPI signed by this Game's `authority` PDA. Refused whenever an
    /// Assignment exists for the Match, so it can never touch a Match a table has claimed.
    pub fn refund_untabled<'info>(
        ctx: Context<'_, '_, 'info, 'info, RefundUntabled<'info>>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.tesoro_match.inner;
        require!(
            m.stage() == Stage::Active && m.game == ID.to_bytes(),
            HoldemError::NotUntabled
        );
        require!(
            assignment_absent(
                &ctx.accounts.assignment.to_account_info(),
                &ctx.accounts.assignment.key()
            ),
            HoldemError::NotUntabled
        );
        require!(
            table_wait_over(m.deadline, m.deadline_abs, now),
            HoldemError::TableWaitNotOver
        );
        let bump = [ctx.bumps.authority];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let remaining = ctx.remaining_accounts.to_vec();
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.tesoro_program.to_account_info(),
            tesoro_core::cpi::accounts::RefundMatch {
                caller: ctx.accounts.authority.to_account_info(),
                payer: ctx.accounts.caller.to_account_info(),
                game_record: ctx.accounts.game_record.to_account_info(),
                game_program: ctx.accounts.game_program.to_account_info(),
                program_data: ctx.accounts.program_data.to_account_info(),
                match_state: ctx.accounts.tesoro_match.to_account_info(),
                receipt: ctx.accounts.receipt.to_account_info(),
                opener_protections: None,
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.tesoro_program.to_account_info(),
            },
            signer_seeds,
        )
        .with_remaining_accounts(remaining);
        tesoro_core::cpi::refund_match(cpi)?;
        Ok(())
    }

    /// Base, permissionless. Closes an Assignment once tesoro_core has frozen its Match (the
    /// receipt exists) or the Match account is gone; the rent goes back to whoever paid it.
    pub fn close_assignment(ctx: Context<CloseAssignment>) -> Result<()> {
        let key = ctx.accounts.assignment.tesoro_match;
        require!(
            receipt_at(&ctx.accounts.receipt, &key).is_some()
                || match_state_gone(&ctx.accounts.match_state, &key),
            HoldemError::NoReceipt
        );
        Ok(())
    }

    /// Base, permissionless. Settles the tesoro_core Match from the result in the committed
    /// table's ring, by CPI signed by this Game's `authority` PDA. Without a result it refunds
    /// only when the table has demonstrably moved past the Assignment's epoch without the Match.
    /// Only starts the settlement in tesoro_core; its chunks follow.
    pub fn finalize<'info>(ctx: Context<'_, '_, 'info, 'info, Finalize<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let assignment = &ctx.accounts.assignment;
        let table: Table = kit(read_table(
            &ctx.accounts.table,
            &table_address(assignment.generation, assignment.index),
            &ID,
        ))?;
        require!(
            table.generation == assignment.generation && table.index == assignment.index,
            HoldemError::BadTable
        );
        let outcome = match table.ring.find(&assignment.tesoro_match, assignment.epoch) {
            Some((_, slot)) if slot.state == SLOT_DONE => slot.outcome,
            Some(_) => return err!(HoldemError::MatchNotOver),
            None => {
                // The slot is freed only after tesoro_core froze the Match, so an absent slot is
                // proof of "never ran" only once the table is past that epoch.
                require!(table.epoch > assignment.epoch, HoldemError::NoResult);
                require!(now > assignment.start_deadline, HoldemError::NotTimedOut);
                OUTCOME_DRAW
            }
        };

        let bump = [ctx.bumps.authority];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let remaining = ctx.remaining_accounts.to_vec();
        if outcome == OUTCOME_DRAW {
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::RefundMatch {
                    caller: ctx.accounts.authority.to_account_info(),
                    payer: ctx.accounts.caller.to_account_info(),
                    game_record: ctx.accounts.game_record.to_account_info(),
                    game_program: ctx.accounts.game_program.to_account_info(),
                    program_data: ctx.accounts.program_data.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                    receipt: ctx.accounts.receipt.to_account_info(),
                    opener_protections: None,
                    system_program: ctx.accounts.system_program.to_account_info(),
                    event_authority: ctx.accounts.event_authority.to_account_info(),
                    program: ctx.accounts.tesoro_program.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(remaining);
            tesoro_core::cpi::refund_match(cpi)?;
        } else {
            let result = match outcome {
                OUTCOME_WIN0 => MatchResult::Opener,
                OUTCOME_WIN1 => MatchResult::Joiner,
                OUTCOME_NO_SHOW => MatchResult::NoShow,
                _ => return err!(HoldemError::NoResult),
            };
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::SettleMatch {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    payer: ctx.accounts.caller.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    game_record: ctx.accounts.game_record.to_account_info(),
                    game_program: ctx.accounts.game_program.to_account_info(),
                    program_data: ctx.accounts.program_data.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                    receipt: ctx.accounts.receipt.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    event_authority: ctx.accounts.event_authority.to_account_info(),
                    program: ctx.accounts.tesoro_program.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(remaining);
            tesoro_core::cpi::settle_match(cpi, result)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // Rollup: seats
    // ------------------------------------------------------------------------------------

    /// Rollup, permissionless, once per table. Creates the two Hole seats as ephemeral accounts
    /// behind private permissions with no member. The table pays the rent. They are never
    /// closed while the table runs.
    pub fn init_seats(ctx: Context<InitSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(!table.seats_created, HoldemError::SeatsOpen);
        require!(table.phase == TABLE_IDLE, HoldemError::WrongPhase);
        let table_key = table.key();
        let gen = table.generation.to_le_bytes();
        let idx = table.index.to_le_bytes();
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        for seat in 0..2usize {
            let (hole, permission, hole_bump) = if seat == 0 {
                (
                    &ctx.accounts.hole_0,
                    &ctx.accounts.hole_0_permission,
                    ctx.bumps.hole_0,
                )
            } else {
                (
                    &ctx.accounts.hole_1,
                    &ctx.accounts.hole_1_permission,
                    ctx.bumps.hole_1,
                )
            };
            let seat_arr = [seat as u8];
            let bump_arr = [hole_bump];
            let seat_seeds: &[&[u8]] = &[HOLE_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            let hole_info = hole.to_account_info();
            create_hidden_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &hole_info,
                    permission: &permission.to_account_info(),
                    vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                    magic_program: &ctx.accounts.magic_program.to_account_info(),
                    permission_program: &ctx.accounts.permission_program.to_account_info(),
                },
                table_seeds,
                seat_seeds,
                (8 + Hole::INIT_SPACE) as u32,
                None,
            )?;
            let mut data = hole_info.try_borrow_mut_data()?;
            Hole::blank(hole_bump, table_key, seat as u8).try_serialize(&mut &mut data[..])?;
        }
        ctx.accounts.table.seats_created = true;
        Ok(())
    }

    /// Rollup, permissionless. Hands both seats to the Match's Players: each seat must be blank,
    /// then it is stamped with its Player and its permission member is swapped from nobody to
    /// that Player. Only before play begins; never on a Player's call into a live Match.
    pub fn seat_players(ctx: Context<SeatPlayers>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.seats_created, HoldemError::SeatsMissing);
        require!(table.phase == TABLE_WAITING, HoldemError::WrongPhase);
        require!(!table.seats_open, HoldemError::SeatsOpen);
        require!(
            ctx.accounts.hole_0.is_blank() && ctx.accounts.hole_1.is_blank(),
            HoldemError::SeatNotBlank
        );
        let players = table.game.players;
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        ctx.accounts.hole_0.player = players[0];
        ctx.accounts.hole_1.player = players[1];
        ctx.accounts.hole_0.exit(&ID)?;
        ctx.accounts.hole_1.exit(&ID)?;
        for (seat, player) in players.into_iter().enumerate() {
            let (hole, permission) = if seat == 0 {
                (&ctx.accounts.hole_0, &ctx.accounts.hole_0_permission)
            } else {
                (&ctx.accounts.hole_1, &ctx.accounts.hole_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [hole.bump];
            let seat_seeds: &[&[u8]] = &[HOLE_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            swap_seat_members(
                &SeatAccounts {
                    table: &table_info,
                    seat: &hole.to_account_info(),
                    permission: &permission.to_account_info(),
                    vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                    magic_program: &ctx.accounts.magic_program.to_account_info(),
                    permission_program: &ctx.accounts.permission_program.to_account_info(),
                },
                table_seeds,
                seat_seeds,
                Some(player),
            )?;
        }
        ctx.accounts.table.seats_open = true;
        Ok(())
    }

    /// Rollup, permissionless. Once the Match is over (or voided): zeroes both seats and swaps
    /// their permission members to nobody, so nothing the Players could read is left and the
    /// seats are never without a private permission. The next `seat_players` hands them on.
    pub fn wipe_seats(ctx: Context<WipeSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.phase == TABLE_OVER, HoldemError::WrongPhase);
        require!(table.seats_open, HoldemError::SeatsNotOpen);
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        ctx.accounts.hole_0.wipe();
        ctx.accounts.hole_1.wipe();
        ctx.accounts.hole_0.exit(&ID)?;
        ctx.accounts.hole_1.exit(&ID)?;
        for seat in 0..2usize {
            let (hole, permission) = if seat == 0 {
                (&ctx.accounts.hole_0, &ctx.accounts.hole_0_permission)
            } else {
                (&ctx.accounts.hole_1, &ctx.accounts.hole_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [hole.bump];
            let seat_seeds: &[&[u8]] = &[HOLE_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            swap_seat_members(
                &SeatAccounts {
                    table: &table_info,
                    seat: &hole.to_account_info(),
                    permission: &permission.to_account_info(),
                    vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                    magic_program: &ctx.accounts.magic_program.to_account_info(),
                    permission_program: &ctx.accounts.permission_program.to_account_info(),
                },
                table_seeds,
                seat_seeds,
                None,
            )?;
        }
        ctx.accounts.table.seats_open = false;
        Ok(())
    }

    /// Rollup, operator only. Retires a table's seats: closes both Holes and their permissions
    /// and returns the rent to the table. Only an idle table with blank seats; this is the one
    /// place a seat's history may open, and nothing a Player can call reaches it.
    pub fn retire_seats(ctx: Context<RetireSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.seats_created, HoldemError::SeatsMissing);
        require!(table.phase == TABLE_IDLE, HoldemError::WrongPhase);
        require!(!table.seats_open, HoldemError::SeatsOpen);
        require!(
            ctx.accounts.hole_0.is_blank() && ctx.accounts.hole_1.is_blank(),
            HoldemError::SeatNotBlank
        );
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        for seat in 0..2usize {
            let (hole, permission) = if seat == 0 {
                (&ctx.accounts.hole_0, &ctx.accounts.hole_0_permission)
            } else {
                (&ctx.accounts.hole_1, &ctx.accounts.hole_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [hole.bump];
            let seat_seeds: &[&[u8]] = &[HOLE_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            close_private_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &hole.to_account_info(),
                    permission: &permission.to_account_info(),
                    vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                    magic_program: &ctx.accounts.magic_program.to_account_info(),
                    permission_program: &ctx.accounts.permission_program.to_account_info(),
                },
                table_seeds,
                seat_seeds,
            )?;
        }
        ctx.accounts.table.seats_created = false;
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // Rollup: the Match
    // ------------------------------------------------------------------------------------

    /// Rollup, permissionless. Gives up an Assignment whose Match never began: the table is Idle at
    /// the Assignment's epoch and the start window has passed, so `begin_match` can never accept it.
    /// Writes a Draw for it into the ring (the way `expire_start` writes one) and marks the table
    /// for a commit, so `finalize` refunds the Match from a committed result without waiting for the
    /// table's next Match. The epoch is untouched, so a later Assignment for it can still begin. At
    /// most once per Match (the ring refuses a second slot).
    pub fn skip_epoch(ctx: Context<SkipEpoch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts.assignment;
        let table = &mut ctx.accounts.table;
        require!(
            a.generation == table.generation && a.index == table.index,
            HoldemError::NotAssigned
        );
        require!(
            may_skip(
                table.phase == TABLE_IDLE,
                table.epoch,
                a.epoch,
                a.start_deadline,
                now
            ),
            HoldemError::CannotSkip
        );
        let (key, epoch) = (a.tesoro_match, table.epoch);
        kit(table.ring.record_never_begun(key, epoch, now))?;
        table.dirty = true;
        table.commit.on_result();
        Ok(())
    }

    /// Rollup, permissionless. Starts the Assignment's Match on its table: only if the table is
    /// Idle at exactly the assigned epoch with seats, the tesoro_core Match is still Active and a
    /// ring slot is free. Everything about the Match comes from the Assignment, never from the
    /// caller. It only reserves the slot; the Match starts when both Players have checked in.
    pub fn begin_match(ctx: Context<BeginMatch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts.assignment;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_IDLE, HoldemError::WrongPhase);
        require!(table.seats_created, HoldemError::SeatsMissing);
        require!(
            a.generation == table.generation && a.index == table.index && a.epoch == table.epoch,
            HoldemError::NotAssigned
        );
        let tesoro = &ctx.accounts.tesoro_match;
        require!(
            tesoro.inner.stage() == Stage::Active && tesoro.inner.game == ID.to_bytes(),
            HoldemError::BadTesoroMatch
        );
        require!(now <= a.start_deadline, HoldemError::StartWindowPassed);
        let epoch = table.epoch;
        table.slot = kit(table.ring.reserve(a.tesoro_match, epoch))?;
        table.tesoro_match = a.tesoro_match;
        table.start_deadline = a.start_deadline;
        table.checked_in = [false; 2];
        table.game = GameMatch {
            players: a.players,
            speed: a.speed,
            ..GameMatch::default()
        };
        table.phase = TABLE_WAITING;
        Ok(())
    }

    /// Rollup. A Player checks in. When both have, the Match starts: equal Chips, first hand,
    /// blinds posted.
    pub fn check_in(ctx: Context<CheckIn>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_WAITING, HoldemError::WrongPhase);
        require!(table.seats_open, HoldemError::SeatsNotOpen);
        require!(now <= table.start_deadline, HoldemError::StartWindowPassed);
        let seat = seat_of(&table.game.players, &ctx.accounts.player.key())?;
        table.checked_in[seat] = true;
        if table.checked_in == [true; 2] {
            table.phase = TABLE_LIVE;
            table.game.start(now)?;
        }
        Ok(())
    }

    /// Rollup, permissionless. A table whose Players did not both check in before the start
    /// deadline ends the Match so it can be settled from the ring like any other: the Player who
    /// checked in wins, and if neither did it is a no-show (`table_kit::absence_outcome`).
    pub fn expire_start(ctx: Context<TableOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_WAITING, HoldemError::WrongPhase);
        require!(now > table.start_deadline, HoldemError::NotTimedOut);
        match absence_outcome(table.checked_in) {
            Some(OUTCOME_WIN0) => {
                table.game.status = STATUS_OVER;
                table.game.winner = 0;
            }
            Some(OUTCOME_WIN1) => {
                table.game.status = STATUS_OVER;
                table.game.winner = 1;
            }
            _ => {
                table.game.status = STATUS_CANCELLED;
                table.game.no_show = true;
            }
        }
        table.game.phase = PHASE_NONE;
        conclude(table, now)
    }

    /// Rollup. A Player folds a fresh secret into this hand. It goes into the Player's own Hole
    /// only, and the public table is not written, so the transaction touches nothing both Players
    /// can read. The secret is spent at the deal and may not repeat.
    pub fn contribute_entropy(ctx: Context<ContributeEntropy>, secret: [u8; 32]) -> Result<()> {
        let table = &ctx.accounts.table;
        require_live(table)?;
        require!(
            table.game.phase == PHASE_SHUFFLE && !table.req_pending && !table.vrf_ready,
            HoldemError::WrongPhase
        );
        let hole = &mut ctx.accounts.hole;
        require!(!hole.contributed, HoldemError::AlreadyContributed);
        require!(
            deal::secret_hash(&secret) != hole.last_secret_hash,
            HoldemError::SecretReused
        );
        hole.secret = secret;
        hole.contributed = true;
        hole.hand_no = table.game.hand_no;
        Ok(())
    }

    /// Rollup, permissionless. Asks the oracle for this hand's randomness, once. The program
    /// chooses the input: the table, the Match, the epoch, the hand, the request number and the
    /// hashes of both frozen secrets. The answer is accepted only for this request.
    pub fn request_vrf(ctx: Context<RequestVrf>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require_live(table)?;
        let hand = table.game.hand_no;
        require!(table.game.phase == PHASE_SHUFFLE, HoldemError::WrongPhase);
        require!(
            !(table.req_pending
                || table.vrf_ready
                || (table.req_epoch == table.epoch && table.req_hand == hand)),
            HoldemError::AlreadyDealt
        );
        let holes = [&ctx.accounts.hole_0, &ctx.accounts.hole_1];
        require!(
            holes.iter().all(|h| h.contributed && h.hand_no == hand),
            HoldemError::EntropyIncomplete
        );
        let nonce = table.vrf_nonce;
        let hand_ctx = HandContext {
            tesoro_match: table.tesoro_match,
            generation: table.generation,
            index: table.index,
            epoch: table.epoch,
            hand_no: hand,
            nonce,
        };
        let caller_seed = deal::request_seed(
            &hand_ctx,
            &[
                deal::secret_hash(&holes[0].secret),
                deal::secret_hash(&holes[1].secret),
            ],
        );
        let marker = Table::request_marker(&table.key(), nonce);
        table.vrf_nonce = nonce.checked_add(1).ok_or(HoldemError::Overflow)?;
        table.req_nonce = nonce;
        table.req_pending = true;
        table.req_epoch = table.epoch;
        table.req_hand = hand;
        table.req_at = now;
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::VrfCallbackShuffle::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![
                SerializableAccountMeta {
                    pubkey: ctx.accounts.table.key(),
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.hole_0.key(),
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.hole_1.key(),
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: marker,
                    is_signer: false,
                    is_writable: false,
                },
            ]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Rollup. VRF callback: splits the oracle's output into a half per Hole. Accepted only for
    /// the one outstanding request of the current epoch and hand, named by its marker address,
    /// and only once.
    pub fn vrf_callback_shuffle(
        ctx: Context<VrfCallbackShuffle>,
        randomness: [u8; 32],
    ) -> Result<()> {
        let table = &mut ctx.accounts.table;
        require!(
            table.phase == TABLE_LIVE
                && table.game.status == STATUS_LIVE
                && table.game.phase == PHASE_SHUFFLE
                && table.req_pending
                && table.req_epoch == table.epoch
                && table.req_hand == table.game.hand_no,
            HoldemError::StaleRequest
        );
        let nonce = table.req_nonce;
        let halves = [
            deal::vrf_half(0, &randomness, nonce),
            deal::vrf_half(1, &randomness, nonce),
        ];
        for (hole, half) in [&mut ctx.accounts.hole_0, &mut ctx.accounts.hole_1]
            .into_iter()
            .zip(halves)
        {
            hole.half = half;
            hole.half_set = true;
        }
        table.req_pending = false;
        table.vrf_ready = true;
        Ok(())
    }

    /// Rollup, permissionless. Once the answer is in: derives the seed, draws the nine cards,
    /// writes each Player's hole cards and their shares of the board, zeroes every secret and
    /// half, and opens preflop betting. The seed and the deck are never stored.
    pub fn deal(ctx: Context<Deal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require_live(table)?;
        require!(table.game.phase == PHASE_SHUFFLE, HoldemError::WrongPhase);
        let hand = table.game.hand_no;
        require!(table.vrf_ready, HoldemError::EntropyIncomplete);
        {
            let holes = [&ctx.accounts.hole_0, &ctx.accounts.hole_1];
            require!(
                holes
                    .iter()
                    .all(|h| h.contributed && h.half_set && h.hand_no == hand && !h.dealt),
                HoldemError::EntropyIncomplete
            );
        }
        let hand_ctx = HandContext {
            tesoro_match: table.tesoro_match,
            generation: table.generation,
            index: table.index,
            epoch: table.epoch,
            hand_no: hand,
            nonce: table.req_nonce,
        };
        let (h0, h1) = (&mut **ctx.accounts.hole_0, &mut **ctx.accounts.hole_1);
        let seed = deal::derive_seed(
            &hand_ctx,
            &Contributions {
                secrets: [h0.secret, h1.secret],
                halves: [h0.half, h1.half],
                ext: [h0.ext_entropy, h1.ext_entropy],
            },
        );
        let (cards, board) = deal::split_hand(&deal::draw_hand(&seed));
        let shares = deal::board_shares(&seed, &board);
        for ((hole, hole_cards), share) in [&mut *h0, &mut *h1].into_iter().zip(cards).zip(shares) {
            hole.last_secret_hash = deal::secret_hash(&hole.secret);
            hole.spend_secrets();
            hole.cards = hole_cards;
            hole.shares = share;
            hole.dealt = true;
        }
        table.vrf_ready = false;
        table.game.on_dealt(&board, &cards, now)?;
        after_move(table, [h0, h1], now)
    }

    /// Rollup. A Player acts on their turn.
    pub fn act(ctx: Context<Act>, action: Action) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require_live(table)?;
        let seat = seat_of(&table.game.players, &ctx.accounts.player.key())?;
        let (h0, h1) = (&mut **ctx.accounts.hole_0, &mut **ctx.accounts.hole_1);
        let board = deal::combine_shares(&[h0.shares, h1.shares]);
        let cards = [h0.cards, h1.cards];
        table.game.act(seat, action, &board, &cards, now)?;
        after_move(table, [h0, h1], now)
    }

    /// Rollup, permissionless. Once the current deadline has passed: an idle Player is checked
    /// (or folded when facing a bet); missing entropy cancels hand one (no-show, both entries
    /// refunded) or forfeits a later hand; an answer that never comes ends the hand in a refund;
    /// three missed turns in a row forfeit the Match.
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require_live(table)?;
        let hand = table.game.hand_no;
        let (h0, h1) = (&mut **ctx.accounts.hole_0, &mut **ctx.accounts.hole_1);
        let shuffle = engine::Shuffle {
            contributed: [
                h0.contributed && h0.hand_no == hand,
                h1.contributed && h1.hand_no == hand,
            ],
            vrf_ready: table.vrf_ready,
        };
        let board = deal::combine_shares(&[h0.shares, h1.shares]);
        let cards = [h0.cards, h1.cards];
        table.game.timeout(shuffle, &board, &cards, now)?;
        after_move(table, [h0, h1], now)
    }

    // ------------------------------------------------------------------------------------
    // Rollup: after the Match
    // ------------------------------------------------------------------------------------

    /// Rollup, permissionless. Commits the finished table to Solana, paid by the Sponsor. The
    /// first commit of a result is owed once (the table is `dirty` until then). A commit can be
    /// lost on its way to base without the rollup noticing, so it may be repeated while the ring
    /// holds a young Done result, with a wait that doubles from two minutes to an hour (see
    /// `table_kit::CommitGuard`); nobody can drain the Sponsor by calling it again and again.
    /// Only the public table is ever committed.
    pub fn commit_table(ctx: Context<CommitTable>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        kit(table.commit.allow(
            table.dirty && (table.phase == TABLE_OVER || table.phase == TABLE_IDLE),
            &table.ring,
            now,
        ))?;
        table.dirty = false;
        table.commit.record(now);
        table.exit(&ID)?;
        let bump = [ctx.accounts.sponsor.bump];
        sponsor_commit(
            &ctx.accounts.sponsor.to_account_info(),
            &[SPONSOR_SEED, &bump],
            &ctx.accounts.magic_context.to_account_info(),
            &ctx.accounts.magic_program.to_account_info(),
            &ctx.accounts.magic_fee_vault.to_account_info(),
            &TEE_VALIDATOR,
            &ctx.accounts.table.to_account_info(),
        )
    }

    /// Rollup, permissionless. Wipes the finished Match from the public table and moves to the
    /// next epoch. Needs the result committed (`dirty` cleared), the seats wiped and a short
    /// delay for clients to read the final board. The ring is kept.
    pub fn reset_table(ctx: Context<TableOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_OVER, HoldemError::WrongPhase);
        require!(!table.seats_open, HoldemError::SeatsOpen);
        require!(!table.dirty, HoldemError::NotCommitted);
        require!(
            now >= table
                .over_at
                .checked_add(RESET_DELAY_SECS)
                .ok_or(HoldemError::Overflow)?,
            HoldemError::ResetTooEarly
        );
        table.reset().ok_or(HoldemError::Overflow)?;
        Ok(())
    }

    /// Rollup, permissionless. A table whose Match tesoro_core has already frozen (it refunded,
    /// say after an outage) before the table produced a result is given up: the reserved slot is
    /// freed and the table moves to Over, ready to wipe its seats and reset.
    pub fn void_table(ctx: Context<Release>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(
            table.phase == TABLE_WAITING || table.phase == TABLE_LIVE,
            HoldemError::WrongPhase
        );
        let at =
            receipt_at(&ctx.accounts.receipt, &table.tesoro_match).ok_or(HoldemError::NoReceipt)?;
        require!(
            now >= at
                .checked_add(RELEASE_DELAY_SECS)
                .ok_or(HoldemError::Overflow)?,
            HoldemError::NoReceipt
        );
        let (slot, key) = (table.slot, table.tesoro_match);
        kit(table.ring.free(slot, &key, SLOT_RESERVED))?;
        table.game.status = STATUS_CANCELLED;
        table.game.winner = NO_WINNER;
        table.phase = TABLE_OVER;
        table.over_at = now;
        table.dirty = false;
        table.req_pending = false;
        table.vrf_ready = false;
        Ok(())
    }

    /// Rollup, permissionless. Frees a Done ring slot once tesoro_core has frozen its Match (the
    /// receipt, read a minute after it was written), or once the Match account itself has been
    /// gone for 15 days. A missing or doubtful read keeps the slot.
    pub fn release_slot(ctx: Context<Release>, index: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        let slot = *table
            .ring
            .slots
            .get(index as usize)
            .ok_or(HoldemError::BadSlot)?;
        require!(slot.state == SLOT_DONE, HoldemError::BadSlot);
        let proven = match receipt_at(&ctx.accounts.receipt, &slot.match_key) {
            Some(at) => {
                now >= at
                    .checked_add(RELEASE_DELAY_SECS)
                    .ok_or(HoldemError::Overflow)?
            }
            None => {
                match_state_gone(&ctx.accounts.match_state, &slot.match_key)
                    && now
                        >= slot
                            .at
                            .checked_add(STALE_SLOT_SECS)
                            .ok_or(HoldemError::Overflow)?
            }
        };
        require!(proven, HoldemError::NoReceipt);
        kit(table.ring.free(index, &slot.match_key, SLOT_DONE))?;
        Ok(())
    }

    /// Rollup, operator. Moves lamports from a fuel reserve into the Sponsor.
    pub fn refill_sponsor(ctx: Context<RefillSponsor>, amount: u64) -> Result<()> {
        let keep = Rent::get()?.minimum_balance(8 + Fuel::INIT_SPACE);
        kit(move_lamports(
            &ctx.accounts.fuel.to_account_info(),
            &ctx.accounts.sponsor.to_account_info(),
            amount,
            keep,
        ))
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

/// The only delegation config the Game accepts: the TEE validator, no automatic commits (an
/// automatic commit would publish the table's history to the base layer mid-Match).
fn tee_config(validator: &Option<AccountInfo>) -> Result<DelegateConfig> {
    require!(
        validator.as_ref().is_some_and(|v| v.key() == TEE_VALIDATOR),
        HoldemError::InvalidValidator
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
        init_if_needed, payer = authority, space = 8 + TableConfig::INIT_SPACE,
        seeds = [CONFIG_SEED], bump
    )]
    pub config: Account<'info, TableConfig>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ HoldemError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::Holdem>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ HoldemError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(generation: u16, index: u16)]
pub struct CreateTable<'info> {
    #[account(mut, address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(
        init, payer = operator, space = 8 + Table::INIT_SPACE,
        seeds = [TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()], bump
    )]
    pub table: Box<Account<'info, Table>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateSponsor<'info> {
    #[account(mut, address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(init, payer = operator, space = 8 + Sponsor::INIT_SPACE, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: Account<'info, Sponsor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(n: u8)]
pub struct CreateFuel<'info> {
    #[account(mut, address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(init, payer = operator, space = 8 + Fuel::INIT_SPACE, seeds = [FUEL_SEED, &[n]], bump)]
    pub fuel: Account<'info, Fuel>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(generation: u16, index: u16)]
pub struct DelegateTable<'info> {
    #[account(mut, address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    /// CHECK: the table PDA to delegate
    #[account(mut, del, seeds = [TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()], bump)]
    pub table: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSponsor<'info> {
    #[account(mut, address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    /// CHECK: the Sponsor PDA to delegate
    #[account(mut, del, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(n: u8)]
pub struct DelegateFuel<'info> {
    #[account(mut, address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    /// CHECK: the fuel PDA to delegate
    #[account(mut, del, seeds = [FUEL_SEED, &[n]], bump)]
    pub fuel: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(generation: u16, index: u16, epoch: u64)]
pub struct AssignMatch<'info> {
    #[account(mut, address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(
        mut,
        seeds = [CORE_MATCH_SEED, tesoro_match.inner.id.opener.as_ref(), &tesoro_match.inner.id.n.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(
        seeds = [ACCOUNT_SEED, account_a.authority.as_ref()],
        bump = account_a.bump,
        seeds::program = tesoro_core::ID
    )]
    pub account_a: Account<'info, TesoroAccount>,
    #[account(
        seeds = [ACCOUNT_SEED, account_b.authority.as_ref()],
        bump = account_b.bump,
        seeds::program = tesoro_core::ID
    )]
    pub account_b: Account<'info, TesoroAccount>,
    /// CHECK: this Game's settlement authority PDA; it signs the deadline extension.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        init, payer = operator, space = 8 + Assignment::INIT_SPACE,
        seeds = [ASSIGN_SEED, tesoro_match.key().as_ref()], bump
    )]
    pub assignment: Account<'info, Assignment>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseAssignment<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut, close = payer,
        seeds = [ASSIGN_SEED, assignment.tesoro_match.as_ref()], bump = assignment.bump
    )]
    pub assignment: Account<'info, Assignment>,
    /// CHECK: receives the rent; must be the key that paid for the Assignment.
    #[account(mut, address = assignment.payer)]
    pub payer: UncheckedAccount<'info>,
    /// CHECK: the settlement receipt of the Match, verified by `receipt_at`.
    pub receipt: UncheckedAccount<'info>,
    /// CHECK: the tesoro_core Match account, checked by key in `match_state_gone`.
    pub match_state: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    /// Pays the settlement receipt's rent in tesoro_core.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [ASSIGN_SEED, assignment.tesoro_match.as_ref()], bump = assignment.bump)]
    pub assignment: Account<'info, Assignment>,
    /// CHECK: the table, read by hand: its address, owner (the delegation program or this
    /// program) and contents are checked in `finalize`.
    pub table: UncheckedAccount<'info>,
    #[account(
        mut,
        address = assignment.tesoro_match,
        seeds = [CORE_MATCH_SEED, tesoro_match.inner.id.opener.as_ref(), &tesoro_match.inner.id.n.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(seeds = [CORE_CONFIG_SEED], bump = config.bump, seeds::program = tesoro_core::ID)]
    pub config: Box<Account<'info, CoreConfig>>,
    #[account(
        seeds = [GAME_SEED, crate::ID.as_ref()],
        bump = game_record.bump,
        seeds::program = tesoro_core::ID
    )]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the registered Game authority; signs the CPI with its canonical bump.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this Game's own program account (tesoro_core reads its deploy slot).
    #[account(address = crate::ID)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: this program's ProgramData, checked by tesoro_core.
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: the settlement receipt, created by tesoro_core at `["settled", match]`.
    #[account(
        mut,
        seeds = [b"settled", tesoro_match.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub receipt: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: tesoro_core's event authority PDA.
    #[account(seeds = [b"__event_authority"], bump, seeds::program = tesoro_core::ID)]
    pub event_authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}

#[derive(Accounts)]
pub struct InitSeats<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: ephemeral Hole of seat 0, created here
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump)]
    pub hole_0: UncheckedAccount<'info>,
    /// CHECK: ephemeral Hole of seat 1, created here
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump)]
    pub hole_1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 0, created by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, hole_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 1
    #[account(mut, seeds = [PERMISSION_SEED, hole_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_1_permission: UncheckedAccount<'info>,
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

/// `seat_players` and `wipe_seats`: the only instructions (with `retire_seats`) that reach the
/// permission program. None is callable into a live Match: each checks the table phase first.
#[derive(Accounts)]
pub struct SeatPlayers<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
    /// CHECK: permission PDA of Hole 0
    #[account(mut, seeds = [PERMISSION_SEED, hole_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 1
    #[account(mut, seeds = [PERMISSION_SEED, hole_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_1_permission: UncheckedAccount<'info>,
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

#[derive(Accounts)]
pub struct WipeSeats<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
    /// CHECK: permission PDA of Hole 0
    #[account(mut, seeds = [PERMISSION_SEED, hole_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 1
    #[account(mut, seeds = [PERMISSION_SEED, hole_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_1_permission: UncheckedAccount<'info>,
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

#[derive(Accounts)]
pub struct RetireSeats<'info> {
    #[account(address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
    /// CHECK: permission PDA of Hole 0
    #[account(mut, seeds = [PERMISSION_SEED, hole_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Hole 1
    #[account(mut, seeds = [PERMISSION_SEED, hole_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hole_1_permission: UncheckedAccount<'info>,
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

#[derive(Accounts)]
pub struct RefundUntabled<'info> {
    /// Pays the settlement receipt's rent in tesoro_core.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: the Assignment address of the Match; the Match is refunded only while nothing sits here.
    #[account(seeds = [ASSIGN_SEED, tesoro_match.key().as_ref()], bump)]
    pub assignment: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CORE_MATCH_SEED, tesoro_match.inner.id.opener.as_ref(), &tesoro_match.inner.id.n.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(
        seeds = [GAME_SEED, crate::ID.as_ref()],
        bump = game_record.bump,
        seeds::program = tesoro_core::ID
    )]
    pub game_record: Box<Account<'info, GameRecord>>,
    /// CHECK: the registered Game authority; signs the CPI with its canonical bump.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this Game's own program account (tesoro_core reads its deploy slot).
    #[account(address = crate::ID)]
    pub game_program: UncheckedAccount<'info>,
    /// CHECK: this program's ProgramData, checked by tesoro_core.
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: the settlement receipt, created by tesoro_core at `["settled", match]`.
    #[account(
        mut,
        seeds = [b"settled", tesoro_match.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub receipt: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: tesoro_core's event authority PDA.
    #[account(seeds = [b"__event_authority"], bump, seeds::program = tesoro_core::ID)]
    pub event_authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}

#[derive(Accounts)]
pub struct SkipEpoch<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [ASSIGN_SEED, assignment.tesoro_match.as_ref()], bump = assignment.bump)]
    pub assignment: Account<'info, Assignment>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
}

#[derive(Accounts)]
pub struct BeginMatch<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [ASSIGN_SEED, assignment.tesoro_match.as_ref()], bump = assignment.bump)]
    pub assignment: Account<'info, Assignment>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(
        address = assignment.tesoro_match,
        seeds = [CORE_MATCH_SEED, tesoro_match.inner.id.opener.as_ref(), &tesoro_match.inner.id.n.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
}

/// A table and nothing else: `expire_start`, `reset_table`.
#[derive(Accounts)]
pub struct TableOnly<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
}

#[derive(Accounts)]
pub struct CheckIn<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
}

/// Touches the signer's own Hole and reads the table; the table is not written.
#[derive(Accounts)]
pub struct ContributeEntropy<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(
        mut,
        seeds = [HOLE_SEED, table.key().as_ref(), &[hole.seat]],
        bump = hole.bump,
        constraint = hole.player == player.key() @ HoldemError::NotAPlayer
    )]
    pub hole: Box<Account<'info, Hole>>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestVrf<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
    /// CHECK: validated by the VRF program
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallbackShuffle<'info> {
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
    /// CHECK: names the request this answer is for: the address `["vrfreq", table, nonce]` of the
    /// one outstanding request. The account itself need not exist.
    #[account(
        constraint = request.key() == Table::request_marker(&table.key(), table.req_nonce)
            @ HoldemError::StaleRequest
    )]
    pub request: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Deal<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
}

#[derive(Accounts)]
pub struct Act<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[0]], bump = hole_0.bump)]
    pub hole_0: Box<Account<'info, Hole>>,
    #[account(mut, seeds = [HOLE_SEED, table.key().as_ref(), &[1]], bump = hole_1.bump)]
    pub hole_1: Box<Account<'info, Hole>>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitTable<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: the TEE validator's magic fee vault, checked in `sponsor_commit`.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

/// `void_table` and `release_slot`.
#[derive(Accounts)]
pub struct Release<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: the settlement receipt of the Match, verified by `receipt_at`.
    pub receipt: UncheckedAccount<'info>,
    /// CHECK: the tesoro_core Match account, checked by key in `match_state_gone`.
    pub match_state: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefillSponsor<'info> {
    #[account(address = config.operator @ HoldemError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(mut, seeds = [FUEL_SEED, &[fuel.n]], bump = fuel.bump)]
    pub fuel: Account<'info, Fuel>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
}

#[cfg(test)]
mod predeploy_layouts;
