//! Vanguard (blitz Stratego) as a Tesoro Game, on persistent tables.
//!
//! Matches run on **tables** that stay delegated to MagicBlock's TEE rollup across Matches (see the protocol note
//! `table-protocol.md` and `crates/table_kit`). A table is two public accounts, the small `Table` (epoch, phase, result
//! ring, VRF request) and the `Battle` (the public board), and two **Army** seats: rollup-only accounts behind private
//! permissions, created once and kept for the table's life. The old shared `Secret` account is gone.
//!
//! * base: `assign_match` binds a tesoro_core Match to one table and epoch (write-once); `finalize` reads the
//!   committed, still-delegated table's ring and settles through tesoro_core.
//! * rollup: `begin_match`, `seat_players`, `check_in`, then `contribute_entropy`, `request_vrf`, the oracle callback,
//!   `deal`, the declares (`move_piece`, `blast`, `rescue`, `pass`, `start_two_step`), `claim_timeout` and `resolve`;
//!   `commit_table`, `wipe_seats`, `reset_table` after the Match, and the ring / void recovery paths.
//!
//! Each Player's secret goes only into their own Army and is frozen before the one VRF request of the Match; the answer
//! is split into a half per Army. `deal` derives the seed from both secrets, both halves, the table epoch, the Match and
//! the request number, draws the sides and layouts, writes each Army's ranks and sealing key, stores the storm's turn and
//! line as an XOR share in each Army, and zeroes every secret and half. Nothing holds the seed or the storm afterwards:
//! `resolve` combines the two shares for the length of one engine run. Moves run the pure `engine` (the referee) over
//! the Battle and both Armies.
//!
//! Privacy rules this file keeps (`hidden-info.md`): an Army always has a private permission, from creation until
//! retirement; between Matches its data is zeroed and its member swapped to nobody and then to the next Player, and only
//! `wipe_seats` and `seat_players` do that, never inside a live Match and never on a Player's call; no hidden value is
//! logged or reaches an error code; no signature of the rollup is stored.

pub mod engine;
pub mod setup;
pub mod state;

#[cfg(test)]
mod keeper_fixtures;

use anchor_lang::{prelude::*, system_program};
use engine::{Army as Side, Events, Refusal};
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
use setup::{Contributions, SetupContext};
use table_kit::{
    absence_outcome, close_private_seat, create_hidden_seat, match_state_gone, move_lamports,
    read_table, receipt_at, sponsor_commit_many, swap_seat_members, KitError, SeatAccounts,
    OUTCOME_DRAW, OUTCOME_NO_SHOW, OUTCOME_WIN0, OUTCOME_WIN1, SLOT_DONE, SLOT_RESERVED,
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

declare_id!("TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH");

#[error_code]
pub enum VanguardError {
    #[msg("Signer is not a Player of this Match")]
    NotAPlayer,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The tesoro_core Match is not an Active Match of this Game")]
    BadTesoroMatch,
    #[msg("Already settled or refunded")]
    AlreadyFinalized,
    #[msg("Delegation must name the TEE validator")]
    InvalidValidator,
    #[msg("A permission for this account is missing or is not a real permission")]
    PermissionNotReady,
    #[msg("Only the program's upgrade authority may do this")]
    NotUpgradeAuthority,
    #[msg("Match is not live")]
    NotLive,
    #[msg("Not valid in this phase of the Match")]
    WrongPhase,
    #[msg("Entropy already contributed")]
    AlreadyContributed,
    #[msg("Both Players must contribute entropy and the VRF output must arrive first")]
    EntropyIncomplete,
    #[msg("Already set up")]
    AlreadyDealt,
    #[msg("Match already started")]
    AlreadyStarted,
    #[msg("Deadline has not passed")]
    NotTimedOut,
    #[msg("The Match is not over")]
    MatchNotOver,
    #[msg("The Match is over")]
    MatchOver,
    #[msg("The time cap has passed")]
    CapPassed,
    #[msg("The turn has expired")]
    TurnExpired,
    #[msg("It is not your turn")]
    NotYourTurn,
    #[msg("Not allowed")]
    IllegalMove,
    #[msg("No Two-Step Turn to spend")]
    NoTwoStep,
    #[msg("Inconsistent account state")]
    BadState,
    #[msg("The setup window is over")]
    SetupClosed,
    #[msg("An action is waiting to be resolved")]
    ActionPending,
    #[msg("No action is waiting to be resolved")]
    NothingPending,
    #[msg("Wait for a later slot")]
    TooSoon,
    #[msg("The action was sealed for an earlier turn")]
    StaleSeq,
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
    #[msg("The randomness answer is not for the current request")]
    StaleRequest,
}

impl From<KitError> for VanguardError {
    fn from(e: KitError) -> Self {
        match e {
            KitError::RingFull | KitError::RingDuplicate => VanguardError::RingFull,
            KitError::RingSlot => VanguardError::BadSlot,
            KitError::BadTable => VanguardError::BadTable,
            KitError::BadFeeVault => VanguardError::BadFeeVault,
            KitError::Overflow => VanguardError::Overflow,
            KitError::CommitNotDue => VanguardError::NotDirty,
        }
    }
}

fn kit<T>(r: core::result::Result<T, KitError>) -> Result<T> {
    r.map_err(|e| error!(VanguardError::from(e)))
}

fn refused(r: Refusal) -> Error {
    match r {
        Refusal::MatchOver => error!(VanguardError::MatchOver),
        Refusal::CapPassed => error!(VanguardError::CapPassed),
        Refusal::TurnExpired => error!(VanguardError::TurnExpired),
        Refusal::TurnNotExpired => error!(VanguardError::NotTimedOut),
        Refusal::NotYourTurn => error!(VanguardError::NotYourTurn),
        Refusal::NoSuchPiece | Refusal::IllegalMove => error!(VanguardError::IllegalMove),
        Refusal::NoTwoStep => error!(VanguardError::NoTwoStep),
    }
}

/// The address of a table.
pub fn table_address(generation: u16, index: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()],
        &ID,
    )
    .0
}

/// The address of a table's Battle.
pub fn battle_address(table: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BATTLE_SEED, table.as_ref()], &ID)
}

/// The address of a seat.
pub fn army_address(table: &Pubkey, seat: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ARMY_SEED, table.as_ref(), &[seat]], &ID)
}

fn seat_of(battle: &Battle, key: &Pubkey) -> Result<usize> {
    battle
        .seat_of(key)
        .ok_or_else(|| error!(VanguardError::NotAPlayer))
}

/// The table is running a Match whose seats belong to its Players, and the Battle is that Match's. All public state.
fn require_live(table: &Table, battle: &Battle) -> Result<()> {
    require!(
        table.phase == TABLE_LIVE && table.seats_open,
        VanguardError::NotLive
    );
    require!(
        battle.tesoro_match == table.tesoro_match,
        VanguardError::BadState
    );
    Ok(())
}

