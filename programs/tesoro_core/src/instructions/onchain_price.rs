//! Mainnet Advance pricing (ADR 0011). An Advance converts a Position's yield, in the units of its
//! Principal (SOL base units for a staking-token Position, since Principal is recorded at the
//! pool's rate; wei or the like for an EVM Position), to Gemas at $0.01 with the USD price of one
//! whole unit. On mainnet that price is read from a Pyth sponsored push feed account, mapped per
//! asset by the admin in an `OnchainPrice`. The keeper's price job and the oracle-supplied price of
//! `take_advance` serve test mode only: `take_advance` refuses an asset once it has a mapping.

use crate::error::TesoroError;
use crate::instructions::economy::*;
use crate::instructions::native::{is_native, is_stake};
use crate::instructions::position::chain_byte;
use crate::pyth::{
    MAX_ONCHAIN_CONF_BPS, MAX_ONCHAIN_PRICE_AGE_SECS, PRICE_UPDATE_V2, PYTH_RECEIVER,
};
use crate::state::*;
use crate::storage::*;
use crate::util::{now, require_can_advance};
use anchor_lang::prelude::*;
use sim_lst::Pool;

/// Admin: maps `asset` (the `source_asset` of the Positions to price) to a Pyth feed.
#[derive(Accounts)]
#[instruction(asset: Pubkey)]
pub struct SetOnchainPrice<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = OnchainPrice::SPACE,
        seeds = [ONCHAIN_PRICE_SEED, asset.as_ref()],
        bump
    )]
    pub onchain_price: Account<'info, OnchainPrice>,
    /// CHECK: must be a verified Pyth price update carrying `feed_id`; checked below.
    pub feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_onchain_price(
    ctx: Context<SetOnchainPrice>,
    asset: Pubkey,
    feed_id: [u8; 32],
    max_age_secs: u32,
    max_conf_bps: u16,
) -> Result<()> {
    require!(
        (1..=MAX_ONCHAIN_PRICE_AGE_SECS).contains(&max_age_secs)
            && (1..=MAX_ONCHAIN_CONF_BPS).contains(&max_conf_bps)
            && feed_id != [0u8; 32],
        TesoroError::BadPriceFeed
    );
    let a = ctx.accounts;
    require_keys_eq!(*a.feed.owner, PYTH_RECEIVER, TesoroError::BadPriceFeed);
    {
        let data = a.feed.try_borrow_data()?;
        require!(
            data.len() == crate::pyth::PRICE_UPDATE_V2_LEN
                && data[0..8] == PRICE_UPDATE_V2
                && data[40] == 1
                && data[41..73] == feed_id[..],
            TesoroError::BadPriceFeed
        );
    }
    let p = &mut a.onchain_price;
    p.bump = ctx.bumps.onchain_price;
    p.asset = asset;
    p.feed = a.feed.key();
    p.feed_id = feed_id;
    p.max_age_secs = max_age_secs;
    p.max_conf_bps = max_conf_bps;
    emit!(OnchainPriceSet {
        asset,
        feed: p.feed,
        feed_id,
    });
    Ok(())
}

/// Closes the oracle-priced path: `take_advance` passes the asset's `OnchainPrice` address as its
/// first remaining account and fails when that account exists.
pub fn require_no_onchain_price(asset: &Pubkey, remaining: &[AccountInfo]) -> Result<()> {
    let info = remaining.first().ok_or(TesoroError::BadRemainingAccounts)?;
    require_keys_eq!(
        *info.key,
        Pubkey::find_program_address(&[ONCHAIN_PRICE_SEED, asset.as_ref()], &crate::ID).0,
        TesoroError::InvalidAccount
    );
    require!(
        *info.owner != crate::ID || info.data_is_empty(),
        TesoroError::OnchainPriceRequired
    );
    Ok(())
}

