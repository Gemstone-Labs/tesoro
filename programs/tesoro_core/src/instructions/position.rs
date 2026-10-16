use crate::error::{core_err, TesoroError};
use crate::instructions::native::is_stake;
use crate::instructions::native::{
    is_native, redeem_native, return_own_native_source, unlock_native_position,
};
use crate::instructions::stake::{
    is_computed, redeem_stake, return_own_stake_source, unlock_stake_position,
};
use crate::ledger::{self, SourceChain};
use crate::state::*;
use crate::util::require_can_advance;
use anchor_lang::prelude::*;

pub(crate) fn chain_byte(chain: SourceChain) -> u8 {
    match chain {
        SourceChain::Solana => 0,
        SourceChain::Ethereum => 1,
        SourceChain::HyperEvm => 2,
    }
}

/// `PositionLocked`: the oracle authority (later the LayerZero receiver) reports that a Position
/// was opened on its source chain. Solana-native Positions use the same instruction.
#[derive(Accounts)]
#[instruction(source_chain: SourceChain, position_id: [u8; 32])]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_account.authority.as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        init,
        payer = oracle,
        space = PositionState::SPACE,
        seeds = [POSITION_SEED, &[chain_byte(source_chain)], position_id.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionState>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn open_position(
    ctx: Context<OpenPosition>,
    source_chain: SourceChain,
    position_id: [u8; 32],
    source_asset: Pubkey,
    decimals: u8,
    principal: u64,
    rate_bps: u16,
) -> Result<()> {
    require!(!ctx.accounts.config.oracle_locked, TesoroError::OracleLocked);
    require!(
        !(source_chain == SourceChain::Solana && source_asset == SIM_SOL_MINT),
        TesoroError::NativePosition
    );
    let position = &mut ctx.accounts.position;
    position.bump = ctx.bumps.position;
    position.position_id = position_id;
    position.inner = ledger::Position::new(
        ctx.accounts.owner_account.key().to_bytes(),
        source_chain,
        source_asset.to_bytes(),
        decimals,
        principal,
        rate_bps,
    )
    .map_err(core_err)?;
    Ok(())
}

/// An Advance: the owner picks the Horizon, the oracle authority supplies the USD price at
/// issuance (test mode only: an asset with an `OnchainPrice` is advanced by `take_advance_onchain`
/// and this refuses it; the asset's `OnchainPrice` address is the first remaining account). Both sign.
#[derive(Accounts)]
pub struct TakeAdvance<'info> {
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

pub(crate) fn take_advance(
    ctx: Context<TakeAdvance>,
    horizon_months: u8,
    price_micro_usd: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.oracle_locked, TesoroError::OracleLocked);
    require!(
        !is_computed(&ctx.accounts.position.inner),
        TesoroError::NativePosition
    );
    crate::instructions::onchain_price::require_no_onchain_price(
        &Pubkey::new_from_array(ctx.accounts.position.inner.source_asset),
        ctx.remaining_accounts,
    )?;
    require_can_advance(&ctx.accounts.protections.to_account_info())?;
    let a = ctx.accounts;
    issue_advance(
        &mut a.position,
        &mut a.source,
        &mut a.holding,
        &mut a.owner_account,
        ctx.bumps.source,
        ctx.bumps.holding,
        horizon_months,
        price_micro_usd,
        a.treasury.yield_fee_bps,
    )
}

