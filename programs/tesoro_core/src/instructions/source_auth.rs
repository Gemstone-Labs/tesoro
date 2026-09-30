//! Source authorities: an admin-registered signer per source chain that may report the
//! `PositionLocked` and `YieldAccrued` facts for Positions of that chain, alongside the single
//! `Config.oracle_authority`. The cross-chain bridge program signs as a PDA. The existing
//! oracle-signed instructions are unchanged; these are their source-authority twins.

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

#[derive(Accounts)]
#[instruction(chain: SourceChain)]
pub struct SetSourceAuthority<'info> {
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
        space = SourceAuthority::SPACE,
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(chain)]],
        bump
    )]
    pub source_authority: Account<'info, SourceAuthority>,
    pub system_program: Program<'info, System>,
}

/// Registers (or replaces) the signer authorised to report Positions of `chain`.
pub(crate) fn set_source_authority(
    ctx: Context<SetSourceAuthority>,
    chain: SourceChain,
    authority: Pubkey,
) -> Result<()> {
    require!(chain != SourceChain::Solana, TesoroError::InvalidAccount);
    let entry = &mut ctx.accounts.source_authority;
    entry.bump = ctx.bumps.source_authority;
    entry.chain = chain;
    entry.authority = authority;
    Ok(())
}

#[derive(Accounts)]
#[instruction(chain: SourceChain)]
pub struct RemoveSourceAuthority<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TesoroError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        close = admin,
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(chain)]],
        bump = source_authority.bump
    )]
    pub source_authority: Account<'info, SourceAuthority>,
}

pub(crate) fn remove_source_authority(
    _ctx: Context<RemoveSourceAuthority>,
    _chain: SourceChain,
) -> Result<()> {
    Ok(())
}

/// `PositionLocked` reported by the registered authority of `source_chain`.
#[derive(Accounts)]
#[instruction(source_chain: SourceChain, position_id: [u8; 32])]
pub struct OpenPositionFromSource<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(source_chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == source_chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Account<'info, SourceAuthority>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_account.authority.as_ref()],
        bump = owner_account.bump
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        init,
        payer = payer,
        space = PositionState::SPACE,
        seeds = [POSITION_SEED, &[chain_byte(source_chain)], position_id.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionState>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn open_position_from_source(
    ctx: Context<OpenPositionFromSource>,
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

/// `YieldAccrued(seq, cumulative)` reported by the registered authority of the Position's chain.
/// Idempotent by `seq`, like `apply_yield`.
#[derive(Accounts)]
pub struct ApplyYieldFromSource<'info> {
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(position.inner.source_chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == position.inner.source_chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Account<'info, SourceAuthority>,
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

pub(crate) fn apply_yield_from_source(
    ctx: Context<ApplyYieldFromSource>,
    seq: u64,
    cumulative: u64,
) -> Result<()> {
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

/// `redeem` for Gemas of an EVM-sourced Advance, signed by the holder and by the registered source
/// authority of the Position's chain (the bridge), which records the payout owed on that chain in
/// the same transaction. Plain `redeem` refuses these Sources.
#[derive(Accounts)]
pub struct RedeemFromSource<'info> {
    pub holder_authority: Signer<'info>,
    pub source_signer: Signer<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(position.inner.source_chain)]],
        bump = source_authority.bump,
        constraint = source_authority.chain == position.inner.source_chain
            && source_authority.authority == source_signer.key() @ TesoroError::Unauthorized
    )]
    pub source_authority: Account<'info, SourceAuthority>,
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

pub(crate) fn redeem_from_source(ctx: Context<RedeemFromSource>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
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
