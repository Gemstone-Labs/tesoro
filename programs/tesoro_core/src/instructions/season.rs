//! Seasons with a frozen prize budget (spec "Season order": the Season ends, `fund_season_prize`,
//! `record_season`, the 48-hour void window, `pay_season_rank`).
//!
//! * `record_season` stores the ranking and a **frozen budget** from the Pool's basket (its
//!   biggest free lines), reserved so a later Season cannot promise the same Gemas, and waits for
//!   every registered route with its prize escrow on to have funded this Season.
//! * `pay_season_rank` pays one (rank, budget line) step: each rank takes the same fraction of
//!   every budget line, so every rank gets the same mix of coins whatever the Pool holds or
//!   receives later. It rounds down; the leftovers roll into the next Season.
//! * `void_season_rank` (admin, inside the window) and `close_season` (anyone, once every rank is
//!   paid or voided) release what was not paid.
//!
//! The ranking is recomputable from `MatchWon` events; the keeper (or the admin) records it.

use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::overflow::{credit_prize, season_overflow_id};
use crate::instructions::prize::{check_prize_source, route_of, season_authority, take_exact};
use crate::ledger::line_store::{LineKey, LineStore, CLASS_GENERAL};
use crate::ledger::{self, PoolLine, PoolReservations, Ranked};
use crate::state::*;
use crate::storage::*;
use crate::util::now;
use anchor_lang::prelude::*;

fn require_pool(config: &Config, pool: &Pubkey) -> Result<()> {
    require!(
        config.pool_account != Pubkey::default(),
        TesoroError::LeaderboardOff
    );
    require_keys_eq!(config.pool_account, *pool, TesoroError::InvalidAccount);
    Ok(())
}

/// Most Pool lines a Season looks at when it freezes its budget.
const MAX_POOL_LINES: usize = 256;