/// Opens the Position's Advance (net of the Yield Fee) and credits its Gemas to the owner's
/// Holding. Shared by `take_advance` (oracle price) and `take_native_advance` (on-chain price feed).
#[allow(clippy::too_many_arguments)]
pub(crate) fn issue_advance(
    position: &mut Account<PositionState>,
    source: &mut Account<SourceState>,
    holding: &mut Account<HoldingState>,
    owner_account: &mut Account<TesoroAccount>,
    source_bump: u8,
    holding_bump: u8,
    horizon_months: u8,
    price_micro_usd: u64,
    yield_fee_bps: u16,
) -> Result<()> {
    let position_key = position.key();
    let source_key = source.key();
    let issued = position
        .inner
        .open_advance(
            position_key.to_bytes(),
            horizon_months,
            price_micro_usd,
            yield_fee_bps,
        )
        .map_err(core_err)?;
    let gemas = issued.issued;
    let owner_key = owner_account.key();
    holding.bump = holding_bump;
    holding.account = owner_key;
    holding.inner = ledger::Holding::new(source_key.to_bytes(), true);
    holding
        .inner
        .credit(&mut owner_account.inner, gemas)
        .map_err(core_err)?;
    source.bump = source_bump;
    source.inner = issued;
    emit!(AdvanceIssued {
        position: position_key,
        source: source_key,
        gemas,
        horizon_months,
        price_micro_usd,
    });
    Ok(())
}

/// `YieldAccrued(seq, cumulative)`. Idempotent: a replayed or older `seq` changes nothing.
#[derive(Accounts)]
pub struct ApplyYield<'info> {
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Option<Account<'info, SourceState>>,
}

pub(crate) fn apply_yield(ctx: Context<ApplyYield>, seq: u64, cumulative: u64) -> Result<()> {
    require!(!ctx.accounts.config.oracle_locked, TesoroError::OracleLocked);
    require!(
        !is_computed(&ctx.accounts.position.inner),
        TesoroError::NativePosition
    );
    let position_key = ctx.accounts.position.key();
    let source = ctx.accounts.source.as_mut().map(|s| &mut s.inner);
    let applied = ctx
        .accounts
        .position
        .inner
        .apply_yield(source, seq, cumulative)
        .map_err(core_err)?;
    if applied {
        let debt_gemas = ctx.accounts.source.as_ref().map_or(0, |s| s.inner.debt());
        emit!(YieldApplied {
            position: position_key,
            seq,
            cumulative,
            debt_gemas,
        });
    }
    Ok(())
}

/// Return of the owner's own unspent Gemas cancels Debt. Principal is not an input.
#[derive(Accounts)]
pub struct ReturnOwn<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        mut,
        seeds = [HOLDING_SEED, owner_account.key().as_ref(), source.key().as_ref()],
        bump = holding.bump
    )]
    pub holding: Account<'info, HoldingState>,
}

/// For a native Position `remaining_accounts` must be `[pool]`: its Debt is computed from the clock.
pub(crate) fn return_own<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, ReturnOwn<'info>>,
    amount: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = &mut ctx.accounts;
    if is_stake(&a.position.inner) {
        return return_own_stake_source(
            &mut a.position,
            &mut a.source,
            &mut a.owner_account,
            &mut a.holding,
            amount,
            remaining,
        );
    }
    if is_native(&a.position.inner) {
        return return_own_native_source(
            &mut a.position,
            &mut a.source,
            &mut a.owner_account,
            &mut a.holding,
            amount,
            remaining,
        );
    }
    ledger::return_own(
        &mut a.position.inner,
        &mut a.source.inner,
        &mut a.owner_account.inner,
        &mut a.holding.inner,
        amount,
    )
    .map_err(core_err)
}

/// Redeem Gemas for their Source asset, up to the holder's pro rata share of what the Source has
/// accrued. Emits `Redeemed` (the `PayYield` seam); winning Gemas never touch the winner's lock.
#[derive(Accounts)]
pub struct Redeem<'info> {
    pub holder_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump
    )]
    pub holder_account: Account<'info, TesoroAccount>,
    #[account(
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, position.key().as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump,
        constraint = source.inner.position == position.key().to_bytes() @ TesoroError::InvalidAccount
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        mut,
        seeds = [HOLDING_SEED, holder_account.key().as_ref(), source.key().as_ref()],
        bump = holding.bump
    )]
    pub holding: Account<'info, HoldingState>,
}

