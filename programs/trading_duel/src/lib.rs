//! Trading Duel: a head-to-head price grid on a live oracle price, as a Tesoro Game.
//!
//! One Match is 2.5 minutes on one asset (SOL, ETH or HYPE; the asset is encoded in the Match id).
//! The grid has 12 columns of 10 seconds and 8 price rows centred on the price when the Match
//! starts. Each Player picks one row per column; a column locks 10 seconds before its window, and
//! both picks are then revealed. A pick hits when the live price line crosses its row during the
//! column, for 100 points; more points wins the Pot through tesoro_core, equal points refunds it.
//! The Duel (public: the line, revealed picks and scores) and the two Books (each Player's picks,
//! readable only by that Player) are delegated to a MagicBlock Private Ephemeral Rollup.
//!
//! Layers: tesoro_core open/join on base, then `create_match` + `delegate_match` on base,
//! everything else in the rollup, `close_match` in the rollup, `finalize` on base.

pub mod engine;
pub mod state;

use anchor_lang::{prelude::*, system_program};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi},
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
};
use tesoro_core::{
    instructions::MatchResult,
    ledger::MatchStatus,
    state::{Config, MatchState, TesoroAccount, ACCOUNT_SEED, CONFIG_SEED},
};

pub use engine::EngineError;
pub use state::*;

declare_id!("CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj");

/// Identity of MagicBlock's TEE validator (devnet); delegation is pinned to it (see holdem).
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/// MagicBlock's real-time pricing oracle program: owner of the feed accounts.
pub const PRICE_PROGRAM: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
/// Pyth Lazer feed accounts on the rollup, indexed by asset (SOL/USD, ETH/USD, HYPE/USD).
pub const FEEDS: [Pubkey; 3] = [
    pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
    pubkey!("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"),
    pubkey!("CxEkVoCUwSAprvAhdWRPH63JeioQVNDtyZYEMRXuLu6x"),
];

const READ_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;

#[error_code]
pub enum DuelError {
    #[msg("Signer is not a Player of this Match")]
    NotAPlayer,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Match is not live")]
    NotLive,
    #[msg("Match already started")]
    AlreadyStarted,
    #[msg("The grid is not open")]
    GridClosed,
    #[msg("The grid window has not ended")]
    NotEnded,
    #[msg("Column out of range")]
    InvalidColumn,
    #[msg("Row must be 0 to 7, or 255 to clear")]
    InvalidRow,
    #[msg("That column is locked")]
    ColumnLocked,
    #[msg("Unknown asset")]
    InvalidAsset,
    #[msg("The oracle price is outside the end-of-window grace")]
    EndPriceOutOfWindow,
    #[msg("Not the price feed of this Match's asset")]
    BadPriceFeed,
    #[msg("The oracle price is stale or in the future")]
    StalePrice,
    #[msg("The oracle price is unusable")]
    BadPrice,
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
}

impl From<EngineError> for DuelError {
    fn from(e: EngineError) -> Self {
        match e {
            EngineError::BadColumn => DuelError::InvalidColumn,
            EngineError::BadRow => DuelError::InvalidRow,
            EngineError::Locked => DuelError::ColumnLocked,
        }
    }
}

fn eng<T>(r: core::result::Result<T, EngineError>) -> Result<T> {
    r.map_err(|e| error!(DuelError::from(e)))
}

