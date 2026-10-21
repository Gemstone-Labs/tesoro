//! The Pool's prize on ETH and HyperEVM routes (ticket 16): the Solana half of a prize escrow that
//! lives in an EVM vault.
//!
//! The escrow's shares sit in the vault, so core keeps no `RouteLedger` for them. The bridge (the
//! chain's registered source authority) vouches for the figures it reads from the vault's
//! acknowledgements and signs these three instructions; core only owns the Gemas side:
//!
//! * `issue_prize_from_source`: once per Season and route, a prize Source is issued for the shares
//!   the vault confirmed and not yet issued, and its Gemas are credited to the Pool's basket.
//! * `begin_prize_payout_from_source`: a holder's prize Gemas are burned and their share of the
//!   prize Source leaves it, to be paid on the vault by a `PayPrize` message (the bridge keeps
//!   the shares reserved until the vault acknowledges them).
//! * `cancel_prize_payout_from_source`: the vault rejected the payout for good; the holder gets
//!   the Gemas back and the prize Source its shares.
//!
//! The prize Source is the same `PrizeSourceState` as on the Solana routes (seeds
//! `["prize", route, season]`, `route` = the bridge's route account), and its Gemas are ordinary
//! prize lines in baskets, so Season payouts and the Pool's reservations need no change. Plain
//! `redeem_prize` cannot spend them: it demands the route's custody account.

use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::position::chain_byte;
use crate::instructions::prize::{
    check_prize_source, prize_line_key, put_prize, require_season_authority,
};
use crate::ledger::line_store::SIDE_WON;
use crate::ledger::{
    self, season_end, CoreError, PrizePayout, PrizeSource, RouteLedger, ShareRate, SourceChain,
};
use crate::state::*;
use crate::storage::*;
use crate::util::now;
use anchor_lang::prelude::*;

#[event]
pub struct EvmPrizeIssued {
    pub season: u32,
    pub route: Pubkey,
    pub prize_source: Pubkey,
    pub shares: u128,
    pub gemas: u64,
}

#[event]
pub struct EvmPrizePayoutBegun {
    pub prize_source: Pubkey,
    pub account: Pubkey,
    pub gemas: u64,
    pub shares: u128,
}

#[event]
pub struct EvmPrizePayoutCancelled {
    pub prize_source: Pubkey,
    pub account: Pubkey,
    pub gemas: u64,
    pub shares: u128,
}

fn route_ledger_for(ps: &PrizeSource) -> RouteLedger {
    // The prize Source's own shares are the only part of the escrow this account can touch; a
    // scratch ledger with exactly that backing reuses the payout math of the Solana routes.
    RouteLedger {
        escrow_backing: ps.shares,
        ..RouteLedger::default()
    }
}

/// The price of one whole Source asset in micro-USD: from the asset's Pyth feed when its
/// `OnchainPrice` exists (remaining accounts: that account, then the feed), else supplied by the
/// oracle authority, as for an Advance.
fn prize_price<'info>(
    asset: &Pubkey,
    oracle: Option<&Signer<'info>>,
    config: &Config,
    supplied: u64,
    remaining: &[AccountInfo<'info>],
) -> Result<u64> {
    let marker = remaining.first().ok_or(TesoroError::BadRemainingAccounts)?;
    require_keys_eq!(
        *marker.key,
        Pubkey::find_program_address(&[ONCHAIN_PRICE_SEED, asset.as_ref()], &crate::ID).0,
        TesoroError::InvalidAccount
    );
    if *marker.owner == crate::ID && !marker.data_is_empty() {
        let feed = remaining.get(1).ok_or(TesoroError::BadRemainingAccounts)?;
        let data = marker.try_borrow_data()?;
        let op = OnchainPrice::try_deserialize(&mut &data[..])?;
        require_keys_eq!(op.asset, *asset, TesoroError::InvalidAccount);
        require_keys_eq!(op.feed, *feed.key, TesoroError::BadPriceFeed);
        return op.read(feed, now()?);
    }
    let oracle = oracle.ok_or(TesoroError::Unauthorized)?;
    require_keys_eq!(
        oracle.key(),
        config.oracle_authority,
        TesoroError::Unauthorized
    );
    require!(!config.oracle_locked, TesoroError::OracleLocked);
    require!(supplied > 0, TesoroError::StalePrice);
    Ok(supplied)
}

