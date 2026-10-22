//! Trading Duel: a head-to-head price grid on a live oracle price, as a Tesoro Game.
//!
//! One Match is 2.5 minutes on one asset (SOL, ETH or HYPE). The grid has 12 columns of 10 seconds
//! and unbounded price bands anchored on the price when the Match starts. Each Player picks one
//! band per column; a column locks 10 seconds before its window, and both picks are then revealed.
//! A pick hits when the live price line crosses its band during the column, for 100 points; more
//! points wins the Pot through tesoro_core, equal points refunds it, and a Match in which neither
//! Player picked at all settles as a no-show.
//!
//! Matches run on persistent **tables** that stay delegated to MagicBlock (see the protocol note
//! `table-protocol.md` and `crates/table_kit`):
//!
//! * base: `assign_match` binds a tesoro_core Match to one table and epoch (write-once);
//!   `finalize` reads the committed, still-delegated table and settles through tesoro_core.
//! * rollup: `begin_match`, `open_seats`, `check_in`, `set_pick`, `tick`, `end_match`,
//!   `commit_table`, `close_seats`, `reset_table`, and the ring/void/expire recovery paths.

pub mod engine;
pub mod state;

#[cfg(test)]
mod keeper_fixtures;

use anchor_lang::{prelude::*, system_program};
use ephemeral_rollups_sdk::{
    access_control::structs::PERMISSION_SEED,
    anchor::{commit, delegate, ephemeral},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
};
use table_kit::{
    close_private_seat, match_state_gone, move_lamports, open_private_seat, read_table, receipt_at,
    sponsor_commit, KitError, SeatAccounts, OUTCOME_DRAW, OUTCOME_NO_SHOW, OUTCOME_WIN0,
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

pub use engine::EngineError;
pub use state::*;

declare_id!("CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj");

/// Identity of MagicBlock's TEE validator (devnet); delegation is pinned to it.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/// MagicBlock's real-time pricing oracle program: owner of the feed accounts.
pub const PRICE_PROGRAM: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
/// Pyth Lazer feed accounts on the rollup, indexed by asset (SOL/USD, ETH/USD, HYPE/USD).
pub const FEEDS: [Pubkey; 3] = [
    pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
    pubkey!("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"),
    pubkey!("CxEkVoCUwSAprvAhdWRPH63JeioQVNDtyZYEMRXuLu6x"),
];

#[error_code]
pub enum DuelError {
    #[msg("Signer is not a Player of this Match")]
    NotAPlayer,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Match is not live")]
    NotLive,
    #[msg("The grid is not open")]
    GridClosed,
    #[msg("The grid window has not ended")]
    NotEnded,
    #[msg("Column out of range")]
    InvalidColumn,
    #[msg("That column is locked")]
    ColumnLocked,
    #[msg("Unknown asset")]
    InvalidAsset,
    #[msg("Not the price feed of this Match's asset")]
    BadPriceFeed,
    #[msg("The oracle price is stale or in the future")]
    StalePrice,
    #[msg("The oracle price is unusable")]
    BadPrice,
    #[msg("Deadline has not passed")]
    NotTimedOut,
    #[msg("The start deadline has passed")]
    StartWindowPassed,
    #[msg("The tesoro_core Match is not an Active Match of this Game")]
    BadTesoroMatch,
    #[msg("The Match is not over")]
    MatchNotOver,
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
    #[msg("The table is not in the phase this needs")]
    WrongPhase,
    #[msg("The Assignment names another table, generation or epoch")]
    NotAssigned,
    #[msg("The seats are not open")]
    SeatsNotOpen,
    #[msg("The seats are already open or still open")]
    SeatsOpen,
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
    #[msg("A permission for this account is missing or is not a real permission")]
    PermissionNotReady,
}

impl From<EngineError> for DuelError {
    fn from(e: EngineError) -> Self {
        match e {
            EngineError::BadColumn => DuelError::InvalidColumn,
            EngineError::Locked => DuelError::ColumnLocked,
        }
    }
}

impl From<KitError> for DuelError {
    fn from(e: KitError) -> Self {
        match e {
            KitError::RingFull | KitError::RingDuplicate => DuelError::RingFull,
            KitError::RingSlot => DuelError::BadSlot,
            KitError::BadTable => DuelError::BadTable,
            KitError::BadFeeVault => DuelError::BadFeeVault,
            KitError::Overflow => DuelError::Overflow,
        }
    }
}

fn eng<T>(r: core::result::Result<T, EngineError>) -> Result<T> {
    r.map_err(|e| error!(DuelError::from(e)))
}

fn kit<T>(r: core::result::Result<T, KitError>) -> Result<T> {
    r.map_err(|e| error!(DuelError::from(e)))
}

/// The asset a Match plays on: carried explicitly in the tesoro_core Match record (`meta.asset`).
/// Only 0 (SOL), 1 (ETH) and 2 (HYPE) are valid.
pub fn check_asset(asset: u8) -> Result<u8> {
    require!((asset as usize) < FEEDS.len(), DuelError::InvalidAsset);
    Ok(asset)
}

/// The address of a table.
pub fn table_address(generation: u16, index: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[TABLE_SEED, &generation.to_le_bytes(), &index.to_le_bytes()],
        &ID,
    )
    .0
}

