use crate::error::{core_err, TesoroError};
use crate::ledger::{self, Ranked};
use crate::state::*;
use crate::util::*;
use anchor_lang::prelude::*;

/// The admin or the keeper (the Config's oracle authority) runs the season: they rank, Tesoro pays.
fn require_season_authority(config: &Config, signer: &Pubkey) -> Result<()> {
    require!(
        *signer == config.admin || *signer == config.oracle_authority,
        TesoroError::Unauthorized
    );
    Ok(())
}

fn require_pool(config: &Config, pool: &Pubkey) -> Result<()> {
    require!(
        config.pool_account != Pubkey::default(),
        TesoroError::LeaderboardOff
    );
    require_keys_eq!(config.pool_account, *pool, TesoroError::InvalidAccount);
    Ok(())
}

/// Records the ranking of a season that has ended and fixes what each rank is paid: a share of
/// the pool as it stands now (`ledger::PRIZE_BPS`, floored). `points` are in rank order, one per
/// ranked Player; `remaining_accounts` are the Players' `TesoroAccount`s in the same order.
/// Accounts are checked to exist and be genuine; the ranking itself comes from the keeper (the
/// standings are recomputable from `MatchWon` events, see ADR 0006). Once per season: the
/// `Season` account is created here.
#[derive(Accounts)]
#[instruction(number: u32)]
pub struct RecordSeason<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump
    )]
    pub pool_account: Account<'info, TesoroAccount>,
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
    require_season_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    require_pool(&ctx.accounts.config, &ctx.accounts.pool_account.key())?;
    require!(
        points.len() == ctx.remaining_accounts.len(),
        TesoroError::BadRemainingAccounts
    );
    let mut ranking = Vec::with_capacity(points.len());
    for (info, p) in ctx.remaining_accounts.iter().zip(points) {
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
    let pool = &ctx.accounts.pool_account.inner;
    let pool_total = pool
        .own_total
        .checked_add(pool.won_total)
        .ok_or_else(|| error!(TesoroError::InvalidAccount))?;
    let inner = ledger::Season::record(number, now()?, pool_total, &ranking).map_err(core_err)?;
    emit!(SeasonRecorded {
        season: number,
        pool_total,
        winners: inner.count,
    });
    let season = &mut ctx.accounts.season;
    season.bump = ctx.bumps.season;
    season.inner = inner;
    Ok(())
}

/// Pays one rank of a recorded season out of the pool, once. Gemas keep their Source: the pool's
/// Holdings are drained in ascending Source order (`ledger::plan_prize`) into the winner's
/// Holdings of the same Sources. `remaining_accounts`: n pool Holdings, then n winner Holdings,
/// the same Sources in the same order.
#[derive(Accounts)]
pub struct PaySeasonRank<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [SEASON_SEED, &season.inner.number.to_le_bytes()],
        bump = season.bump
    )]
    pub season: Account<'info, SeasonState>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump
    )]
    pub pool_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, winner_account.authority.as_ref()],
        bump = winner_account.bump
    )]
    pub winner_account: Account<'info, TesoroAccount>,
}

pub(crate) fn pay_season_rank<'info>(
    ctx: Context<'_, '_, 'info, 'info, PaySeasonRank<'info>>,
    rank: u8,
) -> Result<()> {
    require_season_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    require_pool(&ctx.accounts.config, &ctx.accounts.pool_account.key())?;
    let winner = ctx.accounts.winner_account.key();
    let amount = ctx
        .accounts
        .season
        .inner
        .pay(rank)
        .map_err(core_err)
        .and_then(|a| {
            // `pay` checked the rank is below `count`.
            if ctx.accounts.season.inner.winners[rank as usize] == winner.to_bytes() {
                Ok(a)
            } else {
                Err(error!(TesoroError::InvalidAccount))
            }
        })?;
    let n = ctx.remaining_accounts.len();
    if amount == 0 {
        require!(n == 0, TesoroError::BadRemainingAccounts);
    } else {
        require!(n > 0 && n & 1 == 0, TesoroError::BadRemainingAccounts);
        let (pool_infos, winner_infos) = ctx.remaining_accounts.split_at(n / 2);
        let pool_key = ctx.accounts.pool_account.key();
        let mut pool_holdings = load_holdings(&pool_key, pool_infos)?;
        let mut winner_holdings = load_holdings(&winner, winner_infos)?;
        let held: Vec<ledger::Holding> = pool_holdings.iter().map(|h| h.inner.clone()).collect();
        let plan = ledger::plan_prize(&held, amount).map_err(core_err)?;
        for (p, w) in pool_holdings.iter().zip(&winner_holdings) {
            require!(
                p.inner.source == w.inner.source,
                TesoroError::InvalidAccount
            );
        }
        let pool_acct = &mut ctx.accounts.pool_account.inner;
        with_holdings(&mut pool_holdings, |hs| {
            for (h, take) in hs.iter_mut().zip(&plan) {
                h.debit(pool_acct, *take)?;
            }
            Ok(())
        })?;
        let winner_acct = &mut ctx.accounts.winner_account.inner;
        with_holdings(&mut winner_holdings, |hs| {
            for (h, take) in hs.iter_mut().zip(&plan) {
                h.credit(winner_acct, *take)?;
            }
            Ok(())
        })?;
    }
    emit!(SeasonPrizePaid {
        season: ctx.accounts.season.inner.number,
        rank,
        account: winner,
        amount,
    });
    Ok(())
}