/// Ends a Match that setup or check-in could not start, by who showed up (`present`: checked in, or took the first
/// required step, contributing a secret). The founder's rule (2026-10-23, `table_kit::absence_outcome`): the Player who
/// showed up wins a normal Match with the normal Fees, as if the other had lost on time; if neither showed up it is a
/// no-show (each side pays the Platform Fee); if both did and the delay was the oracle's, nobody forfeits and both
/// entries are refunded.
fn end_absent(table: &mut Table, battle: &mut Battle, present: [bool; 2], now: i64) -> Result<()> {
    match absence_outcome(present) {
        Some(OUTCOME_WIN0) | Some(OUTCOME_WIN1) => {
            battle.status = STATUS_OVER;
            battle.winner = u8::from(present[1]);
            battle.reason = reason_code(engine::EndReason::Timeouts);
            conclude(table, battle, false, now)
        }
        Some(_) => {
            battle.status = STATUS_CANCELLED;
            conclude(table, battle, true, now)
        }
        None => {
            battle.status = STATUS_CANCELLED;
            conclude(table, battle, false, now)
        }
    }
}

/// Writes the Match's result into the ring slot reserved at the start and marks the table Over. Every path that ends
/// a Match (a decided game, a cancelled setup) calls this once the Battle says so.
fn conclude(table: &mut Table, battle: &Battle, no_show: bool, now: i64) -> Result<()> {
    if table.phase == TABLE_OVER {
        return Ok(());
    }
    let outcome = match battle.status {
        STATUS_OVER if battle.winner == DRAW => OUTCOME_DRAW,
        STATUS_OVER if battle.winner == 0 => OUTCOME_WIN0,
        STATUS_OVER => OUTCOME_WIN1,
        STATUS_CANCELLED if no_show => OUTCOME_NO_SHOW,
        STATUS_CANCELLED => OUTCOME_DRAW,
        _ => return Ok(()),
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
pub mod vanguard {
    use super::*;

    // ------------------------------------------------------------------------------------
    // Base layer
    // ------------------------------------------------------------------------------------

    /// Base layer, upgrade authority only. Names the TEE validator the tables may be delegated to and the oracle
    /// queue its VRF requests go to, so the program has no compiled-in cluster address and a mainnet deploy needs no
    /// code change.
    pub fn set_config(
        ctx: Context<SetConfig>,
        tee_validator: Pubkey,
        oracle_queue: Pubkey,
    ) -> Result<()> {
        require!(
            tee_validator != Pubkey::default(),
            VanguardError::InvalidValidator
        );
        require!(
            oracle_queue != Pubkey::default(),
            VanguardError::InvalidValidator
        );
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;
        config.tee_validator = tee_validator;
        config.oracle_queue = oracle_queue;
        Ok(())
    }

    /// Base, upgrade authority only. Names the operator, the current table generation (which may only rise) and how
    /// many tables a generation may have.
    pub fn set_table_config(
        ctx: Context<SetTableConfig>,
        operator: Pubkey,
        generation: u16,
        max_tables: u16,
    ) -> Result<()> {
        require!(
            operator != Pubkey::default() && (1..=MAX_TABLES_HARD).contains(&max_tables),
            VanguardError::BadConfig
        );
        let config = &mut ctx.accounts.table_config;
        require!(generation >= config.generation, VanguardError::BadConfig);
        config.bump = ctx.bumps.table_config;
        config.operator = operator;
        config.generation = generation;
        config.max_tables = max_tables;
        Ok(())
    }

    /// Base, operator. Creates a table of the current generation and its Battle, the table funded for its seats' rent.
    pub fn create_table(ctx: Context<CreateTable>, generation: u16, index: u16) -> Result<()> {
        let config = &ctx.accounts.table_config;
        require!(
            generation == config.generation && index < config.max_tables,
            VanguardError::BadTableSlot
        );
        **ctx.accounts.table = Table::new(ctx.bumps.table, generation, index);
        ctx.accounts.battle.load_init()?.bump = ctx.bumps.battle;
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

    /// Base, operator. Delegates a table and its Battle to the TEE validator, once.
    pub fn delegate_table(ctx: Context<DelegateTable>, generation: u16, index: u16) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        ctx.accounts.delegate_table(
            &ctx.accounts.operator,
            &[TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()],
            tee_config(&ctx.accounts.validator, &ctx.accounts.vanguard_config)?,
        )?;
        ctx.accounts.delegate_battle(
            &ctx.accounts.operator,
            &[BATTLE_SEED, table_key.as_ref()],
            tee_config(&ctx.accounts.validator, &ctx.accounts.vanguard_config)?,
        )?;
        Ok(())
    }

    /// Base, operator. Delegates the Sponsor, once.
    pub fn delegate_sponsor(ctx: Context<DelegateSponsor>) -> Result<()> {
        let config = tee_config(&ctx.accounts.validator, &ctx.accounts.vanguard_config)?;
        ctx.accounts
            .delegate_sponsor(&ctx.accounts.operator, &[SPONSOR_SEED], config)?;
        Ok(())
    }

    /// Base, operator. Delegates a fuel reserve.
    pub fn delegate_fuel(ctx: Context<DelegateFuel>, n: u8) -> Result<()> {
        let config = tee_config(&ctx.accounts.validator, &ctx.accounts.vanguard_config)?;
        ctx.accounts
            .delegate_fuel(&ctx.accounts.operator, &[FUEL_SEED, &[n]], config)?;
        Ok(())
    }

    /// Base, operator. Binds an Active tesoro_core Match of this Game to a table and its current epoch, once. The
    /// Players are copied from the Match, the start deadline is fixed here, and the Match's refund timer is held past
    /// the whole table window.
    pub fn assign_match(
        ctx: Context<AssignMatch>,
        generation: u16,
        index: u16,
        epoch: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.table_config;
        require!(
            generation == config.generation && index < config.max_tables,
            VanguardError::BadTableSlot
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
            VanguardError::BadTesoroMatch
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
                .ok_or(VanguardError::Overflow)?,
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
        a.start_deadline = now
            .checked_add(START_WINDOW_SECS)
            .ok_or(VanguardError::Overflow)?;
        a.payer = ctx.accounts.operator.key();
        Ok(())
    }

    /// Base, permissionless. Closes an Assignment once tesoro_core has frozen its Match (the receipt exists) or the
    /// Match account is gone; the rent goes back to whoever paid it.
    pub fn close_assignment(ctx: Context<CloseAssignment>) -> Result<()> {
        let key = ctx.accounts.assignment.tesoro_match;
        require!(
            receipt_at(&ctx.accounts.receipt, &key).is_some()
                || match_state_gone(&ctx.accounts.match_state, &key),
            VanguardError::NoReceipt
        );
        Ok(())
    }

    /// Base, permissionless. Settles the tesoro_core Match from the result in the committed table's ring, by CPI
    /// signed by this Game's `authority` PDA. Without a result it refunds only when the table has demonstrably moved
    /// past the Assignment's epoch without the Match. Only starts the settlement in tesoro_core; its chunks follow.
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
            VanguardError::BadTable
        );
        let outcome = match table.ring.find(&assignment.tesoro_match, assignment.epoch) {
            Some((_, slot)) if slot.state == SLOT_DONE => slot.outcome,
            Some(_) => return err!(VanguardError::MatchNotOver),
            None => {
                // The slot is freed only after tesoro_core froze the Match, so an absent slot is
                // proof of "never ran" only once the table is past that epoch.
                require!(table.epoch > assignment.epoch, VanguardError::NoResult);
                require!(now > assignment.start_deadline, VanguardError::NotTimedOut);
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
                _ => return err!(VanguardError::NoResult),
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

    /// Rollup, permissionless, once per table. Creates the two Army seats as ephemeral accounts behind private
    /// permissions with no member. The table pays the rent. They are never closed while the table runs.
    pub fn init_seats(ctx: Context<InitSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(!table.seats_created, VanguardError::SeatsOpen);
        require!(table.phase == TABLE_IDLE, VanguardError::WrongPhase);
        let table_key = table.key();
        let gen = table.generation.to_le_bytes();
        let idx = table.index.to_le_bytes();
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        for seat in 0..2usize {
            let (army, permission, army_bump) = if seat == 0 {
                (
                    &ctx.accounts.army_0,
                    &ctx.accounts.army_0_permission,
                    ctx.bumps.army_0,
                )
            } else {
                (
                    &ctx.accounts.army_1,
                    &ctx.accounts.army_1_permission,
                    ctx.bumps.army_1,
                )
            };
            let seat_arr = [seat as u8];
            let bump_arr = [army_bump];
            let seat_seeds: &[&[u8]] = &[ARMY_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            let army_info = army.to_account_info();
            create_hidden_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &army_info,
                    permission: &permission.to_account_info(),
                    vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                    magic_program: &ctx.accounts.magic_program.to_account_info(),
                    permission_program: &ctx.accounts.permission_program.to_account_info(),
                },
                table_seeds,
                seat_seeds,
                (8 + Army::INIT_SPACE) as u32,
                None,
            )?;
            let mut data = army_info.try_borrow_mut_data()?;
            Army::blank(army_bump, table_key, seat as u8).try_serialize(&mut &mut data[..])?;
        }
        ctx.accounts.table.seats_created = true;
        Ok(())
    }

    /// Rollup, permissionless. Hands both seats to the Match's Players: each seat must be blank, then it is stamped
    /// with its Player and its permission member is swapped from nobody to that Player. Only before play begins;
    /// never on a Player's call into a live Match.
    pub fn seat_players(ctx: Context<SeatPlayers>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.seats_created, VanguardError::SeatsMissing);
        require!(table.phase == TABLE_WAITING, VanguardError::WrongPhase);
        require!(!table.seats_open, VanguardError::SeatsOpen);
        require!(
            ctx.accounts.army_0.is_blank() && ctx.accounts.army_1.is_blank(),
            VanguardError::SeatNotBlank
        );
        let players = {
            let battle = ctx.accounts.battle.load()?;
            require!(
                battle.tesoro_match == table.tesoro_match,
                VanguardError::BadState
            );
            battle.players
        };
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        ctx.accounts.army_0.player = players[0];
        ctx.accounts.army_1.player = players[1];
        ctx.accounts.army_0.exit(&ID)?;
        ctx.accounts.army_1.exit(&ID)?;
        for (seat, player) in players.into_iter().enumerate() {
            let (army, permission) = if seat == 0 {
                (&ctx.accounts.army_0, &ctx.accounts.army_0_permission)
            } else {
                (&ctx.accounts.army_1, &ctx.accounts.army_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [army.bump];
            let seat_seeds: &[&[u8]] = &[ARMY_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            swap_seat_members(
                &SeatAccounts {
                    table: &table_info,
                    seat: &army.to_account_info(),
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
        ctx.accounts.battle.load_mut()?.permissioned = 1;
        ctx.accounts.table.seats_open = true;
        Ok(())
    }

    /// Rollup, permissionless. Once the Match is over (or voided): zeroes both seats and swaps their permission
    /// members to nobody, so nothing the Players could read is left and the seats are never without a private
    /// permission. The next `seat_players` hands them on.
    pub fn wipe_seats(ctx: Context<WipeSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.phase == TABLE_OVER, VanguardError::WrongPhase);
        require!(table.seats_open, VanguardError::SeatsNotOpen);
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        ctx.accounts.army_0.wipe();
        ctx.accounts.army_1.wipe();
        ctx.accounts.army_0.exit(&ID)?;
        ctx.accounts.army_1.exit(&ID)?;
        for seat in 0..2usize {
            let (army, permission) = if seat == 0 {
                (&ctx.accounts.army_0, &ctx.accounts.army_0_permission)
            } else {
                (&ctx.accounts.army_1, &ctx.accounts.army_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [army.bump];
            let seat_seeds: &[&[u8]] = &[ARMY_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            swap_seat_members(
                &SeatAccounts {
                    table: &table_info,
                    seat: &army.to_account_info(),
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

    /// Rollup, operator only. Retires a table's seats: closes both Armies and their permissions and returns the rent
    /// to the table. Only an idle table with blank seats; this is the one place a seat's history may open, and
    /// nothing a Player can call reaches it.
    pub fn retire_seats(ctx: Context<RetireSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.seats_created, VanguardError::SeatsMissing);
        require!(table.phase == TABLE_IDLE, VanguardError::WrongPhase);
        require!(!table.seats_open, VanguardError::SeatsOpen);
        require!(
            ctx.accounts.army_0.is_blank() && ctx.accounts.army_1.is_blank(),
            VanguardError::SeatNotBlank
        );
        let (gen, idx) = (table.generation.to_le_bytes(), table.index.to_le_bytes());
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        let table_key = ctx.accounts.table.key();
        for seat in 0..2usize {
            let (army, permission) = if seat == 0 {
                (&ctx.accounts.army_0, &ctx.accounts.army_0_permission)
            } else {
                (&ctx.accounts.army_1, &ctx.accounts.army_1_permission)
            };
            let seat_arr = [seat as u8];
            let bump_arr = [army.bump];
            let seat_seeds: &[&[u8]] = &[ARMY_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            close_private_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &army.to_account_info(),
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

    /// Rollup, permissionless. Starts the Assignment's Match on its table: only if the table is Idle at exactly the
    /// assigned epoch with seats, the tesoro_core Match is still Active and a ring slot is free. Everything about the
    /// Match comes from the Assignment, never from the caller. It reserves the slot and binds the table's Battle to
    /// the Match; the Match starts when both Players have checked in.
    pub fn begin_match(ctx: Context<BeginMatch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts.assignment;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_IDLE, VanguardError::WrongPhase);
        require!(table.seats_created, VanguardError::SeatsMissing);
        require!(
            a.generation == table.generation && a.index == table.index && a.epoch == table.epoch,
            VanguardError::NotAssigned
        );
        let tesoro = &ctx.accounts.tesoro_match;
        require!(
            tesoro.inner.stage() == Stage::Active && tesoro.inner.game == ID.to_bytes(),
            VanguardError::BadTesoroMatch
        );
        require!(now <= a.start_deadline, VanguardError::StartWindowPassed);
        let epoch = table.epoch;
        table.slot = kit(table.ring.reserve(a.tesoro_match, epoch))?;
        table.tesoro_match = a.tesoro_match;
        table.start_deadline = a.start_deadline;
        table.checked_in = [false; 2];
        table.phase = TABLE_WAITING;
        ctx.accounts.battle.load_mut()?.init(NewBattle {
            match_id: tesoro.inner.id.n,
            tesoro_match: a.tesoro_match,
            players: a.players,
            start_deadline: a.start_deadline,
            payer: a.payer,
            oracle_queue: ctx.accounts.vanguard_config.oracle_queue,
            epoch,
        });
        Ok(())
    }

    /// Rollup. A Player checks in. When both have, setup opens: each Player has a minute to contribute entropy, and
    /// the Match must be dealt within the setup window.
    pub fn check_in(ctx: Context<CheckIn>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        let mut battle = ctx.accounts.battle.load_mut()?;
        require!(table.phase == TABLE_WAITING, VanguardError::WrongPhase);
        require!(table.seats_open, VanguardError::SeatsNotOpen);
        require!(
            battle.tesoro_match == table.tesoro_match && battle.status == STATUS_CREATED,
            VanguardError::BadState
        );
        require!(
            now <= table.start_deadline,
            VanguardError::StartWindowPassed
        );
        let seat = seat_of(&battle, &ctx.accounts.player.key())?;
        table.checked_in[seat] = true;
        if table.checked_in == [true; 2] {
            table.phase = TABLE_LIVE;
            battle.status = STATUS_SETUP;
            battle.entropy_deadline = now
                .checked_add(ENTROPY_SECS)
                .ok_or(VanguardError::Overflow)?;
            battle.setup_deadline = now
                .checked_add(SETUP_GRACE_SECS)
                .ok_or(VanguardError::Overflow)?;
        }
        Ok(())
    }

    /// Rollup. A Player folds a fresh secret in. It goes into the Player's own Army only, and neither the table nor
    /// the Battle is written, so the transaction touches nothing both Players can read. The secret is spent at the
    /// deal. A client never sends a secret twice.
    pub fn contribute_entropy(ctx: Context<ContributeEntropy>, secret: [u8; 32]) -> Result<()> {
        {
            let battle = ctx.accounts.battle.load()?;
            require_live(&ctx.accounts.table, &battle)?;
            require!(battle.status == STATUS_SETUP, VanguardError::WrongPhase);
            require!(
                Clock::get()?.unix_timestamp <= battle.entropy_deadline,
                VanguardError::SetupClosed
            );
        }
        let army = &mut ctx.accounts.army;
        require!(!army.contributed, VanguardError::AlreadyContributed);
        army.secret = secret;
        army.contributed = true;
        Ok(())
    }

    /// Rollup, permissionless. Asks the oracle for this Match's randomness, once. The program chooses the input: the
    /// table, the Match, the epoch, the request number and the hashes of both frozen secrets. The answer is accepted
    /// only for this request.
    pub fn request_vrf(ctx: Context<RequestVrf>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let battle = ctx.accounts.battle.load()?;
            require_live(&ctx.accounts.table, &battle)?;
            require!(battle.status == STATUS_SETUP, VanguardError::WrongPhase);
            require!(now <= battle.setup_deadline, VanguardError::SetupClosed);
        }
        let table = &mut ctx.accounts.table;
        require!(
            !(table.req_pending || table.vrf_ready || table.req_made),
            VanguardError::AlreadyDealt
        );
        let armies = [&ctx.accounts.army_0, &ctx.accounts.army_1];
        require!(
            armies.iter().all(|a| a.contributed),
            VanguardError::EntropyIncomplete
        );
        let nonce = table.vrf_nonce;
        let setup_ctx = SetupContext {
            tesoro_match: table.tesoro_match,
            generation: table.generation,
            index: table.index,
            epoch: table.epoch,
            nonce,
        };
        let caller_seed = setup::request_seed(
            &setup_ctx,
            &[
                setup::secret_hash(&armies[0].secret),
                setup::secret_hash(&armies[1].secret),
            ],
        );
        let marker = Table::request_marker(&table.key(), nonce);
        table.vrf_nonce = nonce.checked_add(1).ok_or(VanguardError::Overflow)?;
        table.req_nonce = nonce;
        table.req_pending = true;
        table.req_made = true;
        table.req_epoch = table.epoch;
        table.req_at = now;
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::VrfCallbackStore::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![
                SerializableAccountMeta {
                    pubkey: ctx.accounts.table.key(),
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.battle.key(),
                    is_signer: false,
                    is_writable: false,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.army_0.key(),
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.army_1.key(),
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

    /// Rollup. VRF callback: splits the oracle's output into a half per Army. Accepted only for the one outstanding
    /// request of the current epoch, named by its marker address, only while the Match is still in setup, and only
    /// once: a late output can never restart a cancelled Match or reach a wiped seat.
    pub fn vrf_callback_store(ctx: Context<VrfCallbackStore>, randomness: [u8; 32]) -> Result<()> {
        {
            let battle = ctx.accounts.battle.load()?;
            let table = &ctx.accounts.table;
            require!(
                table.phase == TABLE_LIVE
                    && table.seats_open
                    && table.req_pending
                    && table.req_epoch == table.epoch
                    && battle.tesoro_match == table.tesoro_match
                    && battle.status == STATUS_SETUP,
                VanguardError::StaleRequest
            );
            require!(
                Clock::get()?.unix_timestamp <= battle.setup_deadline,
                VanguardError::SetupClosed
            );
        }
        let table = &mut ctx.accounts.table;
        require!(
            ctx.accounts.army_0.contributed && ctx.accounts.army_1.contributed,
            VanguardError::EntropyIncomplete
        );
        let nonce = table.req_nonce;
        let halves = [
            setup::vrf_half(0, &randomness, nonce),
            setup::vrf_half(1, &randomness, nonce),
        ];
        for (army, half) in [&mut ctx.accounts.army_0, &mut ctx.accounts.army_1]
            .into_iter()
            .zip(halves)
        {
            army.half = half;
            army.half_set = true;
        }
        table.req_pending = false;
        table.vrf_ready = true;
        Ok(())
    }

    /// Rollup, permissionless. Once the answer is in: derives the seed, draws the sides, both layouts and the storm,
    /// writes each Army's ranks and sealing key and its share of the storm, zeroes every secret and half, and starts
    /// the first turn's clock. The US Army moves first; which seat plays it is the draw. The seed is never stored.
    pub fn deal(ctx: Context<Deal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let mut battle = ctx.accounts.battle.load_mut()?;
        let table = &mut ctx.accounts.table;
        require_live(table, &battle)?;
        require!(battle.status == STATUS_SETUP, VanguardError::WrongPhase);
        require!(now <= battle.setup_deadline, VanguardError::SetupClosed);
        require!(table.vrf_ready, VanguardError::EntropyIncomplete);
        let (a0, a1) = (&mut **ctx.accounts.army_0, &mut **ctx.accounts.army_1);
        require!(
            [&*a0, &*a1]
                .iter()
                .all(|a| a.contributed && a.half_set && !a.dealt),
            VanguardError::EntropyIncomplete
        );

        let setup_ctx = SetupContext {
            tesoro_match: table.tesoro_match,
            generation: table.generation,
            index: table.index,
            epoch: table.epoch,
            nonce: table.req_nonce,
        };
        let seed = setup::derive_seed(
            &setup_ctx,
            &Contributions {
                secrets: [a0.secret, a1.secret],
                halves: [a0.half, a1.half],
                ext: [a0.ext_entropy, a1.ext_entropy],
            },
        );
        let drawn = engine::setup(&seed, battle.storm_from as u16, battle.storm_to as u16);
        let keys = engine::seal_keys(&seed);
        let shares = setup::storm_shares(&seed, drawn.storm_at, drawn.storm_seed);
        let mut game = engine::Game::start(
            &drawn.pieces,
            Side::Us,
            drawn.storm_at,
            drawn.storm_seed,
            now,
            battle.clock(),
        )
        .map_err(|_| error!(VanguardError::BadState))?;
        // The cap and the move cap are the ones stored at the start of the Match, whatever this build's constants say.
        game.cap_at = now.saturating_add(battle.cap_secs as i64);
        game.move_cap = battle.move_cap;

        battle.us_seat = drawn.us_seat;
        battle.deal_slot = slot;
        battle.cap_deadline = game.cap_at;
        battle.absorb(&game);
        battle.status = STATUS_LIVE;
        battle.started_at = now;
        for (seat, army) in [a0, a1].into_iter().enumerate() {
            let side = battle
                .side_of_seat(seat)
                .ok_or_else(|| error!(VanguardError::BadState))?;
            army.place(side, &drawn.pieces);
            army.reserved = keys[side.idx()];
            army.storm_at = shares[seat].0;
            army.storm_seed = shares[seat].1;
            army.dealt = true;
            army.spend_secrets();
        }
        table.vrf_ready = false;
        Ok(())
    }

    /// Rollup. Declares a move: checks only public state (the Match is live, it is your turn, nothing is pending,
    /// `expected_seq` is the Battle's `action_seq`, the piece is yours and on the board, the square is on the board,
    /// not a wadi, on a straight or diagonal line, not yours and not the square it just came from) and freezes the
    /// clock decision on the declare time. Reads no Army, so what it answers cannot depend on a hidden rank.
    /// `sealed_switch` is the Player's sealed Become a Spy byte (always sent, see `engine::seal_pad`); it is only
    /// stored. The move is applied by `resolve` in a later slot, which checks the rank rules; a move they refuse
    /// costs the turn.
    pub fn move_piece(
        ctx: Context<Declare>,
        piece: u8,
        to: u8,
        expected_seq: u32,
        sealed_switch: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let mut battle = ctx.accounts.battle.load_mut()?;
        require_live(&ctx.accounts.table, &battle)?;
        let seat = declaring_seat(&battle, &ctx.accounts.player.key(), slot, expected_seq)?;
        let g = battle.public_game()?;
        g.check_declared_move(piece, to, now).map_err(refused)?;
        battle.record_pending(
            PENDING_MOVE,
            Intent {
                piece,
                to,
                sealed_switch,
            },
            seat as u8,
            slot,
            now,
        );
        Ok(())
    }

    /// Rollup. Declares a Blast of `piece`. Checks public state only: live, your turn, nothing pending,
    /// `expected_seq`, the clock, the piece is yours and on the board, and no step has been made this turn (not in a
    /// Two-Step Turn). Whether it is an Engineer is decided by `resolve`; a Blast of anything else costs the turn.
    pub fn blast(
        ctx: Context<Declare>,
        piece: u8,
        expected_seq: u32,
        sealed_switch: u8,
    ) -> Result<()> {
        declare_act(ctx, PENDING_BLAST, piece, expected_seq, sealed_switch)
    }

    /// Rollup. Declares a Rescue of the Truck by `piece`. Same public checks as `blast`; whether `piece` is a Colonel
    /// with a Truck on the board is decided by `resolve`.
    pub fn rescue(
        ctx: Context<Declare>,
        piece: u8,
        expected_seq: u32,
        sealed_switch: u8,
    ) -> Result<()> {
        declare_act(ctx, PENDING_RESCUE, piece, expected_seq, sealed_switch)
    }

    /// Rollup. Declares a pass, which counts as a missed turn. `sealed_slot` seals the Dig in: 0 is a plain pass, else
    /// the Major to dig in (see `engine::seal_pad`), so a face-down Dig in is this very instruction with the same
    /// public effect. Public checks as `blast`, without a piece.
    pub fn pass(
        ctx: Context<Declare>,
        expected_seq: u32,
        sealed_slot: u8,
        sealed_switch: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let mut battle = ctx.accounts.battle.load_mut()?;
        require_live(&ctx.accounts.table, &battle)?;
        let seat = declaring_seat(&battle, &ctx.accounts.player.key(), slot, expected_seq)?;
        let g = battle.public_game()?;
        g.check_declared_pass(now).map_err(refused)?;
        battle.record_pending(
            PENDING_PASS,
            Intent {
                piece: sealed_slot,
                to: 0,
                sealed_switch,
            },
            seat as u8,
            slot,
            now,
        );
        Ok(())
    }

    /// Rollup. The Player to act spends a banked Two-Step Turn before the first step of the turn. Public state only;
    /// does not move the deadline.
    pub fn start_two_step(ctx: Context<Declare>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let mut battle = ctx.accounts.battle.load_mut()?;
        require_live(&ctx.accounts.table, &battle)?;
        declaring_seat(&battle, &ctx.accounts.player.key(), slot, battle.action_seq)?;
        let mut g = battle.shell(0, 0)?;
        g.start_two_step(now).map_err(refused)?;
        battle.two_step = g.two_step;
        battle.two_step_active = g.two_step_active as u8;
        battle.steps_left = g.steps_left;
        Ok(())
    }

    /// Rollup, permissionless. Past the start window or the setup windows it cancels the Match (the ring gets a
    /// refund, or a no-show when both checked in and nobody contributed). In a live Match it declares a timeout: once
    /// the turn's deadline has passed the turn is lost (three in a row lose the Match), once the time cap has passed
    /// the Match ends on the tiebreak. Which of the two is decided now, from the clock, and `resolve` applies it.
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let table = &mut ctx.accounts.table;
        let mut battle = ctx.accounts.battle.load_mut()?;
        require!(
            (table.phase == TABLE_WAITING || table.phase == TABLE_LIVE)
                && battle.tesoro_match == table.tesoro_match,
            VanguardError::MatchOver
        );
        match battle.status {
            STATUS_CREATED => {
                require!(table.phase == TABLE_WAITING, VanguardError::BadState);
                require!(now > battle.start_deadline, VanguardError::NotTimedOut);
                // The Player who checked in wins; if neither did it is a no-show.
                let present = table.checked_in;
                end_absent(table, &mut battle, present, now)?;
            }
            STATUS_SETUP => {
                require!(table.phase == TABLE_LIVE, VanguardError::BadState);
                let contributed = [
                    ctx.accounts.army_0.contributed,
                    ctx.accounts.army_1.contributed,
                ];
                let both = contributed.iter().all(|c| *c);
                if now > battle.setup_deadline {
                    // The hard deadline: whatever stalled, the Match is cancelled and refunded.
                    battle.status = STATUS_CANCELLED;
                    conclude(table, &battle, !contributed.iter().any(|c| *c), now)?;
                } else {
                    require!(now > battle.entropy_deadline, VanguardError::NotTimedOut);
                    if both && table.req_made {
                        // The randomness is late, which is the oracle's fault: nobody forfeits, but the wait
                        // never goes past the setup deadline.
                        battle.entropy_deadline = now
                            .checked_add(ENTROPY_SECS)
                            .ok_or(VanguardError::Overflow)?
                            .min(battle.setup_deadline);
                    } else {
                        end_absent(table, &mut battle, contributed, now)?;
                    }
                }
            }
            STATUS_LIVE => {
                require!(
                    table.phase == TABLE_LIVE && table.seats_open,
                    VanguardError::NotLive
                );
                require!(
                    battle.pending_kind == PENDING_NONE,
                    VanguardError::ActionPending
                );
                require!(slot > battle.deal_slot, VanguardError::TooSoon);
                let g = battle.shell(0, 0)?;
                let kind = match g.timeout_class(now).map_err(refused)? {
                    engine::TimeoutClass::Pass => PENDING_TIMEOUT,
                    engine::TimeoutClass::Cap => PENDING_CAP,
                };
                battle.record_pending(kind, Intent::default(), 0, slot, now);
            }
            _ => return err!(VanguardError::MatchOver),
        }
        Ok(())
    }

    /// Rollup, permissionless, no arguments. Applies the pending action in a slot after its declare: it unseals the
    /// declaring Player's switch (and a pass's Dig in) with that Army's key, applies them only to an action the rank
    /// rules allow, then runs the rank rules, the fight, the Spotted and raid bookkeeping, the turn pass, the storm, the
    /// caps, the no-legal-action check, the end reveal and the events. It never fails on hidden state: an action the
    /// rank rules refuse costs the turn, and every value of a sealed byte decodes to something defined. The next
    /// deadline counts from the resolve time, but never from later than the declare time plus `RESOLVE_SLACK_SECS`: a
    /// slow resolve never eats the next Player's time, and a held-back one buys none. A decided game writes its
    /// result into the ring.
    pub fn resolve(mut ctx: Context<Resolve>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let accounts = &mut ctx.accounts;
        let mut battle = accounts.battle.load_mut()?;
        require_live(&accounts.table, &battle)?;
        require!(battle.status == STATUS_LIVE, VanguardError::NotLive);
        require!(
            battle.pending_kind != PENDING_NONE,
            VanguardError::NothingPending
        );
        require!(slot > battle.pending_slot, VanguardError::TooSoon);
        let declared = battle.pending_time;
        let (kind, piece, to, seat) = (
            battle.pending_kind,
            battle.pending_piece,
            battle.pending_to,
            battle.pending_seat,
        );
        // The pads are bound to the Match.
        let binding = battle.tesoro_match.to_bytes();
        // The declare took `action_seq` as `expected_seq` and then advanced it: the pads are for the number before.
        let seq = battle.action_seq.wrapping_sub(1);
        // Unseal. Both pads are always computed and both bytes always unsealed, whatever the kind: the work does not
        // depend on which fields the action uses. Only the declaring seat's own key is read (the seat is public).
        let key = if seat == 0 {
            accounts.army_0.reserved
        } else {
            accounts.army_1.reserved
        };
        let plain_switch =
            battle.pad_a[0] ^ engine::seal_pad(&key, &binding, seat, seq, engine::SEAL_SWITCH);
        let plain_dig = piece ^ engine::seal_pad(&key, &binding, seat, seq, engine::SEAL_DIG);
        run(
            &mut battle,
            &mut accounts.army_0,
            &mut accounts.army_1,
            |g, out| {
                let at = g.counted(declared, now);
                let switch = g.switch_wanted(plain_switch);
                match kind {
                    PENDING_MOVE => g.resolve_move(piece, to, switch, at, out),
                    PENDING_BLAST => g.resolve_blast(piece, switch, at, out),
                    PENDING_RESCUE => g.resolve_rescue(piece, switch, at, out),
                    PENDING_PASS => {
                        let dig_in = g.dig_in_piece(plain_dig);
                        g.resolve_pass(dig_in, switch, at, out)
                    }
                    PENDING_CAP => g.resolve_timeout(engine::TimeoutClass::Cap, at, out),
                    _ => g.resolve_timeout(engine::TimeoutClass::Pass, at, out),
                }
            },
        )?;
        battle.clear_pending();
        if matches!(kind, PENDING_MOVE | PENDING_BLAST | PENDING_RESCUE) {
            let mover = if seat == 0 {
                &mut accounts.army_0
            } else {
                &mut accounts.army_1
            };
            mover.moves = mover.moves.wrapping_add(1);
        }
        conclude(&mut accounts.table, &battle, false, now)
    }

    // ------------------------------------------------------------------------------------
    // Rollup: after the Match
    // ------------------------------------------------------------------------------------

    /// Rollup, permissionless. Commits the finished table and its Battle to Solana, paid by the Sponsor. The first
    /// commit of a result is owed once (the table is `dirty` until then). A commit can be lost on its way to base
    /// without the rollup noticing, so it may be repeated while the ring holds a young Done result, with a wait that
    /// doubles from two minutes to an hour (see `table_kit::CommitGuard`); nobody can drain the Sponsor by calling it
    /// again and again. Only these two public accounts are ever committed: the Armies are ephemeral.
    pub fn commit_table(ctx: Context<CommitTable>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        kit(table
            .commit
            .allow(table.phase == TABLE_OVER && table.dirty, &table.ring, now))?;
        table.dirty = false;
        table.commit.record(now);
        table.exit(&ID)?;
        let bump = [ctx.accounts.sponsor.bump];
        sponsor_commit_many(
            &ctx.accounts.sponsor.to_account_info(),
            &[SPONSOR_SEED, &bump],
            &ctx.accounts.magic_context.to_account_info(),
            &ctx.accounts.magic_program.to_account_info(),
            &ctx.accounts.magic_fee_vault.to_account_info(),
            &ctx.accounts.vanguard_config.tee_validator,
            &[
                ctx.accounts.table.to_account_info(),
                ctx.accounts.battle.to_account_info(),
            ],
        )
    }

    /// Rollup, permissionless. Wipes the finished Match from the public table and its Battle and moves to the next
    /// epoch. Needs the result committed (`dirty` cleared), the seats wiped and a short delay for clients to read the
    /// final board. The ring is kept.
    pub fn reset_table(ctx: Context<ResetTable>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == TABLE_OVER, VanguardError::WrongPhase);
        require!(!table.seats_open, VanguardError::SeatsOpen);
        require!(!table.dirty, VanguardError::NotCommitted);
        require!(
            now >= table
                .over_at
                .checked_add(RESET_DELAY_SECS)
                .ok_or(VanguardError::Overflow)?,
            VanguardError::ResetTooEarly
        );
        let mut battle = ctx.accounts.battle.load_mut()?;
        require!(
            battle.status == STATUS_OVER || battle.status == STATUS_CANCELLED,
            VanguardError::MatchNotOver
        );
        battle.zero();
        table.reset().ok_or(VanguardError::Overflow)?;
        Ok(())
    }

    /// Rollup, permissionless. A table whose Match tesoro_core has already frozen (it refunded, say after an outage)
    /// before the table produced a result is given up: the reserved slot is freed, the Battle is cancelled and the
    /// table moves to Over, ready to wipe its seats and reset.
    pub fn void_table(ctx: Context<VoidTable>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(
            table.phase == TABLE_WAITING || table.phase == TABLE_LIVE,
            VanguardError::WrongPhase
        );
        let at = receipt_at(&ctx.accounts.receipt, &table.tesoro_match)
            .ok_or(VanguardError::NoReceipt)?;
        require!(
            now >= at
                .checked_add(RELEASE_DELAY_SECS)
                .ok_or(VanguardError::Overflow)?,
            VanguardError::NoReceipt
        );
        let (slot, key) = (table.slot, table.tesoro_match);
        kit(table.ring.free(slot, &key, SLOT_RESERVED))?;
        let mut battle = ctx.accounts.battle.load_mut()?;
        battle.clear_pending();
        battle.status = STATUS_CANCELLED;
        battle.winner = NO_WINNER;
        table.phase = TABLE_OVER;
        table.over_at = now;
        table.dirty = false;
        table.req_pending = false;
        table.vrf_ready = false;
        Ok(())
    }

    /// Rollup, permissionless. Frees a Done ring slot once tesoro_core has frozen its Match (the receipt, read a
    /// minute after it was written), or once the Match account itself has been gone for 15 days. A missing or
    /// doubtful read keeps the slot.
    pub fn release_slot(ctx: Context<Release>, index: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        let slot = *table
            .ring
            .slots
            .get(index as usize)
            .ok_or(VanguardError::BadSlot)?;
        require!(slot.state == SLOT_DONE, VanguardError::BadSlot);
        let proven = match receipt_at(&ctx.accounts.receipt, &slot.match_key) {
            Some(at) => {
                now >= at
                    .checked_add(RELEASE_DELAY_SECS)
                    .ok_or(VanguardError::Overflow)?
            }
            None => {
                match_state_gone(&ctx.accounts.match_state, &slot.match_key)
                    && now
                        >= slot
                            .at
                            .checked_add(STALE_SLOT_SECS)
                            .ok_or(VanguardError::Overflow)?
            }
        };
        require!(proven, VanguardError::NoReceipt);
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

/// The only delegation config the Game accepts: the configured TEE validator, and no automatic commits (an
/// automatic commit would publish the table's history to the base layer mid-Match).
fn tee_config(validator: &Option<AccountInfo>, config: &VanguardConfig) -> Result<DelegateConfig> {
    require!(
        validator
            .as_ref()
            .is_some_and(|v| v.key() == config.tee_validator),
        VanguardError::InvalidValidator
    );
    Ok(DelegateConfig {
        validator: Some(config.tee_validator),
        commit_frequency_ms: u32::MAX,
    })
}

/// The seat of `key` for an action declared in a live Match: it is that Player's turn, nothing is pending, the deal is
/// in an earlier slot and `expected_seq` is the number of this declare (a sealed byte made for an earlier turn is
/// refused here, so it can never be decoded as garbage). All public state.
fn declaring_seat(battle: &Battle, key: &Pubkey, slot: u64, expected_seq: u32) -> Result<usize> {
    require!(battle.status == STATUS_LIVE, VanguardError::NotLive);
    let seat = seat_of(battle, key)?;
    require!(
        battle.pending_kind == PENDING_NONE,
        VanguardError::ActionPending
    );
    require!(slot > battle.deal_slot, VanguardError::TooSoon);
    let side = battle
        .side_of_seat(seat)
        .ok_or_else(|| error!(VanguardError::BadState))?;
    require!(side.idx() as u8 == battle.turn, VanguardError::NotYourTurn);
    require!(expected_seq == battle.action_seq, VanguardError::StaleSeq);
    Ok(seat)
}

/// Declare a Blast or a Rescue: public checks only, then freeze the intent and the sealed switch.
fn declare_act(
    ctx: Context<Declare>,
    kind: u8,
    piece: u8,
    expected_seq: u32,
    sealed_switch: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let slot = Clock::get()?.slot;
    let mut battle = ctx.accounts.battle.load_mut()?;
    require_live(&ctx.accounts.table, &battle)?;
    let seat = declaring_seat(&battle, &ctx.accounts.player.key(), slot, expected_seq)?;
    let g = battle.public_game()?;
    g.check_declared_act(piece, now).map_err(refused)?;
    battle.record_pending(
        kind,
        Intent {
            piece,
            to: 0,
            sealed_switch,
        },
        seat as u8,
        slot,
        now,
    );
    Ok(())
}

/// Assemble the engine's Game from the public Battle and both private Armies, run one infallible resolution and
/// write the result back. Both Armies are written whatever happened.
fn run(
    battle: &mut Battle,
    army_0: &mut Army,
    army_1: &mut Army,
    f: impl FnOnce(&mut engine::Game, &mut Events),
) -> Result<()> {
    let mut g = battle.game([&*army_0, &*army_1])?;
    let mut out = Events::new();
    f(&mut g, &mut out);
    battle.absorb(&g);
    battle.push_events(&out);
    army_0.absorb(&g);
    army_1.absorb(&g);
    Ok(())
}

// -----------------------------------------------------------------------------------------
// Accounts
// -----------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed, payer = authority, space = 8 + VanguardConfig::INIT_SPACE,
        seeds = [PROGRAM_CONFIG_SEED], bump
    )]
    pub config: Account<'info, VanguardConfig>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ VanguardError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::Vanguard>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ VanguardError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTableConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed, payer = authority, space = 8 + TableConfig::INIT_SPACE,
        seeds = [TABLES_SEED], bump
    )]
    pub table_config: Account<'info, TableConfig>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ VanguardError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::Vanguard>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ VanguardError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(generation: u16, index: u16)]
pub struct CreateTable<'info> {
    #[account(mut, address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(
        init, payer = operator, space = 8 + Table::INIT_SPACE,
        seeds = [TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()], bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(
        init, payer = operator, space = 8 + core::mem::size_of::<Battle>(),
        seeds = [BATTLE_SEED, table.key().as_ref()], bump
    )]
    pub battle: AccountLoader<'info, Battle>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateSponsor<'info> {
    #[account(mut, address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(init, payer = operator, space = 8 + Sponsor::INIT_SPACE, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: Account<'info, Sponsor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(n: u8)]
pub struct CreateFuel<'info> {
    #[account(mut, address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(init, payer = operator, space = 8 + Fuel::INIT_SPACE, seeds = [FUEL_SEED, &[n]], bump)]
    pub fuel: Account<'info, Fuel>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(generation: u16, index: u16)]
pub struct DelegateTable<'info> {
    #[account(mut, address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = vanguard_config.bump)]
    pub vanguard_config: Account<'info, VanguardConfig>,
    /// CHECK: the table PDA to delegate
    #[account(mut, del, seeds = [TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()], bump)]
    pub table: AccountInfo<'info>,
    /// CHECK: the table's Battle PDA to delegate
    #[account(mut, del, seeds = [BATTLE_SEED, table.key().as_ref()], bump)]
    pub battle: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked against the config
    pub validator: Option<AccountInfo<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSponsor<'info> {
    #[account(mut, address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = vanguard_config.bump)]
    pub vanguard_config: Account<'info, VanguardConfig>,
    /// CHECK: the Sponsor PDA to delegate
    #[account(mut, del, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked against the config
    pub validator: Option<AccountInfo<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(n: u8)]
pub struct DelegateFuel<'info> {
    #[account(mut, address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = vanguard_config.bump)]
    pub vanguard_config: Account<'info, VanguardConfig>,
    /// CHECK: the fuel PDA to delegate
    #[account(mut, del, seeds = [FUEL_SEED, &[n]], bump)]
    pub fuel: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked against the config
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(generation: u16, index: u16, epoch: u64)]
pub struct AssignMatch<'info> {
    #[account(mut, address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
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
    /// CHECK: ephemeral Army of seat 0, created here
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump)]
    pub army_0: UncheckedAccount<'info>,
    /// CHECK: ephemeral Army of seat 1, created here
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump)]
    pub army_1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 0, created by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, army_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 1
    #[account(mut, seeds = [PERMISSION_SEED, army_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_1_permission: UncheckedAccount<'info>,
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

/// `seat_players`: with `wipe_seats` and `retire_seats`, one of the only instructions that reach the permission
/// program. None is callable into a live Match: each checks the table phase first.
#[derive(Accounts)]
pub struct SeatPlayers<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    /// CHECK: permission PDA of Army 0
    #[account(mut, seeds = [PERMISSION_SEED, army_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 1
    #[account(mut, seeds = [PERMISSION_SEED, army_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_1_permission: UncheckedAccount<'info>,
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
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    /// CHECK: permission PDA of Army 0
    #[account(mut, seeds = [PERMISSION_SEED, army_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 1
    #[account(mut, seeds = [PERMISSION_SEED, army_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_1_permission: UncheckedAccount<'info>,
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
    #[account(address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    /// CHECK: permission PDA of Army 0
    #[account(mut, seeds = [PERMISSION_SEED, army_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Army 1
    #[account(mut, seeds = [PERMISSION_SEED, army_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub army_1_permission: UncheckedAccount<'info>,
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
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(
        address = assignment.tesoro_match,
        seeds = [CORE_MATCH_SEED, tesoro_match.inner.id.opener.as_ref(), &tesoro_match.inner.id.n.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = vanguard_config.bump)]
    pub vanguard_config: Box<Account<'info, VanguardConfig>>,
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
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
}

/// Touches the signer's own Army and reads the table and the Battle; neither is written.
#[derive(Accounts)]
pub struct ContributeEntropy<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(
        mut,
        seeds = [ARMY_SEED, table.key().as_ref(), &[army.seat]],
        bump = army.bump,
        constraint = army.player == player.key() @ VanguardError::NotAPlayer
    )]
    pub army: Box<Account<'info, Army>>,
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
    #[account(seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    /// CHECK: the queue stored in the Battle at the start of the Match (from the config); validated by the VRF program
    #[account(mut, address = battle.load()?.oracle_queue)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallbackStore<'info> {
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
    /// CHECK: names the request this answer is for: the address `["vrfreq", table, nonce]` of the one outstanding
    /// request. The account itself need not exist.
    #[account(
        constraint = request.key() == Table::request_marker(&table.key(), table.req_nonce)
            @ VanguardError::StaleRequest
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
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
}

/// The declares and `start_two_step`: the table is read, the Battle written, no Army touched.
#[derive(Accounts)]
pub struct Declare<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
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
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[0]], bump = army_0.bump)]
    pub army_0: Box<Account<'info, Army>>,
    #[account(mut, seeds = [ARMY_SEED, table.key().as_ref(), &[1]], bump = army_1.bump)]
    pub army_1: Box<Account<'info, Army>>,
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
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = vanguard_config.bump)]
    pub vanguard_config: Box<Account<'info, VanguardConfig>>,
    /// CHECK: the TEE validator's magic fee vault, checked in `sponsor_commit_many`.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ResetTable<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
}

#[derive(Accounts)]
pub struct VoidTable<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [BATTLE_SEED, table.key().as_ref()], bump = battle.load()?.bump)]
    pub battle: AccountLoader<'info, Battle>,
    /// CHECK: the settlement receipt of the Match, verified by `receipt_at`.
    pub receipt: UncheckedAccount<'info>,
}

/// `release_slot`.
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
    #[account(address = table_config.operator @ VanguardError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [TABLES_SEED], bump = table_config.bump)]
    pub table_config: Account<'info, TableConfig>,
    #[account(mut, seeds = [FUEL_SEED, &[fuel.n]], bump = fuel.bump)]
    pub fuel: Account<'info, Fuel>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
}