/// Reads a price from a MagicBlock Pyth Lazer feed account (a Pyth `PriceUpdateV2` image):
/// `feed_id` 41..73 (equals the account key), `price` i64 at 73, `conf` u64 at 81, `exponent` i32
/// at 89 (the pusher writes 8 for 1e-8), `publish_time` i64 at 93. Returns the price in 1e-8 USD.
pub fn read_price(feed: &AccountInfo, asset: u8, now: i64) -> Result<u64> {
    require!(
        FEEDS.get(asset as usize) == Some(feed.key),
        DuelError::BadPriceFeed
    );
    require!(feed.owner == &PRICE_PROGRAM, DuelError::BadPriceFeed);
    let data = feed.try_borrow_data()?;
    require!(data.len() >= 101, DuelError::BadPrice);
    require!(&data[41..73] == feed.key.as_ref(), DuelError::BadPriceFeed);
    let price = i64::from_le_bytes(data[73..81].try_into().map_err(|_| DuelError::BadPrice)?);
    let conf = u64::from_le_bytes(data[81..89].try_into().map_err(|_| DuelError::BadPrice)?);
    let exponent = i32::from_le_bytes(data[89..93].try_into().map_err(|_| DuelError::BadPrice)?);
    let published = i64::from_le_bytes(data[93..101].try_into().map_err(|_| DuelError::BadPrice)?);
    require!(exponent == 8 || exponent == -8, DuelError::BadPrice);
    require!(price > 0, DuelError::BadPrice);
    let price = price as u64;
    // A confidence interval wider than 1% of the price is not a price to trade on.
    require!(
        conf.checked_mul(100).ok_or(DuelError::Overflow)? <= price,
        DuelError::BadPrice
    );
    let age = now
        .checked_sub(published)
        .ok_or(error!(DuelError::Overflow))?;
    require!(
        (-MAX_FUTURE_SECS..=MAX_STALE_SECS).contains(&age),
        DuelError::StalePrice
    );
    Ok(price)
}

/// Seconds since the Match started. The grid is open from the start until `ends_at`.
fn require_grid(table: &Table, now: i64) -> Result<i64> {
    require!(
        table.phase == PHASE_LIVE && table.seats_open,
        DuelError::NotLive
    );
    require!(
        now >= table.starts_at && now < table.ends_at,
        DuelError::GridClosed
    );
    Ok(now - table.starts_at)
}