/// Asset of a Match id: bits 1 and 2 (bit 0 is the app's Challenge marker). Only 0 (SOL), 1 (ETH) and 2 (HYPE) are valid.
pub fn asset_of(match_id: u64) -> Result<u8> {
    let asset = ((match_id >> ASSET_SHIFT) & ASSET_MASK) as u8;
    require!((asset as usize) < FEEDS.len(), DuelError::InvalidAsset);
    Ok(asset)
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

/// `publish_time` of a feed already validated by `read_price`.
fn published_at(feed: &AccountInfo) -> Result<i64> {
    let data = feed.try_borrow_data()?;
    Ok(i64::from_le_bytes(
        data[93..101].try_into().map_err(|_| DuelError::BadPrice)?,
    ))
}

/// Seconds since the Match started. The grid is open from the start until `ends_at`.
fn require_grid(duel: &Duel, now: i64) -> Result<i64> {
    require!(duel.status == STATUS_LIVE, DuelError::NotLive);
    require!(
        now >= duel.starts_at && now < duel.ends_at,
        DuelError::GridClosed
    );
    Ok(now - duel.starts_at)
}

/// Copies the picks of every locked column from both Books into the public Duel.
fn reveal(duel: &mut Duel, books: [&Book; 2], t: i64) {
    for c in 0..COLUMNS {
        if t >= engine::lock_at(c) {
            for (seat, book) in books.iter().enumerate() {
                duel.revealed[seat][c] = book.picks[c];
            }
        }
    }
}

/// Re-scores the columns that are final at `t`.
fn rescore(duel: &mut Duel, t: i64) {
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

    /// Base layer. Binds a Duel to an Active tesoro_core Match of this Game and pre-funds the
    /// ephemeral permission rent of its three accounts. Either Player may create it. The asset is
    /// read from the Match id.
    pub fn create_match(ctx: Context<CreateMatch>, match_id: u64) -> Result<()> {
        let asset = asset_of(match_id)?;
        let tesoro = &ctx.accounts.tesoro_match;
        require!(tesoro.id == match_id, DuelError::BadTesoroMatch);
        require!(
            tesoro.inner.status == MatchStatus::Active
                && tesoro.inner.game == ID.to_bytes()
                && tesoro.inner.a.player == ctx.accounts.account_a.key().to_bytes()
                && tesoro
                    .inner
                    .b
                    .as_ref()
                    .is_some_and(|b| b.player == ctx.accounts.account_b.key().to_bytes()),
            DuelError::BadTesoroMatch
        );
        let players = [
            ctx.accounts.account_a.authority,
            ctx.accounts.account_b.authority,
        ];
        require!(
            players.contains(&ctx.accounts.creator.key()),
            DuelError::NotAPlayer
        );

        let permission_rent =
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32);
        for target in [
            ctx.accounts.duel.to_account_info(),
            ctx.accounts.book_0.to_account_info(),
            ctx.accounts.book_1.to_account_info(),
        ] {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: target,
                    },
                ),
                permission_rent,
            )?;
        }

        let now = Clock::get()?.unix_timestamp;

        // Keep tesoro_core's one-hour refund timer from firing mid-Match (see holdem).
        let authority_bump = [ctx.bumps.authority];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &authority_bump]];
        tesoro_core::cpi::extend_match_deadline(
            CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::ExtendMatchDeadline {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                },
                signer_seeds,
            ),
            now.checked_add(TABLE_WINDOW_SECS)
                .ok_or(DuelError::Overflow)?,
        )?;

        let duel_key = ctx.accounts.duel.key();
        let duel = &mut ctx.accounts.duel;
        **duel = Duel {
            bump: ctx.bumps.duel,
            authority_bump: ctx.bumps.authority,
            match_id,
            tesoro_match: ctx.accounts.tesoro_match.key(),
            players,
            asset,
            start_deadline: now
                .checked_add(START_WINDOW_SECS)
                .ok_or(DuelError::Overflow)?,
            ..Duel::default()
        };

        // The Books are created zeroed; an all-zero pick would be row 0, so mark them empty.
        let book_0 = &mut ctx.accounts.book_0;
        ***book_0 = Book {
            bump: ctx.bumps.book_0,
            duel: duel_key,
            player: players[0],
            seat: 0,
            ..Book::default()
        };
        let book_1 = &mut ctx.accounts.book_1;
        ***book_1 = Book {
            bump: ctx.bumps.book_1,
            duel: duel_key,
            player: players[1],
            seat: 1,
            ..Book::default()
        };
        Ok(())
    }

    /// Base layer. Delegates the Duel and both Books to the TEE validator.
    pub fn delegate_match(ctx: Context<DelegateMatch>, match_id: u64) -> Result<()> {
        let config = || tee_config(&ctx.accounts.validator);
        let duel_key = ctx.accounts.duel.key();
        ctx.accounts.delegate_duel(
            &ctx.accounts.payer,
            &[DUEL_SEED, &match_id.to_le_bytes()],
            config()?,
        )?;
        ctx.accounts.delegate_book_0(
            &ctx.accounts.payer,
            &[BOOK_SEED, duel_key.as_ref(), &[0]],
            config()?,
        )?;
        ctx.accounts.delegate_book_1(
            &ctx.accounts.payer,
            &[BOOK_SEED, duel_key.as_ref(), &[1]],
            config()?,
        )?;
        Ok(())
    }

    /// Rollup. Creates the permissions (the Duel is public, each Book private to its Player) and
    /// starts the Match: the anchor price is read from the feed and recorded as the first sample,
    /// the line enters the grid after the head start, and the Match runs for 2.5 minutes.
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let duel = &mut ctx.accounts.duel;
        require!(duel.status == STATUS_CREATED, DuelError::AlreadyStarted);
        require!(now <= duel.start_deadline, DuelError::NotTimedOut);
        let anchor = read_price(&ctx.accounts.price_feed, duel.asset, now)?;
        duel.status = STATUS_LIVE;
        duel.starts_at = now;
        duel.grid_at = now
            .checked_add(HEAD_START_SECS)
            .ok_or(DuelError::Overflow)?;
        duel.ends_at = now.checked_add(MATCH_SECS).ok_or(DuelError::Overflow)?;
        duel.anchor = anchor;
        duel.step = engine::step_for(anchor, STEP_PPM[duel.asset as usize]);
        duel.track.record(0, anchor);
        duel.last_tick = now;

        let players = duel.players;
        let duel_key = duel.key();
        let match_id = duel.match_id.to_le_bytes();
        let duel_bump = duel.bump;
        let player_member = |pubkey: Pubkey| Member {
            flags: READ_FLAGS,
            pubkey,
        };

        create_permission(
            &*ctx.accounts,
            &ctx.accounts.duel.to_account_info(),
            &ctx.accounts.duel_permission,
            EphemeralMembersArgs {
                is_private: false,
                members: vec![],
            },
            &[DUEL_SEED, &match_id, &[duel_bump]],
            false,
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.book_0.to_account_info(),
            &ctx.accounts.book_0_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[0])],
            },
            &[
                BOOK_SEED,
                duel_key.as_ref(),
                &[0],
                &[ctx.accounts.book_0.bump],
            ],
            true,
        )?;
        create_permission(
            &*ctx.accounts,
            &ctx.accounts.book_1.to_account_info(),
            &ctx.accounts.book_1_permission,
            EphemeralMembersArgs {
                is_private: true,
                members: vec![player_member(players[1])],
            },
            &[
                BOOK_SEED,
                duel_key.as_ref(),
                &[1],
                &[ctx.accounts.book_1.bump],
            ],
            true,
        )?;
        Ok(())
    }

    /// Rollup. Picks `row` (0 bottom to 7 top) for `column`, or clears the pick with `NO_PICK`.
    /// Only a Player, only until 10 seconds before the column starts. The pick stays in the
    /// Player's own Book until the column locks.
    pub fn set_pick(ctx: Context<SetPick>, column: u8, row: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let duel = &ctx.accounts.duel;
        require!(duel.status == STATUS_LIVE, DuelError::NotLive);
        require!(now >= duel.starts_at, DuelError::GridClosed);
        let t = now - duel.starts_at;
        eng(engine::check_pick(column as usize, row, t))?;
        let book = &mut ctx.accounts.book;
        let slot = book.picks[column as usize];
        match (slot == NO_PICK, row == NO_PICK) {
            (true, false) => book.pick_count += 1,
            (false, true) => book.pick_count -= 1,
            _ => {}
        }
        book.picks[column as usize] = row;
        Ok(())
    }

    /// Rollup, permissionless. Samples the oracle into the current column, reveals the picks of
    /// every column that has locked, and scores the columns that are over. Clients call it about
    /// once a second; a sample is always a real price, so extra calls cannot fake a hit.
    pub fn tick(ctx: Context<Sample>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let duel = &mut ctx.accounts.duel;
        let t = require_grid(duel, now)?;
        let price = read_price(&ctx.accounts.price_feed, duel.asset, now)?;
        duel.track.record(t, price);
        reveal(duel, [&ctx.accounts.book_0, &ctx.accounts.book_1], t);
        rescore(duel, t);
        duel.last_tick = now;
        Ok(())
    }

    /// Rollup, permissionless. Once the window has closed: records the first oracle price
    /// published within `END_GRACE_SECS` after the end (or, if called later, the last price
    /// recorded during the window) as the final sample, scores every column and decides the Match:
    /// more points wins, equal points is a draw.
    pub fn end_match(ctx: Context<Sample>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let duel = &mut ctx.accounts.duel;
        require!(duel.status == STATUS_LIVE, DuelError::NotLive);
        require!(now >= duel.ends_at, DuelError::NotEnded);
        let grace_end = duel
            .ends_at
            .checked_add(END_GRACE_SECS)
            .ok_or(DuelError::Overflow)?;
        // On time: the first price published inside [ends_at, ends_at + grace]. Late: the last
        // price recorded during the window, so waiting for a better tick cannot change the result.
        let price = if now > grace_end {
            duel.track.last
        } else {
            let price = read_price(&ctx.accounts.price_feed, duel.asset, now)?;
            let published = published_at(&ctx.accounts.price_feed)?;
            require!(published >= duel.ends_at, DuelError::NotEnded);
            require!(published <= grace_end, DuelError::EndPriceOutOfWindow);
            price
        };
        duel.track.finish(price);
        reveal(
            duel,
            [&ctx.accounts.book_0, &ctx.accounts.book_1],
            MATCH_SECS,
        );
        rescore(duel, MATCH_SECS);
        duel.winner = engine::winner(duel.scores);
        duel.last_tick = now;
        duel.status = STATUS_OVER;
        Ok(())
    }

    /// Rollup, permissionless. A Match that was delegated but never started before its start
    /// deadline is cancelled, so `finalize` can refund both entries.
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let duel = &mut ctx.accounts.duel;
        require!(duel.status == STATUS_CREATED, DuelError::AlreadyStarted);
        require!(now > duel.start_deadline, DuelError::NotTimedOut);
        duel.status = STATUS_CANCELLED;
        Ok(())
    }

    /// Rollup. After the Match is over: closes the permissions and commits + undelegates
    /// everything. The Books are not wiped: once committed they are public, which is how both
    /// Players' picks become readable.
    pub fn close_match(ctx: Context<CloseMatch>) -> Result<()> {
        require!(
            ctx.accounts.duel.status == STATUS_OVER,
            DuelError::MatchNotOver
        );
        let duel_key = ctx.accounts.duel.key();
        let match_id = ctx.accounts.duel.match_id.to_le_bytes();
        ctx.accounts.duel.exit(&ID)?;
        ctx.accounts.book_0.exit(&ID)?;
        ctx.accounts.book_1.exit(&ID)?;

        close_permission(
            &*ctx.accounts,
            &ctx.accounts.duel.to_account_info(),
            &ctx.accounts.duel_permission,
            &[DUEL_SEED, &match_id, &[ctx.accounts.duel.bump]],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.book_0.to_account_info(),
            &ctx.accounts.book_0_permission,
            &[
                BOOK_SEED,
                duel_key.as_ref(),
                &[0],
                &[ctx.accounts.book_0.bump],
            ],
        )?;
        close_permission(
            &*ctx.accounts,
            &ctx.accounts.book_1.to_account_info(),
            &ctx.accounts.book_1_permission,
            &[
                BOOK_SEED,
                duel_key.as_ref(),
                &[1],
                &[ctx.accounts.book_1.bump],
            ],
        )?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.duel.to_account_info(),
            ctx.accounts.book_0.to_account_info(),
            ctx.accounts.book_1.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Rollup. A cancelled Duel never started, so it has no permissions: commits + undelegates
    /// it as it is, which lets `finalize` refund both entries.
    pub fn close_unstarted(ctx: Context<CloseUnstarted>) -> Result<()> {
        require!(
            ctx.accounts.duel.status == STATUS_CANCELLED,
            DuelError::MatchNotOver
        );
        ctx.accounts.duel.exit(&ID)?;
        ctx.accounts.book_0.exit(&ID)?;
        ctx.accounts.book_1.exit(&ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.duel.to_account_info(),
            ctx.accounts.book_0.to_account_info(),
            ctx.accounts.book_1.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer, permissionless. Settles the tesoro_core Match from the committed result by CPI,
    /// signing as this Game's `authority` PDA: the winner takes the Pot minus fees. A draw, a
    /// cancelled Match, or one never started before its start deadline refunds both entries.
    /// `remaining_accounts` are the payout accounts tesoro_core expects.
    pub fn finalize<'info>(ctx: Context<'_, '_, 'info, 'info, Finalize<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (status, winner, start_deadline, authority_bump) = {
            let d = &ctx.accounts.duel;
            (d.status, d.winner, d.start_deadline, d.authority_bump)
        };
        require!(!ctx.accounts.duel.finalized, DuelError::AlreadyFinalized);

        let bump = [authority_bump];
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &bump]];
        let remaining = ctx.remaining_accounts.to_vec();
        let refund = match status {
            STATUS_OVER => winner == DRAW,
            STATUS_CANCELLED => true,
            STATUS_CREATED => {
                require!(now > start_deadline, DuelError::NotTimedOut);
                true
            }
            _ => return err!(DuelError::MatchNotOver),
        };
        if refund {
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::RefundMatch {
                    caller: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(remaining);
            tesoro_core::cpi::refund_match(cpi)?;
        } else {
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.tesoro_program.to_account_info(),
                tesoro_core::cpi::accounts::SettleMatch {
                    game_authority: ctx.accounts.authority.to_account_info(),
                    config: ctx.accounts.config.to_account_info(),
                    match_state: ctx.accounts.tesoro_match.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(remaining);
            let result = if winner == 0 {
                MatchResult::Opener
            } else {
                MatchResult::Joiner
            };
            tesoro_core::cpi::settle_match(cpi, result)?;
        }
        ctx.accounts.duel.finalized = true;
        Ok(())
    }
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

/// Every permission CPI is signed by the permissioned PDA itself, which also pays the rent.
fn create_permission<'info, T: PermissionAccounts<'info>>(
    accounts: &T,
    data: &AccountInfo<'info>,
    permission: &UncheckedAccount<'info>,
    args: EphemeralMembersArgs,
    seeds: &[&[u8]],
    private: bool,
) -> Result<()> {
    if permission.lamports() > 0 {
        return require_real_permission(
            permission,
            data.key,
            private,
            error!(DuelError::PermissionNotReady),
        );
    }
    CreateEphemeralPermissionCpi {
        payer: data.clone(),
        permissioned_account: data.clone(),
        permission: permission.to_account_info(),
        vault: accounts.ephemeral_vault(),
        magic_program: accounts.magic_program(),
        permission_program: accounts.permission_program(),
        args,
    }
    .invoke_signed(&[seeds])?;
    Ok(())
}

/// A permission address that already holds lamports is accepted as "created" only if it really is
/// a permission of `permissioned`, owned by the permission program, with the expected privacy.
/// Lamports alone prove nothing: anyone can send some to the predictable address first.
fn require_real_permission(
    permission: &AccountInfo,
    permissioned: &Pubkey,
    private: bool,
    err: Error,
) -> Result<()> {
    if permission.owner != &PERMISSION_PROGRAM_ID {
        return Err(err);
    }
    let data = permission.try_borrow_data()?;
    match EphemeralPermission::from_bytes(&data) {
        Ok(p) if p.permissioned_account == *permissioned && p.private == private => Ok(()),
        _ => Err(err),
    }
}

/// Closes a permission.
fn close_permission<'info, T: PermissionAccounts<'info>>(
    accounts: &T,
    data: &AccountInfo<'info>,
    permission: &UncheckedAccount<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    CloseEphemeralPermissionCpi {
        payer: data.clone(),
        permissioned_account: data.clone(),
        permission: permission.to_account_info(),
        vault: accounts.ephemeral_vault(),
        magic_program: accounts.magic_program(),
        permission_program: accounts.permission_program(),
        authority: data.clone(),
        authority_is_signer: false,
    }
    .invoke_signed(&[seeds])?;
    Ok(())
}

trait PermissionAccounts<'info> {
    fn ephemeral_vault(&self) -> AccountInfo<'info>;
    fn magic_program(&self) -> AccountInfo<'info>;
    fn permission_program(&self) -> AccountInfo<'info>;
}