/// Issues the prize Source of `(route, season)` for `shares` the vault confirmed in its escrow,
/// worth `units` of the Source asset, and credits its Gemas to the Pool. Signed by the Season
/// authority (admin or keeper) and by the chain's source authority (the bridge, which checked the
/// vault's acknowledgements and that the Season has not been funded on the route yet).
#[derive(Accounts)]
#[instruction(chain: SourceChain, season: u32, route: Pubkey)]
pub struct IssuePrizeFromSource<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Account<'info, SourceAuthority>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = economy.bump)]
    pub economy: Box<Account<'info, EconomyConfig>>,
    /// Only for the oracle-priced path (no `OnchainPrice` for the asset).
    pub oracle: Option<Signer<'info>>,
    #[account(
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump,
        constraint = pool_account.key() == config.pool_account @ TesoroError::InvalidAccount
    )]
    pub pool_account: Account<'info, TesoroAccount>,
    /// CHECK: the Pool's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, pool_account.key().as_ref()], bump)]
    pub pool_basket: UncheckedAccount<'info>,
    /// CHECK: the Pool's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, pool_account.key().as_ref()], bump)]
    pub pool_spill: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = PrizeSourceState::SPACE,
        seeds = [PRIZE_SOURCE_SEED, route.as_ref(), &season.to_le_bytes()],
        bump
    )]
    pub prize_source: Account<'info, PrizeSourceState>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn issue_prize_from_source<'info>(
    ctx: Context<'_, '_, 'info, 'info, IssuePrizeFromSource<'info>>,
    chain: SourceChain,
    season: u32,
    route: Pubkey,
    asset: Pubkey,
    decimals: u8,
    shares: u128,
    units: u64,
    price_micro_usd: u64,
) -> Result<()> {
    require!(chain != SourceChain::Solana, TesoroError::InvalidAccount);
    let remaining = ctx.remaining_accounts;
    let bump = ctx.bumps.prize_source;
    let a = ctx.accounts;
    require_season_authority(&a.config, &a.economy, &a.authority.key())?;
    require!(
        now()? >= season_end(season).map_err(core_err)?,
        TesoroError::InvalidAccount
    );
    require!(shares > 0 && units > 0, TesoroError::InvalidAccount);
    let price = prize_price(
        &asset,
        a.oracle.as_ref(),
        &a.config,
        price_micro_usd,
        remaining,
    )?;
    // Reported Sources count one unit as one share, so the units are the value of the shares.
    let one = ShareRate::new(1, 1).map_err(core_err)?;
    let gemas = ledger::economy::gemas_for_shares(u128::from(units), &one, decimals, price)
        .map_err(core_err)?;
    require!(gemas > 0, TesoroError::InvalidAccount);
    let key = a.prize_source.key();
    a.prize_source.bump = bump;
    a.prize_source.route = route;
    a.prize_source.season = season;
    a.prize_source.inner = PrizeSource {
        source: key.to_bytes(),
        shares,
        gemas,
    };
    let line = ledger::prize::prize_line(SIDE_WON, 0, key.to_bytes(), gemas);
    with_pool(
        &a.pool_basket.to_account_info(),
        &a.pool_spill.to_account_info(),
        |pool| put_prize(pool, &line),
    )?;
    emit!(EvmPrizeIssued {
        season,
        route,
        prize_source: key,
        shares,
        gemas,
    });
    Ok(())
}

/// A holder's prize Redeem on an EVM route, signed by the holder and the bridge: `amount` prize
/// Gemas burn and `amount / gemas` of the prize Source's shares leave it. The bridge reads the
/// shares from the Source's change and sends them as a `PayPrize`.
#[derive(Accounts)]
#[instruction(chain: SourceChain)]
pub struct BeginPrizePayoutFromSource<'info> {
    pub holder_authority: Signer<'info>,
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Account<'info, SourceAuthority>,
    #[account(
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump
    )]
    pub holder_account: Account<'info, TesoroAccount>,
    /// CHECK: the holder's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, holder_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the holder's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, holder_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    #[account(mut)]
    pub prize_source: Account<'info, PrizeSourceState>,
}

pub(crate) fn begin_prize_payout_from_source(
    ctx: Context<BeginPrizePayoutFromSource>,
    chain: SourceChain,
    amount: u64,
) -> Result<()> {
    let _ = chain;
    let a = ctx.accounts;
    let key = a.prize_source.key();
    check_prize_source(&a.prize_source, &key)?;
    let line_key = prize_line_key(&key);
    with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            let (at, idx, mut line) =
                find_line(pool, &line_key).ok_or_else(|| core_err(CoreError::HoldingMismatch))?;
            pool.check_withdraw(amount).map_err(draw_err)?;
            if amount > line.amount {
                return Err(core_err(CoreError::InsufficientGemas));
            }
            line.amount -= amount;
            store_line(pool, at, idx, &line)
        },
    )?;
    let mut scratch = route_ledger_for(&a.prize_source.inner);
    let payout = scratch
        .begin_prize_payout(&mut a.prize_source.inner, amount)
        .map_err(core_err)?;
    emit!(EvmPrizePayoutBegun {
        prize_source: key,
        account: a.holder_account.key(),
        gemas: payout.gemas,
        shares: payout.shares,
    });
    Ok(())
}

/// The vault rejected a payout for good: the holder gets the Gemas back and the prize Source its
/// shares. Signed by the bridge alone; the Gemas return to the Account the payout was made for.
#[derive(Accounts)]
#[instruction(chain: SourceChain)]
pub struct CancelPrizePayoutFromSource<'info> {
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Account<'info, SourceAuthority>,
    #[account(
        seeds = [ACCOUNT_SEED, holder_account.authority.as_ref()],
        bump = holder_account.bump
    )]
    pub holder_account: Account<'info, TesoroAccount>,
    /// CHECK: the holder's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, holder_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the holder's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, holder_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    #[account(mut)]
    pub prize_source: Account<'info, PrizeSourceState>,
}

pub(crate) fn cancel_prize_payout_from_source(
    ctx: Context<CancelPrizePayoutFromSource>,
    chain: SourceChain,
    gemas: u64,
    shares: u128,
) -> Result<()> {
    let _ = chain;
    let a = ctx.accounts;
    let key = a.prize_source.key();
    check_prize_source(&a.prize_source, &key)?;
    let mut scratch = RouteLedger {
        escrow_backing: a.prize_source.inner.shares,
        escrow_pending: shares,
        ..RouteLedger::default()
    };
    scratch
        .cancel_prize_payout(&mut a.prize_source.inner, PrizePayout { shares, gemas })
        .map_err(core_err)?;
    let line = ledger::prize::prize_line(SIDE_WON, 0, key.to_bytes(), gemas);
    with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| put_prize(pool, &line),
    )?;
    emit!(EvmPrizePayoutCancelled {
        prize_source: key,
        account: a.holder_account.key(),
        gemas,
        shares,
    });
    Ok(())
}