/// Copies the picks of every locked column from both Books into the public Table.
fn reveal(duel: &mut Table, books: [&Book; 2], t: i64) {
    for c in 0..COLUMNS {
        if t >= engine::lock_at(c) {
            for (seat, book) in books.iter().enumerate() {
                duel.revealed[seat][c] = book.picks[c];
            }
        }
    }
}

/// Re-scores the columns that are final at `t`.
fn rescore(duel: &mut Table, t: i64) {
    duel.scores = engine::score(
        &duel.track,
        &duel.revealed,
        duel.anchor,
        duel.step,
        engine::columns_done(t),
    );
}

#[ephemeral]
#[program]
pub mod trading_duel {
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
            DuelError::BadConfig
        );
        let config = &mut ctx.accounts.config;
        require!(generation >= config.generation, DuelError::BadConfig);
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
            DuelError::BadTableSlot
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
    /// epoch, once. The Players and the asset are copied from the Match, the start deadline is
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
            DuelError::BadTableSlot
        );
        let tesoro = &ctx.accounts.tesoro_match;
        let asset = check_asset(tesoro.inner.meta.asset)?;
        require!(
            tesoro.inner.stage() == Stage::Active
                && tesoro.inner.game == ID.to_bytes()
                && tesoro.inner.a.player == ctx.accounts.account_a.key().to_bytes()
                && tesoro
                    .inner
                    .b
                    .as_ref()
                    .is_some_and(|b| b.player == ctx.accounts.account_b.key().to_bytes()),
            DuelError::BadTesoroMatch
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
                .ok_or(DuelError::Overflow)?,
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
        a.asset = asset;
        a.start_deadline = now
            .checked_add(START_WINDOW_SECS)
            .ok_or(DuelError::Overflow)?;
        a.payer = ctx.accounts.operator.key();
        Ok(())
    }

    /// Base, permissionless. Closes an Assignment once tesoro_core has frozen its Match (the
    /// receipt exists) or the Match account is gone; the rent goes back to whoever paid it.
    pub fn close_assignment(ctx: Context<CloseAssignment>) -> Result<()> {
        let key = ctx.accounts.assignment.tesoro_match;
        require!(
            receipt_at(&ctx.accounts.receipt, &key).is_some()
                || match_state_gone(&ctx.accounts.match_state, &key),
            DuelError::NoReceipt
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
            DuelError::BadTable
        );
        let outcome = match table.ring.find(&assignment.tesoro_match, assignment.epoch) {
            Some((_, slot)) if slot.state == SLOT_DONE => slot.outcome,
            Some(_) => return err!(DuelError::MatchNotOver),
            None => {
                // The slot is freed only after tesoro_core froze the Match, so an absent slot is
                // proof of "never ran" only once the table is past that epoch.
                require!(table.epoch > assignment.epoch, DuelError::NoResult);
                require!(now > assignment.start_deadline, DuelError::NotTimedOut);
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
                _ => return err!(DuelError::NoResult),
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
    // Rollup
    // ------------------------------------------------------------------------------------

    /// Rollup, permissionless. Starts the Assignment's Match on its table: only if the table is
    /// Idle at exactly the assigned epoch, the tesoro_core Match is still Active and a ring slot
    /// is free. Everything about the Match comes from the Assignment, never from the caller.
    pub fn begin_match(ctx: Context<BeginMatch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts.assignment;
        let table = &mut ctx.accounts.table;
        require!(table.phase == PHASE_IDLE, DuelError::WrongPhase);
        require!(
            a.generation == table.generation && a.index == table.index && a.epoch == table.epoch,
            DuelError::NotAssigned
        );
        let tesoro = &ctx.accounts.tesoro_match;
        require!(
            tesoro.inner.stage() == Stage::Active && tesoro.inner.game == ID.to_bytes(),
            DuelError::BadTesoroMatch
        );
        require!(now <= a.start_deadline, DuelError::StartWindowPassed);
        let epoch = table.epoch;
        table.slot = kit(table.ring.reserve(a.tesoro_match, epoch))?;
        table.tesoro_match = a.tesoro_match;
        table.players = a.players;
        table.asset = a.asset;
        table.start_deadline = a.start_deadline;
        table.checked_in = [false; 2];
        table.phase = PHASE_WAITING;
        Ok(())
    }

    /// Rollup, permissionless. Creates both Players' Books as ephemeral accounts behind private
    /// permissions whose only member is that Player. The table pays the rent.
    pub fn open_seats(ctx: Context<OpenSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(
            table.phase == PHASE_WAITING || table.phase == PHASE_LIVE,
            DuelError::WrongPhase
        );
        require!(!table.seats_open, DuelError::SeatsOpen);
        let table_key = table.key();
        let players = table.players;
        let gen = table.generation.to_le_bytes();
        let idx = table.index.to_le_bytes();
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        for (seat, player) in players.iter().enumerate() {
            let (book, permission, book_bump) = if seat == 0 {
                (
                    &ctx.accounts.book_0,
                    &ctx.accounts.book_0_permission,
                    ctx.bumps.book_0,
                )
            } else {
                (
                    &ctx.accounts.book_1,
                    &ctx.accounts.book_1_permission,
                    ctx.bumps.book_1,
                )
            };
            let seat_arr = [seat as u8];
            let bump_arr = [book_bump];
            let seat_seeds: &[&[u8]] = &[BOOK_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            let book_info = book.to_account_info();
            open_private_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &book_info,
                    permission: &permission.to_account_info(),
                    vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                    magic_program: &ctx.accounts.magic_program.to_account_info(),
                    permission_program: &ctx.accounts.permission_program.to_account_info(),
                },
                table_seeds,
                seat_seeds,
                (8 + Book::INIT_SPACE) as u32,
                *player,
            )?;
            let mut data = book_info.try_borrow_mut_data()?;
            Book::new(book_bump, table_key, *player, seat as u8)
                .try_serialize(&mut &mut data[..])?;
        }
        ctx.accounts.table.seats_open = true;
        Ok(())
    }

    /// Rollup. A Player checks in. When both have, the Match starts: the anchor price is read
    /// from the feed and recorded as the first sample, the line enters the grid after the head
    /// start, and the Match runs for 2.5 minutes.
    pub fn check_in(ctx: Context<CheckIn>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == PHASE_WAITING, DuelError::WrongPhase);
        require!(table.seats_open, DuelError::SeatsNotOpen);
        require!(now <= table.start_deadline, DuelError::StartWindowPassed);
        let seat = table
            .players
            .iter()
            .position(|p| *p == ctx.accounts.player.key())
            .ok_or(DuelError::NotAPlayer)?;
        table.checked_in[seat] = true;
        if table.checked_in == [true; 2] {
            let anchor = read_price(&ctx.accounts.price_feed, table.asset, now)?;
            table.phase = PHASE_LIVE;
            table.starts_at = now;
            table.grid_at = now
                .checked_add(HEAD_START_SECS)
                .ok_or(DuelError::Overflow)?;
            table.ends_at = now.checked_add(MATCH_SECS).ok_or(DuelError::Overflow)?;
            table.anchor = anchor;
            table.step = engine::step_for(anchor, STEP_PPM[table.asset as usize]);
            table.track.record(0, anchor);
            table.last_tick = now;
        }
        Ok(())
    }

    /// Rollup. Picks `band` (signed; 0 starts at the anchor) for `column`, or clears the pick with
    /// `NO_PICK`. Only a Player, only until 10 seconds before the column starts. The pick stays in
    /// the Player's own Book until the column locks.
    pub fn set_pick(ctx: Context<SetPick>, column: u8, band: i16) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &ctx.accounts.table;
        require!(
            table.phase == PHASE_LIVE && table.seats_open,
            DuelError::NotLive
        );
        require!(now >= table.starts_at, DuelError::GridClosed);
        let t = now - table.starts_at;
        eng(engine::check_pick(column as usize, t))?;
        let book = &mut ctx.accounts.book;
        let slot = book.picks[column as usize];
        match (slot == NO_PICK, band == NO_PICK) {
            (true, false) => book.pick_count += 1,
            (false, true) => book.pick_count -= 1,
            _ => {}
        }
        book.picks[column as usize] = band;
        Ok(())
    }

    /// Rollup, permissionless. Samples the oracle into the current column, reveals the picks of
    /// every column that has locked, and scores the columns that are over. Clients call it
    /// about four times a second; a sample is always a real price, so extra calls cannot fake a hit.
    pub fn tick(ctx: Context<Sample>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        let t = require_grid(table, now)?;
        let price = read_price(&ctx.accounts.price_feed, table.asset, now)?;
        table.track.record(t, price);
        reveal(table, [&ctx.accounts.book_0, &ctx.accounts.book_1], t);
        rescore(table, t);
        table.last_tick = now;
        Ok(())
    }

    /// Rollup, permissionless. Once the window has closed: carries the line forward through any
    /// column it did not reach, scores every column and decides the Match: more points wins,
    /// equal points is a draw, and a Match in which neither Player picked is a no-show. The
    /// result goes into the ring slot reserved at the start, which is the only thing `finalize`
    /// reads. It reads no price, so the result is the same whoever ends the Match and whenever.
    pub fn end_match(ctx: Context<EndMatch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(
            table.phase == PHASE_LIVE && table.seats_open,
            DuelError::NotLive
        );
        require!(now >= table.ends_at, DuelError::NotEnded);
        table.track.finish();
        reveal(
            table,
            [&ctx.accounts.book_0, &ctx.accounts.book_1],
            MATCH_SECS,
        );
        rescore(table, MATCH_SECS);
        table.winner = engine::winner(table.scores);
        let nobody_acted =
            ctx.accounts.book_0.pick_count == 0 && ctx.accounts.book_1.pick_count == 0;
        let outcome = if nobody_acted {
            table.winner = DRAW;
            OUTCOME_NO_SHOW
        } else {
            match table.winner {
                0 => OUTCOME_WIN0,
                1 => OUTCOME_WIN1,
                _ => OUTCOME_DRAW,
            }
        };
        let (slot, key, epoch) = (table.slot, table.tesoro_match, table.epoch);
        kit(table.ring.record(slot, &key, epoch, outcome, now))?;
        table.last_tick = now;
        table.phase = PHASE_OVER;
        table.over_at = now;
        table.dirty = true;
        Ok(())
    }

    /// Rollup, permissionless. A table whose Players did not both check in before the start
    /// deadline records a refund, so the Match can be settled from the ring like any other.
    pub fn expire_start(ctx: Context<TableOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == PHASE_WAITING, DuelError::WrongPhase);
        require!(now > table.start_deadline, DuelError::NotTimedOut);
        let (slot, key, epoch) = (table.slot, table.tesoro_match, table.epoch);
        kit(table.ring.record(slot, &key, epoch, OUTCOME_DRAW, now))?;
        table.winner = DRAW;
        table.phase = PHASE_OVER;
        table.over_at = now;
        table.dirty = true;
        Ok(())
    }

    /// Rollup, permissionless. Commits the finished table to Solana, paid by the Sponsor. It
    /// works once per result (the table is `dirty` until then), so nobody can drain the Sponsor
    /// by committing again and again.
    pub fn commit_table(ctx: Context<CommitTable>) -> Result<()> {
        let table = &mut ctx.accounts.table;
        require!(
            table.phase == PHASE_OVER && table.dirty,
            DuelError::NotDirty
        );
        table.dirty = false;
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

    /// Rollup, permissionless. Once the Match is over, closes both Books and their permissions;
    /// the rent returns to the table.
    pub fn close_seats(ctx: Context<CloseSeats>) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(table.phase == PHASE_OVER, DuelError::WrongPhase);
        require!(table.seats_open, DuelError::SeatsNotOpen);
        let table_key = table.key();
        let gen = table.generation.to_le_bytes();
        let idx = table.index.to_le_bytes();
        let table_bump = [table.bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &gen, &idx, &table_bump];
        let table_info = ctx.accounts.table.to_account_info();
        for seat in 0..2usize {
            let (book, permission, book_bump) = if seat == 0 {
                (
                    &ctx.accounts.book_0,
                    &ctx.accounts.book_0_permission,
                    ctx.bumps.book_0,
                )
            } else {
                (
                    &ctx.accounts.book_1,
                    &ctx.accounts.book_1_permission,
                    ctx.bumps.book_1,
                )
            };
            let seat_arr = [seat as u8];
            let bump_arr = [book_bump];
            let seat_seeds: &[&[u8]] = &[BOOK_SEED, table_key.as_ref(), &seat_arr, &bump_arr];
            close_private_seat(
                &SeatAccounts {
                    table: &table_info,
                    seat: &book.to_account_info(),
                    permission: &permission.to_account_info(),
                    vault: &ctx.accounts.ephemeral_vault.to_account_info(),
                    magic_program: &ctx.accounts.magic_program.to_account_info(),
                    permission_program: &ctx.accounts.permission_program.to_account_info(),
                },
                table_seeds,
                seat_seeds,
            )?;
        }
        ctx.accounts.table.seats_open = false;
        Ok(())
    }

    /// Rollup, permissionless. Wipes the finished Match from the public table and moves to the
    /// next epoch. Needs the result committed (`dirty` cleared), the Books closed and a short
    /// delay for clients to read the final board. The ring is kept.
    pub fn reset_table(ctx: Context<TableOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(table.phase == PHASE_OVER, DuelError::WrongPhase);
        require!(!table.seats_open, DuelError::SeatsOpen);
        require!(!table.dirty, DuelError::NotCommitted);
        require!(
            now >= table
                .over_at
                .checked_add(RESET_DELAY_SECS)
                .ok_or(DuelError::Overflow)?,
            DuelError::ResetTooEarly
        );
        table.reset().ok_or(DuelError::Overflow)?;
        Ok(())
    }

    /// Rollup, permissionless. A table whose Match tesoro_core has already frozen (it refunded,
    /// say after an outage) before the table produced a result is given up: the reserved slot is
    /// freed and the table moves to Over, ready to close its seats and reset.
    pub fn void_table(ctx: Context<Release>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let table = &mut ctx.accounts.table;
        require!(
            table.phase == PHASE_WAITING || table.phase == PHASE_LIVE,
            DuelError::WrongPhase
        );
        let at =
            receipt_at(&ctx.accounts.receipt, &table.tesoro_match).ok_or(DuelError::NoReceipt)?;
        require!(
            now >= at
                .checked_add(RELEASE_DELAY_SECS)
                .ok_or(DuelError::Overflow)?,
            DuelError::NoReceipt
        );
        let (slot, key) = (table.slot, table.tesoro_match);
        kit(table.ring.free(slot, &key, SLOT_RESERVED))?;
        table.winner = NO_WINNER;
        table.phase = PHASE_OVER;
        table.over_at = now;
        table.dirty = false;
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
            .ok_or(DuelError::BadSlot)?;
        require!(slot.state == SLOT_DONE, DuelError::BadSlot);
        let proven = match receipt_at(&ctx.accounts.receipt, &slot.match_key) {
            Some(at) => {
                now >= at
                    .checked_add(RELEASE_DELAY_SECS)
                    .ok_or(DuelError::Overflow)?
            }
            None => {
                match_state_gone(&ctx.accounts.match_state, &slot.match_key)
                    && now
                        >= slot
                            .at
                            .checked_add(STALE_SLOT_SECS)
                            .ok_or(DuelError::Overflow)?
            }
        };
        require!(proven, DuelError::NoReceipt);
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

/// The only delegation config the Game accepts: the TEE validator, no automatic commits.
fn tee_config(validator: &Option<AccountInfo>) -> Result<DelegateConfig> {
    require!(
        validator.as_ref().is_some_and(|v| v.key() == TEE_VALIDATOR),
        DuelError::InvalidValidator
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
            @ DuelError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::TradingDuel>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ DuelError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(generation: u16, index: u16)]
pub struct CreateTable<'info> {
    #[account(mut, address = config.operator @ DuelError::NotOperator)]
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
    #[account(mut, address = config.operator @ DuelError::NotOperator)]
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
    #[account(mut, address = config.operator @ DuelError::NotOperator)]
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
    #[account(mut, address = config.operator @ DuelError::NotOperator)]
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
    #[account(mut, address = config.operator @ DuelError::NotOperator)]
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
    #[account(mut, address = config.operator @ DuelError::NotOperator)]
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
    #[account(mut, address = config.operator @ DuelError::NotOperator)]
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
pub struct OpenSeats<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: ephemeral Book of seat 0, created here
    #[account(mut, seeds = [BOOK_SEED, table.key().as_ref(), &[0]], bump)]
    pub book_0: UncheckedAccount<'info>,
    /// CHECK: ephemeral Book of seat 1, created here
    #[account(mut, seeds = [BOOK_SEED, table.key().as_ref(), &[1]], bump)]
    pub book_1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Book 0, created by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, book_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub book_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Book 1
    #[account(mut, seeds = [PERMISSION_SEED, book_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub book_1_permission: UncheckedAccount<'info>,
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
pub struct CloseSeats<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: ephemeral Book of seat 0, closed here
    #[account(mut, seeds = [BOOK_SEED, table.key().as_ref(), &[0]], bump)]
    pub book_0: UncheckedAccount<'info>,
    /// CHECK: ephemeral Book of seat 1, closed here
    #[account(mut, seeds = [BOOK_SEED, table.key().as_ref(), &[1]], bump)]
    pub book_1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Book 0
    #[account(mut, seeds = [PERMISSION_SEED, book_0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub book_0_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of Book 1
    #[account(mut, seeds = [PERMISSION_SEED, book_1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub book_1_permission: UncheckedAccount<'info>,
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
pub struct CheckIn<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: owner, address and feed id are validated against the Match's asset in `read_price`.
    pub price_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetPick<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(
        mut,
        seeds = [BOOK_SEED, table.key().as_ref(), &[book.seat]],
        bump = book.bump,
        constraint = book.player == player.key() @ DuelError::NotAPlayer
    )]
    pub book: Box<Account<'info, Book>>,
}