macro_rules! impl_permission_accounts {
    ($ty:ident) => {
        impl<'info> PermissionAccounts<'info> for $ty<'info> {
            fn ephemeral_vault(&self) -> AccountInfo<'info> {
                self.ephemeral_vault.to_account_info()
            }
            fn magic_program(&self) -> AccountInfo<'info> {
                self.magic_program.to_account_info()
            }
            fn permission_program(&self) -> AccountInfo<'info> {
                self.permission_program.to_account_info()
            }
        }
    };
}
impl_permission_accounts!(InitPermissions);
impl_permission_accounts!(CloseMatch);

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [tesoro_core::state::MATCH_SEED, &tesoro_match.id.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, seeds::program = tesoro_core::ID)]
    pub config: Box<Account<'info, Config>>,
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
    /// CHECK: this Game's settlement authority PDA; only its canonical bump is read here.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        init, payer = creator, space = 8 + Duel::INIT_SPACE,
        seeds = [DUEL_SEED, &match_id.to_le_bytes()], bump
    )]
    pub duel: Account<'info, Duel>,
    #[account(
        init, payer = creator, space = 8 + Book::INIT_SPACE,
        seeds = [BOOK_SEED, duel.key().as_ref(), &[0]], bump
    )]
    pub book_0: Box<Account<'info, Book>>,
    #[account(
        init, payer = creator, space = 8 + Book::INIT_SPACE,
        seeds = [BOOK_SEED, duel.key().as_ref(), &[1]], bump
    )]
    pub book_1: Box<Account<'info, Book>>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct DelegateMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Duel PDA to delegate
    #[account(mut, del, seeds = [DUEL_SEED, &match_id.to_le_bytes()], bump)]
    pub duel: AccountInfo<'info>,
    /// CHECK: Book PDA (seat 0) to delegate
    #[account(mut, del, seeds = [BOOK_SEED, duel.key().as_ref(), &[0]], bump)]
    pub book_0: AccountInfo<'info>,
    /// CHECK: Book PDA (seat 1) to delegate
    #[account(mut, del, seeds = [BOOK_SEED, duel.key().as_ref(), &[1]], bump)]
    pub book_1: AccountInfo<'info>,
    /// CHECK: TEE validator identity, checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct InitPermissions<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, &duel.match_id.to_le_bytes()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(mut, seeds = [BOOK_SEED, duel.key().as_ref(), &[0]], bump = book_0.bump)]
    pub book_0: Box<Account<'info, Book>>,
    #[account(mut, seeds = [BOOK_SEED, duel.key().as_ref(), &[1]], bump = book_1.bump)]
    pub book_1: Box<Account<'info, Book>>,
    /// CHECK: permission PDA of the Duel, verified by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, duel.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub duel_permission: UncheckedAccount<'info>,
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
    /// CHECK: owner, address and feed id are validated against the Match's asset in `read_price`.
    pub price_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetPick<'info> {
    pub player: Signer<'info>,
    #[account(seeds = [DUEL_SEED, &duel.match_id.to_le_bytes()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(
        mut,
        seeds = [BOOK_SEED, duel.key().as_ref(), &[book.seat]],
        bump = book.bump,
        constraint = book.player == player.key() @ DuelError::NotAPlayer
    )]
    pub book: Box<Account<'info, Book>>,
}