/// Records the ranking of a season that has ended and freezes what it pays. `points` are in rank
/// order, one per ranked Player; the first `points.len()` remaining accounts are the Players'
/// `TesoroAccount`s in the same order, followed by the custody of every route the economy settings
/// name (each exactly once). Once per season: the `Season` account is created here.
#[derive(Accounts)]
#[instruction(number: u32)]
pub struct RecordSeason<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump
    )]
    pub pool_account: Account<'info, TesoroAccount>,
    /// CHECK: the Pool's basket, checked by its seeds.
    #[account(seeds = [BASKET_SEED, pool_account.key().as_ref()], bump)]
    pub pool_basket: UncheckedAccount<'info>,
    /// CHECK: the Pool's spill, checked by its seeds. Prize Gemas that did not fit the basket wait
    /// here and are part of the budget.
    #[account(seeds = [SPILL_SEED, pool_account.key().as_ref()], bump)]
    pub pool_spill: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = PoolReservationsState::SPACE,
        seeds = [POOL_RESERVATIONS_SEED],
        bump
    )]
    pub reservations: Account<'info, PoolReservationsState>,
    #[account(
        init,
        payer = authority,
        space = SeasonState::SPACE,
        seeds = [SEASON_SEED, &number.to_le_bytes()],
        bump
    )]
    pub season: Account<'info, SeasonState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn record_season<'info>(
    ctx: Context<'_, '_, 'info, 'info, RecordSeason<'info>>,
    number: u32,
    points: Vec<u64>,
) -> Result<()> {
    season_authority(
        &ctx.accounts.config,
        &ctx.accounts.economy,
        &ctx.accounts.authority.key(),
    )?;
    require_pool(&ctx.accounts.config, &ctx.accounts.pool_account.key())?;
    let n = points.len();
    require!(
        ctx.remaining_accounts.len() >= n,
        TesoroError::BadRemainingAccounts
    );
    let (ranked_infos, route_infos) = ctx.remaining_accounts.split_at(n);
    let mut ranking = Vec::with_capacity(n);
    for (info, p) in ranked_infos.iter().zip(points) {
        let account = Account::<TesoroAccount>::try_from(info)?;
        let expected = Pubkey::create_program_address(
            &[ACCOUNT_SEED, account.authority.as_ref(), &[account.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(TesoroError::InvalidAccount))?;
        require_keys_eq!(expected, *info.key, TesoroError::InvalidAccount);
        ranking.push(Ranked {
            account: info.key.to_bytes(),
            points: p,
        });
    }
    // Every registered route, each once.
    let economy = &ctx.accounts.economy;
    let registered: Vec<Pubkey> = economy
        .routes
        .iter()
        .copied()
        .filter(|r| *r != Pubkey::default())
        .collect();
    require!(
        route_infos.len() == registered.len()
            && registered
                .iter()
                .all(|r| route_infos.iter().filter(|i| i.key == r).count() == 1),
        TesoroError::BadRemainingAccounts
    );
    let routes: Vec<ledger::RouteLedger> = route_infos
        .iter()
        .map(route_of)
        .collect::<Result<Vec<_>>>()?;
    let route_refs: Vec<&ledger::RouteLedger> = routes.iter().collect();

    let mut pool_lines: Vec<PoolLine> = Vec::new();
    for info in [
        ctx.accounts.pool_basket.to_account_info(),
        ctx.accounts.pool_spill.to_account_info(),
    ] {
        let data = info.try_borrow_data()?;
        let store = LineStore::new(&data[DISC..]).map_err(store_err)?;
        for l in store.lines() {
            if l.class >= CLASS_GENERAL && l.amount > 0 {
                require!(
                    pool_lines.len() < MAX_POOL_LINES,
                    TesoroError::InvalidAccount
                );
                pool_lines.push(PoolLine {
                    key: l.key(),
                    amount: l.amount,
                });
            }
        }
    }
    let mut reservations: PoolReservations = ctx.accounts.reservations.reservations();
    let recorded_at = now()?;
    let inner = ledger::PrizeSeason::record(
        number,
        recorded_at,
        &route_refs,
        &pool_lines,
        &mut reservations,
        &ranking,
    )
    .map_err(core_err)?;
    require!(
        reservations.entries().len() <= ledger::MAX_RESERVATION_ENTRIES,
        TesoroError::InvalidAccount
    );
    let budget: u64 = inner.lines.iter().map(|l| l.amount).sum();
    emit!(SeasonRecorded {
        season: number,
        pool_total: budget,
        winners: inner.count,
    });
    if ctx.accounts.reservations.bump == 0 {
        ctx.accounts.reservations.bump = ctx.bumps.reservations;
    }
    ctx.accounts.reservations.set_reservations(&reservations);
    let season = &mut ctx.accounts.season;
    season.bump = ctx.bumps.season;
    season.inner = inner;
    Ok(())
}

/// Pays one (rank, budget line) step of a recorded season out of the Pool's basket, once, from 48
/// hours after it was recorded and never for a voided rank. `line` must be the rank's next unpaid
/// budget line; the prize Source of that line is the last account.
#[derive(Accounts)]
pub struct PaySeasonRank<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    #[account(
        mut,
        seeds = [SEASON_SEED, &season.inner.number.to_le_bytes()],
        bump = season.bump
    )]
    pub season: Account<'info, SeasonState>,
    #[account(mut, seeds = [POOL_RESERVATIONS_SEED], bump = reservations.bump)]
    pub reservations: Account<'info, PoolReservationsState>,
    #[account(
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump
    )]
    pub pool_account: Account<'info, TesoroAccount>,
    /// CHECK: the Pool's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, pool_account.key().as_ref()], bump)]
    pub pool_basket: UncheckedAccount<'info>,
    /// CHECK: the Pool's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, pool_account.key().as_ref()], bump)]
    pub pool_spill: UncheckedAccount<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, winner_account.authority.as_ref()],
        bump = winner_account.bump
    )]
    pub winner_account: Account<'info, TesoroAccount>,
    /// CHECK: the winner's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, winner_account.key().as_ref()], bump)]
    pub winner_basket: UncheckedAccount<'info>,
    /// CHECK: the winner's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, winner_account.key().as_ref()], bump)]
    pub winner_spill: UncheckedAccount<'info>,
    pub prize_source: Account<'info, PrizeSourceState>,
}