/// `caller` is any payer.
#[derive(Accounts)]
pub struct EndMatch<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [BOOK_SEED, table.key().as_ref(), &[0]], bump = book_0.bump)]
    pub book_0: Box<Account<'info, Book>>,
    #[account(seeds = [BOOK_SEED, table.key().as_ref(), &[1]], bump = book_1.bump)]
    pub book_1: Box<Account<'info, Book>>,
}

/// `tick`: `caller` is any payer.
#[derive(Accounts)]
pub struct Sample<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [TABLE_SEED, &table.generation.to_le_bytes(), &table.index.to_le_bytes()],
        bump = table.bump
    )]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [BOOK_SEED, table.key().as_ref(), &[0]], bump = book_0.bump)]
    pub book_0: Box<Account<'info, Book>>,
    #[account(seeds = [BOOK_SEED, table.key().as_ref(), &[1]], bump = book_1.bump)]
    pub book_1: Box<Account<'info, Book>>,
    /// CHECK: owner, address and feed id are validated against the Match's asset in `read_price`.
    pub price_feed: UncheckedAccount<'info>,
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
    #[account(address = config.operator @ DuelError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TableConfig>,
    #[account(mut, seeds = [FUEL_SEED, &[fuel.n]], bump = fuel.bump)]
    pub fuel: Account<'info, Fuel>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
}