/// An Advance against a native Position, priced from its asset's Pyth feed: the owner signs alone.
/// When the Position still has its previous Advance open, that Source, its book and its pages are
/// the remaining accounts.
#[derive(Accounts)]
pub struct TakeNativeAdvanceOnchain<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// CHECK: the owner's Protections address; a Self-Excluded owner takes no Advance.
    #[account(
        seeds = [PROTECTIONS_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized,
        constraint = is_native(&position.inner) @ TesoroError::NotNativePosition
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [ONCHAIN_PRICE_SEED, position.inner.source_asset.as_ref()],
        bump = onchain_price.bump
    )]
    pub onchain_price: Account<'info, OnchainPrice>,
    /// CHECK: address, owner, layout and feed id are checked against `onchain_price` on read.
    #[account(address = onchain_price.feed @ TesoroError::BadPriceFeed)]
    pub price_feed: UncheckedAccount<'info>,
    /// The canonical sim_lst Pool, whose speedup times the yield.
    #[account(
        seeds = [sim_lst::POOL_SEED],
        seeds::program = sim_lst::ID,
        bump = pool.bump,
        constraint = pool.mint == SIM_SOL_MINT @ TesoroError::InvalidPool
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = owner_authority,
        space = SourceState::SPACE,
        seeds = [SOURCE_SEED, position.key().as_ref(), &position.inner.advances.to_le_bytes()],
        bump
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        init,
        payer = owner_authority,
        space = SOURCE_BOOK_LEN,
        seeds = [BOOK_SEED, source.key().as_ref()],
        bump
    )]
    pub book: AccountLoader<'info, SourceBookHead>,
    /// CHECK: the owner's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, owner_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the owner's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, owner_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn take_native_advance_onchain<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, TakeNativeAdvanceOnchain<'info>>,
    horizon_months: u8,
    min_gemas: u64,
) -> Result<()> {
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let remaining = ctx.remaining_accounts;
    let (source_bump, book_bump) = (ctx.bumps.source, ctx.bumps.book);
    let a = &mut ctx.accounts;
    let ts = now()?;
    let price = a.onchain_price.read(&a.price_feed.to_account_info(), ts)?;
    let rates = native_rates(&a.position.inner, &a.pool)?;
    let fee = a.position.inner.yield_fee_bps;
    let (basket, spill) = (a.basket.to_account_info(), a.spill.to_account_info());
    begin_advance(
        NewAdvance {
            position: &mut a.position,
            source: &mut a.source,
            source_bump,
            book: &a.book,
            book_bump,
            basket: &basket,
            spill: &spill,
        },
        &rates,
        remaining,
        horizon_months,
        price,
        fee,
        min_gemas,
    )
}

/// An Advance against an EVM-sourced Position, priced from its asset's Pyth feed. The oracle
/// authority and the owner sign as for `take_advance`, but the oracle no longer chooses the price.
/// When the Position still has its previous Advance open, that Source, its book and its pages are
/// the remaining accounts.
#[derive(Accounts)]
pub struct TakeAdvanceOnchain<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// Its Yield Fee sizes the Advance.
    #[account(seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    /// CHECK: the owner's Protections address; a Self-Excluded owner takes no Advance.
    #[account(
        seeds = [PROTECTIONS_SEED, owner_account.key().as_ref()],
        bump
    )]
    pub protections: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        seeds = [ONCHAIN_PRICE_SEED, position.inner.source_asset.as_ref()],
        bump = onchain_price.bump
    )]
    pub onchain_price: Account<'info, OnchainPrice>,
    /// CHECK: address, owner, layout and feed id are checked against `onchain_price` on read.
    #[account(address = onchain_price.feed @ TesoroError::BadPriceFeed)]
    pub price_feed: UncheckedAccount<'info>,
    #[account(
        init,
        payer = oracle,
        space = SourceState::SPACE,
        seeds = [SOURCE_SEED, position.key().as_ref(), &position.inner.advances.to_le_bytes()],
        bump
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        init,
        payer = oracle,
        space = SOURCE_BOOK_LEN,
        seeds = [BOOK_SEED, source.key().as_ref()],
        bump
    )]
    pub book: AccountLoader<'info, SourceBookHead>,
    /// CHECK: the owner's basket, checked by its seeds.
    #[account(mut, seeds = [BASKET_SEED, owner_account.key().as_ref()], bump)]
    pub basket: UncheckedAccount<'info>,
    /// CHECK: the owner's spill, checked by its seeds.
    #[account(mut, seeds = [SPILL_SEED, owner_account.key().as_ref()], bump)]
    pub spill: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn take_advance_onchain<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, TakeAdvanceOnchain<'info>>,
    horizon_months: u8,
    min_gemas: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let (source_bump, book_bump) = (ctx.bumps.source, ctx.bumps.book);
    let a = &mut ctx.accounts;
    // A native or stake Position is advanced by the owner alone through its own instruction.
    require!(
        !is_native(&a.position.inner) && !is_stake(&a.position.inner),
        TesoroError::NativePosition
    );
    require_can_advance(&a.protections.to_account_info())?;
    let price = a
        .onchain_price
        .read(&a.price_feed.to_account_info(), now()?)?;
    let rates = reported_rates(&a.position.inner);
    let fee = a.treasury.yield_fee_bps;
    let (basket, spill) = (a.basket.to_account_info(), a.spill.to_account_info());
    begin_advance(
        NewAdvance {
            position: &mut a.position,
            source: &mut a.source,
            source_bump,
            book: &a.book,
            book_bump,
            basket: &basket,
            spill: &spill,
        },
        &rates,
        remaining,
        horizon_months,
        price,
        fee,
        min_gemas,
    )
}
