//! Mainnet Advance pricing (ADR 0011). An Advance converts a Position's yield, in the units of its
//! Principal (SOL base units for a staking-token Position, since Principal is recorded at the
//! pool's rate; wei or the like for an EVM Position), to Gemas at $0.01 with the USD price of one
//! whole unit. On mainnet that price is read from a Pyth sponsored push feed account, mapped per
//! asset by the admin in an `OnchainPrice`. The keeper's price job and the oracle-supplied price of
//! `take_advance` serve test mode only: `take_advance` refuses an asset once it has a mapping.

use crate::error::{core_err, TesoroError};
use crate::instructions::native::is_native;
use crate::instructions::position::{chain_byte, issue_advance};
use crate::ledger::native;
use crate::pyth::{
    MAX_ONCHAIN_CONF_BPS, MAX_ONCHAIN_PRICE_AGE_SECS, PRICE_UPDATE_V2, PYTH_RECEIVER,
};
use crate::state::*;
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
#[derive(Accounts)]
pub struct TakeNativeAdvanceOnchain<'info> {
    #[account(mut)]
    pub owner_authority: Signer<'info>,
    #[account(
        mut,
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
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &prev_source.inner.index.to_le_bytes()],
        bump = prev_source.bump,
        constraint = prev_source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub prev_source: Option<Account<'info, SourceState>>,
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
        space = HoldingState::SPACE,
        seeds = [HOLDING_SEED, owner_account.key().as_ref(), source.key().as_ref()],
        bump
    )]
    pub holding: Account<'info, HoldingState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn take_native_advance_onchain(
    mut ctx: Context<TakeNativeAdvanceOnchain>,
    horizon_months: u8,
) -> Result<()> {
    let a = &mut ctx.accounts;
    require_can_advance(&a.protections.to_account_info())?;
    let ts = now()?;
    let price = a.onchain_price.read(&a.price_feed.to_account_info(), ts)?;
    let net = native::position_accrued(&a.position.inner, a.pool.speedup, ts).map_err(core_err)?;
    let fee = a.position.inner.yield_fee_bps;
    if a.position.inner.open_advance.is_some() && a.prev_source.is_none() {
        return err!(TesoroError::SourceRequired);
    }
    native::prepare_advance(
        &mut a.position.inner,
        a.prev_source.as_mut().map(|s| &mut s.inner),
        net.net,
    )
    .map_err(core_err)?;
    issue_advance(
        &mut a.position,
        &mut a.source,
        &mut a.holding,
        &mut a.owner_account,
        ctx.bumps.source,
        ctx.bumps.holding,
        horizon_months,
        price,
        fee,
    )
}

/// An Advance against an EVM-sourced Position, priced from its asset's Pyth feed. The oracle
/// authority and the owner sign as for `take_advance`, but the oracle no longer chooses the price.
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
        mut,
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
        space = HoldingState::SPACE,
        seeds = [HOLDING_SEED, owner_account.key().as_ref(), source.key().as_ref()],
        bump
    )]
    pub holding: Account<'info, HoldingState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn take_advance_onchain(
    ctx: Context<TakeAdvanceOnchain>,
    horizon_months: u8,
) -> Result<()> {
    let a = ctx.accounts;
    // A native Position is advanced by the owner alone through `take_native_advance_onchain`.
    require!(!is_native(&a.position.inner), TesoroError::NativePosition);
    require_can_advance(&a.protections.to_account_info())?;
    let price = a
        .onchain_price
        .read(&a.price_feed.to_account_info(), now()?)?;
    issue_advance(
        &mut a.position,
        &mut a.source,
        &mut a.holding,
        &mut a.owner_account,
        ctx.bumps.source,
        ctx.bumps.holding,
        horizon_months,
        price,
        a.treasury.yield_fee_bps,
    )
}
