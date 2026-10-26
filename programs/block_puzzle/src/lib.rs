//! Block Burst Live: a real-time 1v1 Block Burst Match as a Tesoro Game, on persistent tables.
//! (The code id stays `block_puzzle`; the player-facing name is Block Burst.)
//!
//! Matches run on **tables** that stay delegated to MagicBlock's TEE rollup across Matches (see
//! the protocol note `table-protocol.md` and `crates/table_kit`). A table holds the public Match
//! and a ring of results with each result's move logs. Its two **Board** seats and the **Vault**
//! are rollup-only accounts behind private permissions, created once and kept for the table's life.
//!
//! * base: `assign_match` binds a tesoro_core Match to one table and epoch (write-once);
//!   `finalize` reads the committed, still-delegated table and settles through tesoro_core.
//! * rollup: `begin_match`, `seat_players`, `check_in`, `request_seed`, the oracle callback,
//!   `start`, `begin`, `play` / `play_hidden`, `close`; `commit_table`, `wipe_seats`, `reset_table`
//!   after the Match, and the ring / void recovery paths.
//!
//! Phases run in rollup slots (`SLOTS_PER_SEC`): `Assigned` (60 s to check in) -> `Seeding` (60 s
//! for the Seed) -> `GetReady` (10 s) -> the run (90 s plus a 3 s grace for moves already sent)
//! -> `Closed`. Both Players play the same Seed at the same time. The Seed is drawn from one VRF
//! request, stored only in the zero-member Vault, and copied to a Player's own Board by `begin`
//! once the run has started. From 80 s a `play` writes nothing public.
//!
//! Privacy rules this file keeps (`hidden-info.md`): a Board always has a private permission,
//! from creation until retirement; between Matches its data is zeroed and its member swapped to
//! nobody and then to the next Player, and only `seat_players`, `wipe_seats` and `init_seats` /
//! `retire_seats` do that, never inside a live Match and never on a Player's call; no hidden value
//! is logged or reaches an error code; no Player secret exists, so nothing a seat-holder wrote can
//! determine hidden data.

pub mod engine;
pub mod outcome;
pub mod state;

#[cfg(test)]
mod keeper_fixtures;

use anchor_lang::{prelude::*, system_program};
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
    assignment_absent, close_private_seat, create_hidden_seat, match_state_gone, may_skip,
    move_lamports, read_table, receipt_at, sponsor_commit, swap_seat_members, table_wait_over,
    KitError, SeatAccounts, OUTCOME_DRAW, OUTCOME_NO_SHOW, OUTCOME_WIN0, OUTCOME_WIN1, SLOT_DONE,
    SLOT_RESERVED,
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

declare_id!("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");

/// Identity of MagicBlock's TEE validator (devnet). Delegation is pinned to it: the validator a
/// delegation names is the only key that can commit state back, so a caller-chosen validator (or
/// none, which the delegation program reads as the public default validator) would let a Player
/// commit a table they won, or leave the table outside the TEE.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

#[error_code]
pub enum BlockPuzzleError {
    #[msg("Signer is not a Player of this Block Burst Match")]
    NotAPlayer,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Not valid in this phase of the Match")]
    WrongPhase,
    #[msg("The instruction names another Match, table generation or epoch")]
    StaleBinding,
    #[msg("The check-in window has ended")]
    CheckInClosed,
    #[msg("Already checked in")]
    AlreadyCheckedIn,
    #[msg("The Seed is not ready")]
    SeedNotReady,
    #[msg("The Seed window has ended")]
    SeedWindowClosed,
    #[msg("A Seed request is already waiting, or the requests are used up")]
    SeedRequestNotDue,
    #[msg("The randomness answer is not for the current request")]
    StaleRequest,
    #[msg("The run has not started")]
    NotStarted,
    #[msg("The run already began for this Player")]
    AlreadyBegan,
    #[msg("The Player has not begun the run")]
    NotBegan,
    #[msg("The run is over for this Player")]
    RunOver,
    #[msg("The play window is closed")]
    PlayWindowClosed,
    #[msg("The scores are hidden now: send the hidden play")]
    Frozen,
    #[msg("The scores are not hidden yet: send the public play")]
    NotFrozen,
    #[msg("The move count differs from the one expected")]
    WrongCount,
    #[msg("Submit between 1 and 8 moves")]
    BadBatch,
    #[msg("Illegal move")]
    IllegalMove,
    #[msg("Moves arrived faster than the pace allows")]
    TooFast,
    #[msg("The Match is not ready to be closed")]
    NotClosable,
    #[msg("Already settled or refunded in tesoro_core")]
    AlreadyFinalized,
    #[msg("The tesoro_core Match is not an Active Match of this Game")]
    BadTesoroMatch,
    #[msg("The Match is not over")]
    MatchNotOver,
    #[msg("Deadline has not passed")]
    NotTimedOut,
    #[msg("Delegation must name the TEE validator")]
    InvalidValidator,
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
    #[msg("The Block Burst Match cannot finish inside the core deadline")]
    BudgetTooShort,
    #[msg("That Match is not a joined Match without a table")]
    NotUntabled,
    #[msg("The Match has not waited long enough for a table")]
    TableWaitNotOver,
    #[msg("This Assignment cannot be given up yet, or any more")]
    CannotSkip,
}

impl From<KitError> for BlockPuzzleError {
    fn from(e: KitError) -> Self {
        match e {
            KitError::RingFull | KitError::RingDuplicate => BlockPuzzleError::RingFull,
            KitError::RingSlot => BlockPuzzleError::BadSlot,
            KitError::BadTable => BlockPuzzleError::BadTable,
            KitError::BadFeeVault => BlockPuzzleError::BadFeeVault,
            KitError::Overflow => BlockPuzzleError::Overflow,
            KitError::CommitNotDue => BlockPuzzleError::NotDirty,
        }
    }
}