/// For a native Position `remaining_accounts` must be `[pool, holder_token_account, mint,
/// yield_config, yield_authority, sim_lst_program, token_program]`: the yield the Gemas are worth is
/// computed from the clock and minted to the holder in the same transaction.
pub(crate) fn redeem<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
    amount: u64,
) -> Result<()> {
    // Gemas of an EVM-sourced Advance are paid on their source chain, which only the bridge can
    // record (`redeem_from_source`); burning them here would destroy the claim without a payout.
    require!(
        ctx.accounts.position.inner.source_chain == SourceChain::Solana,
        TesoroError::BridgedSource
    );
    let remaining = ctx.remaining_accounts;
    let a = &mut ctx.accounts;
    let units = if is_stake(&a.position.inner) {
        redeem_stake(
            &a.position,
            &a.position.key(),
            &mut a.source,
            &mut a.holder_account,
            &mut a.holding,
            &a.holder_authority.key(),
            amount,
            remaining,
        )?
    } else if is_native(&a.position.inner) {
        redeem_native(
            &a.position,
            &a.position.key(),
            &mut a.source,
            &mut a.holder_account,
            &mut a.holding,
            &a.holder_authority.key(),
            amount,
            remaining,
        )?
    } else {
        ledger::redeem(
            &mut a.source.inner,
            &mut a.holder_account.inner,
            &mut a.holding.inner,
            amount,
        )
        .map_err(core_err)?
    };
    emit!(Redeemed {
        position: a.position.key(),
        source: a.source.key(),
        account: a.holder_account.key(),
        gemas: amount,
        source_units: units,
    });
    Ok(())
}

/// The owner claims yield accrued beyond any Advance.
#[derive(Accounts)]
pub struct ClaimFreeYield<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
}

pub(crate) fn claim_free_yield(ctx: Context<ClaimFreeYield>, amount: u64) -> Result<()> {
    // A native Position's free yield stays in its vault and returns to the owner with `unlock`.
    require!(
        !is_computed(&ctx.accounts.position.inner),
        TesoroError::NativePosition
    );
    ctx.accounts
        .position
        .inner
        .claim_free_yield(amount)
        .map_err(core_err)?;
    emit!(YieldClaimed {
        position: ctx.accounts.position.key(),
        amount,
    });
    Ok(())
}

/// Debt is zero: release Principal (the `Unlock` message seam).
#[derive(Accounts)]
pub struct Unlock<'info> {
    pub owner_authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_authority.key().as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &[chain_byte(position.inner.source_chain)], position.position_id.as_ref()],
        bump = position.bump,
        constraint = position.inner.owner == owner_account.key().to_bytes() @ TesoroError::Unauthorized
    )]
    pub position: Account<'info, PositionState>,
}

/// For a native Position `remaining_accounts` must be `[custody, vault, pool, owner_token_account,
/// mint, yield_config, yield_authority, sim_lst_program, token_program]`, then
/// the open Advance's Source when it has one: Debt is computed from the clock (it must be zero),
/// Principal returns from the shared vault and the free yield is minted to the owner.
pub(crate) fn unlock<'info>(ctx: Context<'_, '_, 'info, 'info, Unlock<'info>>) -> Result<()> {
    if is_stake(&ctx.accounts.position.inner) {
        unlock_stake_position(
            &mut ctx.accounts.position,
            &ctx.accounts.owner_authority.key(),
            ctx.remaining_accounts,
        )?;
    } else if is_native(&ctx.accounts.position.inner) {
        unlock_native_position(
            &mut ctx.accounts.position,
            &ctx.accounts.owner_authority.key(),
            ctx.remaining_accounts,
        )?;
    } else {
        ctx.accounts.position.inner.unlock().map_err(core_err)?;
    }
    emit!(PositionUnlocked {
        position: ctx.accounts.position.key(),
    });
    Ok(())
}
