use crate::error::{core_err, TesoroError};
use crate::ledger::{self, SourceChain};
use crate::state::*;
use anchor_lang::prelude::*;

fn chain_byte(chain: SourceChain) -> u8 {
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
/// issuance (the Pyth seam). Both sign.
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
    let position_key = ctx.accounts.position.key();
    let source_key = ctx.accounts.source.key();
    let source = ctx
        .accounts
        .position
        .inner
        .open_advance(position_key.to_bytes(), horizon_months, price_micro_usd)
        .map_err(core_err)?;
    let gemas = source.issued;
    let owner_key = ctx.accounts.owner_account.key();
    let holding = &mut ctx.accounts.holding;
    holding.bump = ctx.bumps.holding;
    holding.account = owner_key;
    holding.inner = ledger::Holding::new(source_key.to_bytes(), true);
    holding
        .inner
        .credit(&mut ctx.accounts.owner_account.inner, gemas)
        .map_err(core_err)?;
    ctx.accounts.source.bump = ctx.bumps.source;
    ctx.accounts.source.inner = source;
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

pub(crate) fn return_own(mut ctx: Context<ReturnOwn>, amount: u64) -> Result<()> {
    let a = &mut ctx.accounts;
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

pub(crate) fn redeem(mut ctx: Context<Redeem>, amount: u64) -> Result<()> {
    let a = &mut ctx.accounts;
    let units = ledger::redeem(
        &mut a.source.inner,
        &mut a.holder_account.inner,
        &mut a.holding.inner,
        amount,
    )
    .map_err(core_err)?;
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

pub(crate) fn unlock(ctx: Context<Unlock>) -> Result<()> {
    ctx.accounts.position.inner.unlock().map_err(core_err)?;
    emit!(PositionUnlocked {
        position: ctx.accounts.position.key(),
    });
    Ok(())
}