fn kit<T>(r: core::result::Result<T, KitError>) -> Result<T> {
    r.map_err(|e| error!(BlockPuzzleError::from(e)))
}

fn ov<T>(v: Option<T>) -> Result<T> {
    v.ok_or_else(|| error!(BlockPuzzleError::Overflow))
}

/// What a finished Match tells the world when `finalize` starts its settlement (event-CPI).
#[event]
pub struct SessionSettled {
    pub match_state: Pubkey,
    /// The ring outcome: 1 opener wins, 2 joiner wins, 3 draw (refund), 4 no-show.
    pub outcome: u8,
    /// Why (`REASON_*`).
    pub reason: u8,
    pub scores: [u32; 2],
    pub counts: [u16; 2],
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
pub fn board_address(table: &Pubkey, seat: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BOARD_SEED, table.as_ref(), &[seat]], &ID)
}

/// The address of the Seed vault.
pub fn vault_address(table: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, table.as_ref()], &ID)
}

fn seat_of(players: &[Pubkey; 2], key: &Pubkey) -> Result<usize> {
    players
        .iter()
        .position(|p| p == key)
        .ok_or_else(|| error!(BlockPuzzleError::NotAPlayer))
}

fn require_binding(table: &Table, binding: &Binding) -> Result<()> {
    require!(*binding == table.binding(), BlockPuzzleError::StaleBinding);
    Ok(())
}

/// The seat belongs to this Match's Player and epoch.
fn require_board(table: &Table, board: &Board, player: &Pubkey) -> Result<usize> {
    let seat = seat_of(&table.players, player)?;
    require!(
        table.seats_open
            && board.seat as usize == seat
            && board.player == *player
            && board.tesoro_match == table.tesoro_match
            && board.epoch == table.epoch,
        BlockPuzzleError::NotAPlayer
    );
    Ok(seat)
}

/// What a Player sent: the move count they expect the Board to hold, the real moves, and whether it is
/// the hidden beat (which may be empty and may repeat moves already applied).
struct Batch<'a> {
    expected_count: u16,
    moves: &'a [MoveArg],
    beat: bool,
}

/// The run's moves, applied to the Player's own Board. Never touches the public table: both
/// `play` and `play_hidden` use it, and `play` copies the result to the table afterwards.
fn run_moves(
    table: &Table,
    board: &mut Board,
    player: &Pubkey,
    binding: &Binding,
    batch: Batch,
    clock: &Clock,
) -> Result<usize> {
    let Batch {
        expected_count,
        moves,
        beat,
    } = batch;
    require_binding(table, binding)?;
    require!(table.phase == TABLE_GET_READY, BlockPuzzleError::WrongPhase);
    let seat = require_board(table, board, player)?;
    require!(board.began, BlockPuzzleError::NotBegan);
    // Only the hidden beat is answered by a finished run, and only with nothing to apply.
    require!(!board.over || beat, BlockPuzzleError::RunOver);
    let slot = clock.slot;
    require!(slot >= table.start_slot, BlockPuzzleError::NotStarted);
    require!(
        slot <= ov(table.play_end())?,
        BlockPuzzleError::PlayWindowClosed
    );
    require!(
        moves.len() <= MAX_PLAY_BATCH && (beat || !moves.is_empty()),
        BlockPuzzleError::BadBatch
    );
    // A hidden beat may repeat moves the Board already holds (a resend after an unknown outcome,
    // or a beat that lands after a later one): those are skipped, up to the whole batch.
    // Anything else must start exactly at the Board's count.
    let skip = if beat && expected_count < board.moves {
        usize::from(board.moves - expected_count).min(moves.len())
    } else {
        0
    };
    require!(
        board.moves == expected_count || (beat && expected_count < board.moves),
        BlockPuzzleError::WrongCount
    );
    let moves = &moves[skip..];
    // A finished run still answers the hidden beat with an empty batch: the rhythm never stops.
    require!(!board.over || moves.is_empty(), BlockPuzzleError::RunOver);
    // Pace: moves landed so far, over the elapsed slots, plus the burst.
    let total = u64::from(board.moves)
        .checked_add(moves.len() as u64)
        .ok_or(BlockPuzzleError::Overflow)?;
    let elapsed = slot - table.start_slot;
    let allowed = MOVES_PER_SEC
        .checked_mul(elapsed)
        .and_then(|v| v.checked_add(MOVE_BURST * SLOTS_PER_SEC))
        .ok_or(BlockPuzzleError::Overflow)?;
    require!(total * SLOTS_PER_SEC <= allowed, BlockPuzzleError::TooFast);
    // Outage rule: a long gap with too few slots in it marks the seat.
    let gap_slots = slot.saturating_sub(board.last_slot);
    let gap_secs = clock.unix_timestamp.saturating_sub(board.last_ts);
    if stalled(gap_slots, gap_secs) {
        board.stalled = true;
    }
    board.last_slot = slot;
    board.last_ts = clock.unix_timestamp;

    let offset = u16::try_from(elapsed).unwrap_or(u16::MAX);
    let mut state = board.engine_state();
    let mut index = usize::from(state.moves);
    for m in moves.iter() {
        let hand_base = state.hand_base();
        state
            .apply(engine::Move {
                piece: m.piece,
                x: m.x,
                y: m.y,
            })
            .map_err(|_| error!(BlockPuzzleError::IllegalMove))?;
        *board
            .log
            .get_mut(index)
            .ok_or(BlockPuzzleError::IllegalMove)? = pack_move(hand_base, m);
        ov(board.set_offset(index, offset))?;
        index = ov(index.checked_add(1))?;
    }
    board.store_engine_state(&state);
    Ok(seat)
}

