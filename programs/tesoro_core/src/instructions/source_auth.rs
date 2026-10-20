//! Source authorities: an admin-registered signer per source chain that may report the
//! `PositionLocked` and `YieldAccrued` facts for Positions of that chain, alongside the single
//! `Config.oracle_authority`. The cross-chain bridge program signs as a PDA. The existing
//! oracle-signed instructions are unchanged; these are their source-authority twins.

use crate::books::OnchainBooks;
use crate::error::{core_err, TesoroError};
use crate::instructions::economy::*;
use crate::instructions::position::apply_reported_yield;
use crate::ledger::{self, SourceChain};
use crate::state::*;
use crate::storage::*;
use anchor_lang::prelude::*;

fn chain_byte(chain: SourceChain) -> u8 {
    crate::instructions::position::chain_byte(chain)
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

pub(crate) fn apply_yield_from_source<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, ApplyYieldFromSource<'info>>,
    seq: u64,
    cumulative: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = &mut ctx.accounts;
    apply_reported_yield(
        &mut a.position,
        a.source.as_mut(),
        remaining,
        seq,
        cumulative,
    )
}

/// `redeem` for Gemas of an EVM-sourced Advance, signed by the holder and by the registered source
/// authority of the Position's chain (the bridge), which records the payout owed on that chain in
/// the same transaction (it reads `Source::redeemed_units`, the units the shares paid are worth:
/// for these Sources a share is one unit). Plain `redeem` refuses these Sources. Remaining
/// accounts: the Source's book and checkpoint pages.
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
    #[account(
        mut,
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
}

pub(crate) fn redeem_from_source<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemFromSource<'info>>,
    line: LineRef,
    amount: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mut kind = KindCtx::Reported;
    let mut books = OnchainBooks::load(remaining)?;
    let source_key = a.source.key();
    let key = line.key(&source_key);
    let out = with_pool(
        &a.basket.to_account_info(),
        &a.spill.to_account_info(),
        |pool| {
            redeem_line(
                pool,
                &mut books,
                &mut kind,
                &mut a.position,
                &mut a.source,
                &source_key,
                &key,
                amount,
            )
        },
    )?;
    require!(out.shares > 0, TesoroError::InvalidAccount);
    books.flush()?;
    emit!(Redeemed {
        position: a.position.key(),
        source: source_key,
        account: a.holder_account.key(),
        gemas: out.gemas,
        source_units: out.units,
    });
    Ok(())
}
