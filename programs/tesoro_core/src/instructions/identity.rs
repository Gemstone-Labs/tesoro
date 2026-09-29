use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CreateAccount<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = TesoroAccount::SPACE,
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump
    )]
    pub account: Account<'info, TesoroAccount>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn create_account(ctx: Context<CreateAccount>, evm_address: [u8; 20]) -> Result<()> {
    let account = &mut ctx.accounts.account;
    account.bump = ctx.bumps.account;
    account.authority = ctx.accounts.authority.key();
    account.evm_address = evm_address;
    account.inner = Default::default();
    Ok(())
}

#[derive(Accounts)]
pub struct SetEvmAddress<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
}

pub(crate) fn set_evm_address(ctx: Context<SetEvmAddress>, evm_address: [u8; 20]) -> Result<()> {
    ctx.accounts.account.evm_address = evm_address;
    Ok(())
}

/// Anyone may create the Holding an Account needs to receive Gemas of a Source (payouts never
/// depend on the recipient being online). Own-sourced iff the Source belongs to the Account.
#[derive(Accounts)]
pub struct OpenHolding<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, account.authority.as_ref()],
        bump = account.bump
    )]
    pub account: Account<'info, TesoroAccount>,
    #[account(
        seeds = [SOURCE_SEED, source.inner.position.as_ref(), &source.inner.index.to_le_bytes()],
        bump = source.bump
    )]
    pub source: Account<'info, SourceState>,
    #[account(
        init,
        payer = payer,
        space = HoldingState::SPACE,
        seeds = [HOLDING_SEED, account.key().as_ref(), source.key().as_ref()],
        bump
    )]
    pub holding: Account<'info, HoldingState>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn open_holding(ctx: Context<OpenHolding>) -> Result<()> {
    let source_key = ctx.accounts.source.key();
    let account_key = ctx.accounts.account.key();
    let holding = &mut ctx.accounts.holding;
    holding.bump = ctx.bumps.holding;
    holding.account = account_key;
    holding.inner = crate::ledger::Holding::new(
        source_key.to_bytes(),
        ctx.accounts.source.inner.owner == account_key.to_bytes(),
    );
    Ok(())
}