/// Shared by `tick` and `end_match`: `caller` is any payer.
#[derive(Accounts)]
pub struct Sample<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, &duel.match_id.to_le_bytes()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(seeds = [BOOK_SEED, duel.key().as_ref(), &[0]], bump = book_0.bump)]
    pub book_0: Box<Account<'info, Book>>,
    #[account(seeds = [BOOK_SEED, duel.key().as_ref(), &[1]], bump = book_1.bump)]
    pub book_1: Box<Account<'info, Book>>,
    /// CHECK: owner, address and feed id are validated against the Match's asset in `read_price`.
    pub price_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, &duel.match_id.to_le_bytes()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
}

#[commit]
#[derive(Accounts)]
pub struct CloseMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, &duel.match_id.to_le_bytes()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(mut, seeds = [BOOK_SEED, duel.key().as_ref(), &[0]], bump = book_0.bump)]
    pub book_0: Box<Account<'info, Book>>,
    #[account(mut, seeds = [BOOK_SEED, duel.key().as_ref(), &[1]], bump = book_1.bump)]
    pub book_1: Box<Account<'info, Book>>,
    /// CHECK: permission PDA of the Duel
    #[account(mut, seeds = [PERMISSION_SEED, duel.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub duel_permission: UncheckedAccount<'info>,
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
}

#[commit]
#[derive(Accounts)]
pub struct CloseUnstarted<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, &duel.match_id.to_le_bytes()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(mut, seeds = [BOOK_SEED, duel.key().as_ref(), &[0]], bump = book_0.bump)]
    pub book_0: Box<Account<'info, Book>>,
    #[account(mut, seeds = [BOOK_SEED, duel.key().as_ref(), &[1]], bump = book_1.bump)]
    pub book_1: Box<Account<'info, Book>>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, &duel.match_id.to_le_bytes()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(
        mut,
        address = duel.tesoro_match,
        seeds = [tesoro_core::state::MATCH_SEED, &tesoro_match.id.to_le_bytes()],
        bump = tesoro_match.bump,
        seeds::program = tesoro_core::ID
    )]
    pub tesoro_match: Box<Account<'info, MatchState>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, seeds::program = tesoro_core::ID)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the registered Game authority; signs the CPI with its stored canonical bump.
    #[account(seeds = [AUTHORITY_SEED], bump = duel.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub tesoro_program: Program<'info, tesoro_core::program::TesoroCore>,
}