/// Writes the Match's result: the ring slot reserved at the start, the run log of that slot and
/// the public result fields; the table moves to Closed and is owed a commit.
fn conclude(table: &mut Table, now: i64, outcome: u8, reason: u8, log: RunLog) -> Result<()> {
    let (slot, key, epoch) = (table.slot, table.tesoro_match, table.epoch);
    kit(table.ring.record(slot, &key, epoch, outcome, now))?;
    table.final_scores = log.scores;
    table.final_moves = log.counts;
    table.shown_score = log.scores;
    table.shown_moves = log.counts;
    *table
        .logs
        .get_mut(slot as usize)
        .ok_or(BlockPuzzleError::BadSlot)? = log;
    table.outcome = outcome;
    table.reason = reason;
    table.phase = TABLE_CLOSED;
    table.over_at = now;
    table.dirty = true;
    table.commit.on_result();
    table.req_pending = false;
    Ok(())
}

fn blank_log(reason: u8) -> RunLog {
    let mut log = RunLog::blank();
    log.engine_version = ENGINE_VERSION;
    log.reason = reason;
    log
}

#[ephemeral]
#[program]
pub mod block_puzzle {
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
            BlockPuzzleError::BadConfig
        );
        let config = &mut ctx.accounts.config;
        require!(generation >= config.generation, BlockPuzzleError::BadConfig);
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
            BlockPuzzleError::BadTableSlot
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
    /// epoch, once. The Players are copied from the Match, the start deadline is fixed here, and
    /// the Match's refund timer is held past the whole table window. Refused unless the core
    /// deadline leaves room for the start window, every phase and settlement
    /// (`ASSIGN_BUDGET_SECS`).
    pub fn assign_match(
        ctx: Context<AssignMatch>,
        generation: u16,
        index: u16,
        epoch: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            generation == config.generation && index < config.max_tables,
            BlockPuzzleError::BadTableSlot
        );
        let tesoro = &ctx.accounts.tesoro_match;
        require!(
            tesoro.inner.stage() == Stage::Active
                && tesoro.inner.game == ID.to_bytes()
                && tesoro.inner.a.player == ctx.accounts.account_a.key().to_bytes()
                && tesoro
                    .inner
                    .b
                    .as_ref()
                    .is_some_and(|b| b.player == ctx.accounts.account_b.key().to_bytes()),
            BlockPuzzleError::BadTesoroMatch
        );
        let now = Clock::get()?.unix_timestamp;
        let needed = now
            .checked_add(START_WINDOW_SECS)
            .and_then(|t| t.checked_add(ASSIGN_BUDGET_SECS))
            .ok_or(BlockPuzzleError::Overflow)?;
        let hold = now
            .checked_add(TABLE_WINDOW_SECS)
            .ok_or(BlockPuzzleError::Overflow)?
            .min(tesoro.inner.deadline_abs)
            .max(tesoro.inner.deadline);
        require!(
            tesoro.inner.deadline > now && hold >= needed,
            BlockPuzzleError::BudgetTooShort
        );
        if hold > tesoro.inner.deadline {
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
                hold,
            )?;
        }
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
        a.start_deadline = now
            .checked_add(START_WINDOW_SECS)
            .ok_or(BlockPuzzleError::Overflow)?;
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
            BlockPuzzleError::NotUntabled
        );
        require!(
            assignment_absent(
                &ctx.accounts.assignment.to_account_info(),
                &ctx.accounts.assignment.key()
            ),
            BlockPuzzleError::NotUntabled
        );
        require!(
            table_wait_over(m.deadline, m.deadline_abs, now),
            BlockPuzzleError::TableWaitNotOver
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
                event_authority: ctx.accounts.core_event_authority.to_account_info(),
                program: ctx.accounts.tesoro_program.to_account_info(),
            },
            signer_seeds,
        )
        .with_remaining_accounts(remaining);
        tesoro_core::cpi::refund_match(cpi)?;
        emit_cpi!(SessionSettled {
            match_state: ctx.accounts.tesoro_match.key(),
            outcome: OUTCOME_DRAW,
            reason: REASON_NONE,
            scores: [0; 2],
            counts: [0; 2],
        });
        Ok(())
    }

    /// Base, permissionless. Closes an Assignment once tesoro_core has frozen its Match (the
    /// receipt exists) or the Match account is gone; the rent goes back to whoever paid it.
    pub fn close_assignment(ctx: Context<CloseAssignment>) -> Result<()> {
        let key = ctx.accounts.assignment.tesoro_match;
        require!(
            receipt_at(&ctx.accounts.receipt, &key).is_some()
                || match_state_gone(&ctx.accounts.match_state, &key),
            BlockPuzzleError::NoReceipt
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
            BlockPuzzleError::BadTable
        );
        let (outcome, log) = match table.ring.find(&assignment.tesoro_match, assignment.epoch) {
            Some((i, slot)) if slot.state == SLOT_DONE => {
                (slot.outcome, table.logs.get(i as usize).cloned())
            }
            Some(_) => return err!(BlockPuzzleError::MatchNotOver),
            None => {
                // The slot is freed only after tesoro_core froze the Match, so an absent slot is
                // proof of "never ran" only once the table is past that epoch.
                require!(table.epoch > assignment.epoch, BlockPuzzleError::NoResult);
                require!(
                    now > assignment.start_deadline,
                    BlockPuzzleError::NotTimedOut
                );
                (OUTCOME_DRAW, None)
            }
        };
        let log = log.unwrap_or_else(|| blank_log(REASON_NONE));

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
                    event_authority: ctx.accounts.core_event_authority.to_account_info(),
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
                _ => return err!(BlockPuzzleError::NoResult),
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
                    event_authority: ctx.accounts.core_event_authority.to_account_info(),
                    program: ctx.accounts.tesoro_program.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(remaining);
            tesoro_core::cpi::settle_match(cpi, result)?;
        }
        emit_cpi!(SessionSettled {
            match_state: assignment.tesoro_match,
            outcome,
            reason: log.reason,
            scores: log.scores,
            counts: log.counts,
        });
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // Rollup: seats
    // ------------------------------------------------------------------------------------

    /// Rollup, permissionless, once per table. Creates the two Boards and the Vault as ephemeral
    /// accounts behind private permissions with no member. The table pays the rent. They are
    /// never closed while the table runs.
    pub fn init_seats(ctx: Context<InitSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(!table.seats_created, BlockPuzzleError::SeatsOpen);
        require!(table.phase == TABLE_IDLE, BlockPuzzleError::WrongPhase);
        let table_key = table.key();
        let gen = table.generation.to_le_bytes();
        let idx = table.index.to_le_bytes();
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let vault_info = ctx.accounts.ephemeral_vault.to_account_info();
        let magic = ctx.accounts.magic_program.to_account_info();
        let perm_program = ctx.accounts.permission_program.to_account_info();
        for seat in 0..2usize {
            let (board, permission, board_bump) = if seat == 0 {
                (
                    &ctx.accounts.board_0,
                    &ctx.accounts.board_0_permission,
                    ctx.bumps.board_0,
                )
            } else {
                (
                    &ctx.accounts.board_1,
                    &ctx.accounts.board_1_permission,
                    ctx.bumps.board_1,
                )
            };
            let seat_arr = [seat as u8];
            let bump_arr = [board_bump];
            let seat_seeds: &[&[u8]] = &[BOARD_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            let board_info = board.to_account_info();
            create_hidden_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &board_info,
                    permission: &permission.to_account_info(),
                    vault: &vault_info,
                    magic_program: &magic,
                    permission_program: &perm_program,
                },
                table_seeds,
                seat_seeds,
                (8 + Board::INIT_SPACE) as u32,
                None,
            )?;
            let mut data = board_info.try_borrow_mut_data()?;
            Board::blank(board_bump, table_key, seat as u8).try_serialize(&mut &mut data[..])?;
        }
        let vault_bump = ctx.bumps.seed_vault;
        let vb = [vault_bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, table_key.as_ref(), &vb];
        let seed_vault_info = ctx.accounts.seed_vault.to_account_info();
        create_hidden_seat(
            &SeatAccounts {
                table: &table_info,
                seat: &seed_vault_info,
                permission: &ctx.accounts.seed_vault_permission.to_account_info(),
                vault: &vault_info,
                magic_program: &magic,
                permission_program: &perm_program,
            },
            table_seeds,
            vault_seeds,
            (8 + Vault::INIT_SPACE) as u32,
            None,
        )?;
        let mut data = seed_vault_info.try_borrow_mut_data()?;
        Vault::blank(vault_bump, table_key).try_serialize(&mut &mut data[..])?;
        drop(data);
        ctx.accounts.table.seats_created = true;
        Ok(())
    }

    /// Rollup, permissionless. Hands both Boards to the Match's Players: each seat must be blank,
    /// then it is stamped with its Player, the Match and the epoch, and its permission member is
    /// swapped from nobody to that Player. Only while the Match is Assigned; never on a Player's
    /// call into a live Match.
    pub fn seat_players(ctx: Context<SeatPlayers>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.seats_created, BlockPuzzleError::SeatsMissing);
        require!(table.phase == TABLE_ASSIGNED, BlockPuzzleError::WrongPhase);
        require!(!table.seats_open, BlockPuzzleError::SeatsOpen);
        require!(
            ctx.accounts.board_0.is_blank()
                && ctx.accounts.board_1.is_blank()
                && ctx.accounts.seed_vault.is_blank(),
            BlockPuzzleError::SeatNotBlank
        );
        let players = table.players;
        let (key, epoch) = (table.tesoro_match, table.epoch);
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        for (board, player) in [&mut ctx.accounts.board_0, &mut ctx.accounts.board_1]
            .into_iter()
            .zip(players)
        {
            board.player = player;
            board.tesoro_match = key;
            board.epoch = epoch;
        }
        ctx.accounts.board_0.exit(&ID)?;
        ctx.accounts.board_1.exit(&ID)?;
        for (seat, player) in players.into_iter().enumerate() {
            let (board, permission) = if seat == 0 {
                (&ctx.accounts.board_0, &ctx.accounts.board_0_permission)
            } else {
                (&ctx.accounts.board_1, &ctx.accounts.board_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [board.bump];
            let seat_seeds: &[&[u8]] = &[BOARD_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            swap_seat_members(
                &SeatAccounts {
                    table: &table_info,
                    seat: &board.to_account_info(),
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

    /// Rollup, permissionless. Once the Match is closed (or voided): zeroes both Boards and the
    /// Vault and swaps the Boards' permission members to nobody, so nothing the Players could
    /// read is left and the seats are never without a private permission. The next
    /// `seat_players` hands them on.
    pub fn wipe_seats(ctx: Context<WipeSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.phase == TABLE_CLOSED, BlockPuzzleError::WrongPhase);
        require!(table.seats_open, BlockPuzzleError::SeatsNotOpen);
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        ctx.accounts.board_0.wipe();
        ctx.accounts.board_1.wipe();
        ctx.accounts.seed_vault.wipe();
        ctx.accounts.board_0.exit(&ID)?;
        ctx.accounts.board_1.exit(&ID)?;
        ctx.accounts.seed_vault.exit(&ID)?;
        for seat in 0..2usize {
            let (board, permission) = if seat == 0 {
                (&ctx.accounts.board_0, &ctx.accounts.board_0_permission)
            } else {
                (&ctx.accounts.board_1, &ctx.accounts.board_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [board.bump];
            let seat_seeds: &[&[u8]] = &[BOARD_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            swap_seat_members(
                &SeatAccounts {
                    table: &table_info,
                    seat: &board.to_account_info(),
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

    /// Rollup, operator only. Retires a table's seats: closes both Boards, the Vault and their
    /// permissions and returns the rent to the table. Only an idle table with blank seats; this is
    /// the one place a seat's history may open, and nothing a Player can call reaches it.
    pub fn retire_seats(ctx: Context<RetireSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.seats_created, BlockPuzzleError::SeatsMissing);
        require!(table.phase == TABLE_IDLE, BlockPuzzleError::WrongPhase);
        require!(!table.seats_open, BlockPuzzleError::SeatsOpen);
        require!(
            ctx.accounts.board_0.is_blank()
                && ctx.accounts.board_1.is_blank()
                && ctx.accounts.seed_vault.is_blank(),
            BlockPuzzleError::SeatNotBlank
        );
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        let vault_info = ctx.accounts.ephemeral_vault.to_account_info();
        let magic = ctx.accounts.magic_program.to_account_info();
        let perm_program = ctx.accounts.permission_program.to_account_info();
        for seat in 0..2usize {
            let (board, permission) = if seat == 0 {
                (&ctx.accounts.board_0, &ctx.accounts.board_0_permission)
            } else {
                (&ctx.accounts.board_1, &ctx.accounts.board_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [board.bump];
            let seat_seeds: &[&[u8]] = &[BOARD_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            close_private_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &board.to_account_info(),
                    permission: &permission.to_account_info(),
                    vault: &vault_info,
                    magic_program: &magic,
                    permission_program: &perm_program,
                },
                table_seeds,
                seat_seeds,
            )?;
        }
        let vb = [ctx.accounts.seed_vault.bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, table_key.as_ref(), &vb];
        close_private_seat(
            &SeatAccounts {
                table: &table_info,
                seat: &ctx.accounts.seed_vault.to_account_info(),
                permission: &ctx.accounts.seed_vault_permission.to_account_info(),
                vault: &vault_info,
                magic_program: &magic,
                permission_program: &perm_program,
            },
            table_seeds,
            vault_seeds,
        )?;
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
            BlockPuzzleError::NotAssigned
        );
        require!(
            may_skip(
                table.phase == TABLE_IDLE,
                table.epoch,
                a.epoch,
                a.start_deadline,
                now
            ),
            BlockPuzzleError::CannotSkip
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
    /// caller. The check-in window runs from here.
    pub fn begin_match(ctx: Context<BeginMatch>) -> Result<()> {
        let clock = Clock::get()?;
        let a = &ctx.accounts.assignment;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_IDLE, BlockPuzzleError::WrongPhase);
        require!(table.seats_created, BlockPuzzleError::SeatsMissing);
        require!(
            a.generation == table.generation && a.index == table.index && a.epoch == table.epoch,
            BlockPuzzleError::NotAssigned
        );
        let tesoro = &ctx.accounts.tesoro_match;
        require!(
            tesoro.inner.stage() == Stage::Active && tesoro.inner.game == ID.to_bytes(),
            BlockPuzzleError::BadTesoroMatch
        );
        require!(
            clock.unix_timestamp <= a.start_deadline,
            BlockPuzzleError::StartWindowPassed
        );
        let epoch = table.epoch;
        table.slot = kit(table.ring.reserve(a.tesoro_match, epoch))?;
        let reserved = table.slot as usize;
        *table
            .logs
            .get_mut(reserved)
            .ok_or(BlockPuzzleError::BadSlot)? = RunLog::blank();
        table.tesoro_match = a.tesoro_match;
        table.start_deadline = a.start_deadline;
        table.players = a.players;
        table.checked_in = [false; 2];
        table.assigned_slot = clock.slot;
        table.assigned_ts = clock.unix_timestamp;
        table.phase = TABLE_ASSIGNED;
        Ok(())
    }

    /// Rollup. A Player checks in: attendance only, no CPI. The second check-in starts the Seed
    /// window.
    pub fn check_in(ctx: Context<CheckIn>, binding: Binding) -> Result<()> {
        let slot = Clock::get()?.slot;
        let table = &mut ctx.accounts.table;
        require_binding(table, &binding)?;
        require!(table.phase == TABLE_ASSIGNED, BlockPuzzleError::WrongPhase);
        require!(table.seats_open, BlockPuzzleError::SeatsNotOpen);
        require!(
            slot <= ov(table.checkin_end())?,
            BlockPuzzleError::CheckInClosed
        );
        let seat = seat_of(&table.players, &ctx.accounts.player.key())?;
        require!(!table.checked_in[seat], BlockPuzzleError::AlreadyCheckedIn);
        table.checked_in[seat] = true;
        if table.checked_in == [true; 2] {
            table.phase = TABLE_SEEDING;
            table.seeding_slot = slot;
        }
        Ok(())
    }

    /// Rollup, permissionless. Asks the oracle for the Seed's randomness. The program chooses the
    /// input (the Match, table, epoch and request number) and the answer is accepted only for this
    /// request. A request is retried every `SEED_RETRY_SECS` while no answer has come, at most
    /// `MAX_SEED_REQUESTS` times, and never extends the Seed window.
    pub fn request_seed(ctx: Context<RequestSeed>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_SEEDING, BlockPuzzleError::WrongPhase);
        require!(!table.seed_ready, BlockPuzzleError::SeedRequestNotDue);
        require!(
            slot <= ov(table.seed_end())?,
            BlockPuzzleError::SeedWindowClosed
        );
        require!(
            table.req_count < MAX_SEED_REQUESTS
                && (!table.req_pending
                    || slot >= ov(table.req_slot.checked_add(SEED_RETRY_SLOTS))?),
            BlockPuzzleError::SeedRequestNotDue
        );
        let nonce = table.vrf_nonce;
        let caller_seed = request_input(
            &table.tesoro_match,
            table.generation,
            table.index,
            table.epoch,
            nonce,
        );
        let marker = Table::request_marker(&table.key(), nonce);
        table.vrf_nonce = ov(nonce.checked_add(1))?;
        table.req_nonce = nonce;
        table.req_pending = true;
        table.req_epoch = table.epoch;
        table.req_slot = slot;
        table.req_count = ov(table.req_count.checked_add(1))?;
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::SeedCallback::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![
                SerializableAccountMeta {
                    pubkey: ctx.accounts.table.key(),
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.seed_vault.key(),
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

    /// Rollup, called by the VRF program only. Stores the Seed in the zero-member Vault if it
    /// answers the one outstanding request of this epoch while the table is Seeding. The output
    /// itself is not kept.
    pub fn seed_callback(ctx: Context<SeedCallback>, randomness: [u8; 32]) -> Result<()> {
        let table = &mut ctx.accounts.table;
        require!(
            table.phase == TABLE_SEEDING
                && table.req_pending
                && table.req_epoch == table.epoch
                && !table.seed_ready,
            BlockPuzzleError::StaleRequest
        );
        let seed = derive_seed(
            &table.tesoro_match,
            table.generation,
            table.index,
            table.epoch,
            table.req_nonce,
            &randomness,
        );
        let vault = &mut ctx.accounts.seed_vault;
        vault.seed = seed;
        vault.ready = true;
        table.req_pending = false;
        table.seed_ready = true;
        Ok(())
    }

    /// Rollup, permissionless. Sets the one shared clock once both have checked in and the Seed
    /// is in: the run begins `GET_READY_SECS` from now. Reveals nothing.
    pub fn start(ctx: Context<TableOnly>) -> Result<()> {
        let clock = Clock::get()?;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_SEEDING, BlockPuzzleError::WrongPhase);
        require!(table.seed_ready, BlockPuzzleError::SeedNotReady);
        require!(
            clock.slot <= ov(table.seed_end())?,
            BlockPuzzleError::SeedWindowClosed
        );
        table.ready_slot = clock.slot;
        table.ready_ts = clock.unix_timestamp;
        table.start_slot = ov(clock.slot.checked_add(GET_READY_SLOTS))?;
        table.phase = TABLE_GET_READY;
        Ok(())
    }

    /// Rollup, the Player. The first instruction once the run has started: copies the Seed from
    /// the Vault into the Player's own Board. Writes nothing public.
    pub fn begin(ctx: Context<Begin>, binding: Binding) -> Result<()> {
        let clock = Clock::get()?;
        let table = &ctx.accounts.table;
        require_binding(table, &binding)?;
        require!(table.phase == TABLE_GET_READY, BlockPuzzleError::WrongPhase);
        let player = ctx.accounts.player.key();
        let board = &mut ctx.accounts.board;
        require_board(table, board, &player)?;
        require!(clock.slot >= table.start_slot, BlockPuzzleError::NotStarted);
        require!(
            clock.slot <= ov(table.play_end())?,
            BlockPuzzleError::PlayWindowClosed
        );
        require!(!board.began, BlockPuzzleError::AlreadyBegan);
        require!(
            ctx.accounts.seed_vault.ready,
            BlockPuzzleError::SeedNotReady
        );
        board.seed = ctx.accounts.seed_vault.seed;
        board.began = true;
        board.last_slot = clock.slot;
        board.last_ts = clock.unix_timestamp;
        Ok(())
    }

    /// Rollup, the Player. Replays 1 to 8 moves on the Player's Board with the engine, and shows
    /// the new score and move count on the public table. Refused from the freeze: send
    /// `play_hidden` then. An illegal move rejects the whole transaction.
    pub fn play(
        ctx: Context<Play>,
        binding: Binding,
        expected_count: u16,
        moves: Vec<MoveArg>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let table = &mut ctx.accounts.table;
        require!(
            clock.slot < ov(table.freeze_slot())?,
            BlockPuzzleError::Frozen
        );
        let player = ctx.accounts.player.key();
        let board = &mut ctx.accounts.board;
        let seat = run_moves(
            table,
            board,
            &player,
            &binding,
            Batch {
                expected_count,
                moves: &moves,
                beat: false,
            },
            &clock,
        )?;
        table.shown_score[seat] = board.score;
        table.shown_moves[seat] = board.moves;
        Ok(())
    }

    /// Rollup, the Player. The hidden beat. From the freeze every Player sends exactly one of
    /// these on a fixed rhythm whether or not they moved, so the notifications a watcher gets on
    /// the table, the Player's wallet and this program carry no move timing. The shape never
    /// varies: `count` (0 to 8) of the `MAX_PLAY_BATCH` fixed `moves` entries are real, the
    /// rest are padding; `beat` only makes each transaction's bytes unique. The table is
    /// read-only, so nothing public changes. An empty beat is valid, also after the run is over.
    /// A beat may repeat moves the Board already holds (they are skipped), so resending after an
    /// unknown outcome never fails. Only from the freeze: a Player may not hide their score
    /// from the opponent while watching the opponent's.
    pub fn play_hidden(
        ctx: Context<PlayHidden>,
        binding: Binding,
        expected_count: u16,
        beat: u8,
        count: u8,
        moves: [MoveArg; 8],
    ) -> Result<()> {
        let _ = beat;
        let clock = Clock::get()?;
        require!(
            clock.slot >= ov(ctx.accounts.table.freeze_slot())?,
            BlockPuzzleError::NotFrozen
        );
        let count = usize::from(count);
        require!(count <= MAX_PLAY_BATCH, BlockPuzzleError::BadBatch);
        let player = ctx.accounts.player.key();
        run_moves(
            &ctx.accounts.table,
            &mut ctx.accounts.board,
            &player,
            &binding,
            Batch {
                expected_count,
                moves: &moves[..count],
                beat: true,
            },
            &clock,
        )?;
        Ok(())
    }

    /// Rollup, permissionless. Ends the Match once its window is over (or both runs are over) and
    /// writes the result into the ring slot with both run logs: the outcome table of the spec. A
    /// Match that never ran ends here too: nobody checking in or no Seed refunds, one Player
    /// absent loses to the present one (unless the rollup stalled), a stalled run is void.
    pub fn close(ctx: Context<CloseMatch>) -> Result<()> {
        let clock = Clock::get()?;
        let (slot, now) = (clock.slot, clock.unix_timestamp);
        let table = &mut ctx.accounts.table;
        match table.phase {
            TABLE_ASSIGNED => {
                require!(
                    slot > ov(table.checkin_end())?,
                    BlockPuzzleError::NotClosable
                );
                // The rate is judged only when the close comes soon after the window: a rollup
                // that halts after it must not turn a decided Match into a refund.
                let stall = slot
                    <= ov(table
                        .checkin_end()
                        .and_then(|e| e.checked_add(CLOSE_GRACE_SLOTS)))?
                    && stalled(
                        slot.saturating_sub(table.assigned_slot),
                        now.saturating_sub(table.assigned_ts),
                    );
                let (outcome, reason) = outcome::absent(table.checked_in, stall);
                conclude(table, now, outcome, reason, blank_log(reason))
            }
            TABLE_SEEDING => {
                require!(slot > ov(table.seed_end())?, BlockPuzzleError::NotClosable);
                conclude(
                    table,
                    now,
                    OUTCOME_DRAW,
                    REASON_NO_SEED,
                    blank_log(REASON_NO_SEED),
                )
            }
            TABLE_GET_READY => {
                let (b0, b1) = (&ctx.accounts.board_0, &ctx.accounts.board_1);
                require!(table.seats_open, BlockPuzzleError::SeatsNotOpen);
                require!(
                    slot > ov(table.play_end())?
                        || (b0.over && b1.over && slot < ov(table.freeze_slot())?),
                    BlockPuzzleError::NotClosable
                );
                // Seats marked during play always count; the aggregate rate only for a prompt close.
                let stall = b0.stalled
                    || b1.stalled
                    || (slot
                        <= ov(table
                            .play_end()
                            .and_then(|e| e.checked_add(CLOSE_GRACE_SLOTS)))?
                        && stalled(
                            slot.saturating_sub(table.ready_slot),
                            now.saturating_sub(table.ready_ts),
                        ));
                let counts = [b0.moves, b1.moves];
                let scores = [b0.score, b1.score];
                let (outcome, reason) = if stall {
                    (OUTCOME_DRAW, REASON_VOID)
                } else {
                    outcome::played(counts, scores)
                };
                let mut log = blank_log(reason);
                log.seed = if b0.began { b0.seed } else { b1.seed };
                log.seed_hash = seed_hash(log.seed, &table.tesoro_match, table.epoch);
                log.start_slot = table.start_slot;
                log.scores = scores;
                log.counts = counts;
                log.moves[..engine::MAX_MOVES as usize].copy_from_slice(&b0.log);
                log.moves[engine::MAX_MOVES as usize..].copy_from_slice(&b1.log);
                log.offsets[..2 * engine::MAX_MOVES as usize].copy_from_slice(&b0.offsets);
                log.offsets[2 * engine::MAX_MOVES as usize..].copy_from_slice(&b1.offsets);
                conclude(table, now, outcome, reason, log)
            }
            _ => err!(BlockPuzzleError::WrongPhase),
        }
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
            table.dirty && (table.phase == TABLE_CLOSED || table.phase == TABLE_IDLE),
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
    /// delay for clients to read the final scores. The ring and its logs are kept.
    pub fn reset_table(ctx: Context<TableOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_CLOSED, BlockPuzzleError::WrongPhase);
        require!(!table.seats_open, BlockPuzzleError::SeatsOpen);
        require!(!table.dirty, BlockPuzzleError::NotCommitted);
        require!(
            now >= table
                .over_at
                .checked_add(RESET_DELAY_SECS)
                .ok_or(BlockPuzzleError::Overflow)?,
            BlockPuzzleError::ResetTooEarly
        );
        table.reset().ok_or(BlockPuzzleError::Overflow)?;
        Ok(())
    }

    /// Rollup, permissionless. A table whose Match tesoro_core has already frozen (it refunded,
    /// say after an outage) before the table produced a result is given up: the reserved slot is
    /// freed and the table moves to Closed, ready to wipe its seats and reset.
    pub fn void_table(ctx: Context<Release>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(
            matches!(
                table.phase,
                TABLE_ASSIGNED | TABLE_SEEDING | TABLE_GET_READY
            ),
            BlockPuzzleError::WrongPhase
        );
        let at = receipt_at(&ctx.accounts.receipt, &table.tesoro_match)
            .ok_or(BlockPuzzleError::NoReceipt)?;
        require!(
            now >= at
                .checked_add(RELEASE_DELAY_SECS)
                .ok_or(BlockPuzzleError::Overflow)?,
            BlockPuzzleError::NoReceipt
        );
        let (slot, key) = (table.slot, table.tesoro_match);
        kit(table.ring.free(slot, &key, SLOT_RESERVED))?;
        table.reason = REASON_VOID;
        table.outcome = 0;
        table.phase = TABLE_CLOSED;
        table.over_at = now;
        table.dirty = false;
        table.req_pending = false;
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
            .ok_or(BlockPuzzleError::BadSlot)?;
        require!(slot.state == SLOT_DONE, BlockPuzzleError::BadSlot);
        let proven = match receipt_at(&ctx.accounts.receipt, &slot.match_key) {
            Some(at) => {
                now >= at
                    .checked_add(RELEASE_DELAY_SECS)
                    .ok_or(BlockPuzzleError::Overflow)?
            }
            None => {
                match_state_gone(&ctx.accounts.match_state, &slot.match_key)
                    && now
                        >= slot
                            .at
                            .checked_add(STALE_SLOT_SECS)
                            .ok_or(BlockPuzzleError::Overflow)?
            }
        };
        require!(proven, BlockPuzzleError::NoReceipt);
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
        BlockPuzzleError::InvalidValidator
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
            @ BlockPuzzleError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::BlockPuzzle>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ BlockPuzzleError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(generation: u16, index: u16)]
pub struct CreateTable<'info> {
    #[account(mut, address = config.operator @ BlockPuzzleError::NotOperator)]
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
    #[account(mut, address = config.operator @ BlockPuzzleError::NotOperator)]
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
    #[account(mut, address = config.operator @ BlockPuzzleError::NotOperator)]
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
    #[account(mut, address = config.operator @ BlockPuzzleError::NotOperator)]
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
    #[account(mut, address = config.operator @ BlockPuzzleError::NotOperator)]
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
    #[account(mut, address = config.operator @ BlockPuzzleError::NotOperator)]
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
    #[account(mut, address = config.operator @ BlockPuzzleError::NotOperator)]
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

#[event_cpi]
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
    pub core_event_authority: UncheckedAccount<'info>,
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
    /// CHECK: ephemeral Board of seat 0, created here
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[0]], bump)]
    pub board_0: UncheckedAccount<'info>,
    /// CHECK: ephemeral Board of seat 1, created here
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[1]], bump)]
    pub board_1: UncheckedAccount<'info>,
    /// CHECK: ephemeral Seed vault, created here
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump)]
    pub seed_vault: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Board 0, created by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, board_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Board 1
    #[account(mut, seeds = [PERMISSION_SEED, board_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_1_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the Seed vault
    #[account(mut, seeds = [PERMISSION_SEED, seed_vault.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub seed_vault_permission: UncheckedAccount<'info>,
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

/// `seat_players` and `wipe_seats`: the only instructions (with `init_seats` and `retire_seats`)
/// that reach the permission program. None is callable into a live Match: each checks the table
/// phase first.
#[derive(Accounts)]
pub struct SeatPlayers<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[0]], bump = board_0.bump)]
    pub board_0: Box<Account<'info, Board>>,
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[1]], bump = board_1.bump)]
    pub board_1: Box<Account<'info, Board>>,
    #[account(seeds = [VAULT_SEED, table.key().as_ref()], bump = seed_vault.bump)]
    pub seed_vault: Box<Account<'info, Vault>>,
    /// CHECK: permission PDA of Board 0
    #[account(mut, seeds = [PERMISSION_SEED, board_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Board 1
    #[account(mut, seeds = [PERMISSION_SEED, board_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_1_permission: UncheckedAccount<'info>,
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
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[0]], bump = board_0.bump)]
    pub board_0: Box<Account<'info, Board>>,
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[1]], bump = board_1.bump)]
    pub board_1: Box<Account<'info, Board>>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = seed_vault.bump)]
    pub seed_vault: Box<Account<'info, Vault>>,
    /// CHECK: permission PDA of Board 0
    #[account(mut, seeds = [PERMISSION_SEED, board_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Board 1
    #[account(mut, seeds = [PERMISSION_SEED, board_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_1_permission: UncheckedAccount<'info>,
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
    #[account(address = config.operator @ BlockPuzzleError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[0]], bump = board_0.bump)]
    pub board_0: Box<Account<'info, Board>>,
    #[account(mut, seeds = [BOARD_SEED, table.key().as_ref(), &[1]], bump = board_1.bump)]
    pub board_1: Box<Account<'info, Board>>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = seed_vault.bump)]
    pub seed_vault: Box<Account<'info, Vault>>,
    /// CHECK: permission PDA of Board 0
    #[account(mut, seeds = [PERMISSION_SEED, board_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Board 1
    #[account(mut, seeds = [PERMISSION_SEED, board_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub board_1_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the Seed vault
    #[account(mut, seeds = [PERMISSION_SEED, seed_vault.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub seed_vault_permission: UncheckedAccount<'info>,
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