pub(crate) fn pay_season_rank<'info>(
    ctx: Context<'_, '_, 'info, 'info, PaySeasonRank<'info>>,
    rank: u8,
    line: u8,
) -> Result<()> {
    let a = ctx.accounts;
    season_authority(&a.config, &a.economy, &a.authority.key())?;
    require_pool(&a.config, &a.pool_account.key())?;
    let winner = a.winner_account.key();
    require!(
        (rank as usize) < ledger::PRIZE_PLACES
            && a.season.inner.winners[rank as usize] == winner.to_bytes(),
        TesoroError::InvalidAccount
    );
    let ts = now()?;
    let mut reservations = a.reservations.reservations();
    let step = a
        .season
        .inner
        .pay_step(&mut reservations, rank, line as usize, ts)
        .map_err(core_err)?;
    a.reservations.set_reservations(&reservations);
    if step.amount > 0 {
        let source = Pubkey::new_from_array(step.key.source);
        require_keys_eq!(a.prize_source.key(), source, TesoroError::InvalidAccount);
        // Only a prize Source may be paid out of the Pool this way: it has no book to bring up
        // to date, and the PDA proves what it is.
        check_prize_source(&a.prize_source, &a.prize_source.key())?;
        let key: LineKey = step.key;
        let taken = with_pool(
            &a.pool_basket.to_account_info(),
            &a.pool_spill.to_account_info(),
            |pool| take_exact(pool, &key, step.amount),
        )?;
        // A winner whose stores are full still gets the prize: the line goes to an overflow
        // record the keeper's transaction creates (remaining accounts: the record, the system
        // program), and anyone claims it into the stores once there is room.
        let season = a.season.inner.number;
        credit_prize(
            &a.winner_basket.to_account_info(),
            &a.winner_spill.to_account_info(),
            &winner,
            &taken,
            ctx.remaining_accounts,
            &a.authority.to_account_info(),
            OVERFLOW_SEASON,
            &season_overflow_id(season, rank, line),
        )?;
    }
    emit!(SeasonPrizePaid {
        season: a.season.inner.number,
        rank,
        account: winner,
        amount: step.amount,
    });
    Ok(())
}

/// Voids one rank of a recorded season (admin only, inside the payout window, before it is paid).
/// The slot pays nothing and the other ranks keep their places and amounts; the voided share
/// stays in the Pool and rolls into the next season once the season is closed.
#[derive(Accounts)]
pub struct VoidSeasonRank<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ TesoroError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [SEASON_SEED, &season.inner.number.to_le_bytes()],
        bump = season.bump
    )]
    pub season: Account<'info, SeasonState>,
}

pub(crate) fn void_season_rank(ctx: Context<VoidSeasonRank>, rank: u8) -> Result<()> {
    let ts = now()?;
    let number = ctx.accounts.season.inner.number;
    ctx.accounts.season.inner.void(rank, ts).map_err(core_err)?;
    emit!(SeasonRankVoided {
        season: number,
        rank,
        account: Pubkey::new_from_array(ctx.accounts.season.inner.winners[rank as usize]),
    });
    Ok(())
}

/// Releases what no rank took (rounding dust and voided ranks' shares) so it rolls into the next
/// Season's budget. Anyone, once every rank is paid or voided and the window has passed.
#[derive(Accounts)]
pub struct CloseSeason<'info> {
    #[account(
        mut,
        seeds = [SEASON_SEED, &season.inner.number.to_le_bytes()],
        bump = season.bump
    )]
    pub season: Account<'info, SeasonState>,
    #[account(mut, seeds = [POOL_RESERVATIONS_SEED], bump = reservations.bump)]
    pub reservations: Account<'info, PoolReservationsState>,
}

pub(crate) fn close_season(ctx: Context<CloseSeason>) -> Result<()> {
    let mut reservations = ctx.accounts.reservations.reservations();
    ctx.accounts
        .season
        .inner
        .close(&mut reservations, now()?)
        .map_err(core_err)?;
    ctx.accounts.reservations.set_reservations(&reservations);
    Ok(())
}