#[event_cpi]
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
    pub core_event_authority: UncheckedAccount<'info>,
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

/// A table and nothing else: `start`, `reset_table`.
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

#[vrf]
#[derive(Accounts)]
pub struct RequestSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [VAULT_SEED, table.key().as_ref()], bump = seed_vault.bump)]
    pub seed_vault: Box<Account<'info, Vault>>,
    /// CHECK: validated by the VRF program
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct SeedCallback<'info> {
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = seed_vault.bump)]
    pub seed_vault: Box<Account<'info, Vault>>,
    /// CHECK: names the request this answer is for: the address `["vrfreq", table, nonce]` of the
    /// one outstanding request. The account itself need not exist.
    #[account(
        constraint = request.key() == Table::request_marker(&table.key(), table.req_nonce)
            @ BlockPuzzleError::StaleRequest
    )]
    pub request: UncheckedAccount<'info>,
}

/// Reads the table and the Vault, writes only the Player's own Board.
#[derive(Accounts)]
pub struct Begin<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [VAULT_SEED, table.key().as_ref()], bump = seed_vault.bump)]
    pub seed_vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [BOARD_SEED, table.key().as_ref(), &[board.seat]],
        bump = board.bump,
        constraint = board.player == player.key() @ BlockPuzzleError::NotAPlayer
    )]
    pub board: Box<Account<'info, Board>>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(
        mut,
        seeds = [BOARD_SEED, table.key().as_ref(), &[board.seat]],
        bump = board.bump,
        constraint = board.player == player.key() @ BlockPuzzleError::NotAPlayer
    )]
    pub board: Box<Account<'info, Board>>,
}

/// The table is read-only here: nothing public is touched.
#[derive(Accounts)]
pub struct PlayHidden<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(
        mut,
        seeds = [BOARD_SEED, table.key().as_ref(), &[board.seat]],
        bump = board.bump,
        constraint = board.player == player.key() @ BlockPuzzleError::NotAPlayer
    )]
    pub board: Box<Account<'info, Board>>,
}

/// Reads both Boards, writes the table.
#[derive(Accounts)]
pub struct CloseMatch<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [BOARD_SEED, table.key().as_ref(), &[0]], bump = board_0.bump)]
    pub board_0: Box<Account<'info, Board>>,
    #[account(seeds = [BOARD_SEED, table.key().as_ref(), &[1]], bump = board_1.bump)]
    pub board_1: Box<Account<'info, Board>>,
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
    #[account(address = config.operator @ BlockPuzzleError::NotOperator)]
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
