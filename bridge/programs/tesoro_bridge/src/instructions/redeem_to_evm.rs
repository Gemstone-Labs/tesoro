use crate::*;
use tesoro_core::{
    cpi::accounts::Redeem,
    ledger::SourceChain,
    program::TesoroCore,
    state::{
        HoldingState, PositionState, SourceState, TesoroAccount, ACCOUNT_SEED, HOLDING_SEED,
        POSITION_SEED as CORE_POSITION_SEED, SOURCE_SEED,
    },
};

// Redeems Gemas of an ETH- or HyperEVM-Sourced Advance through tesoro_core (`redeem`, signed by
// the holder) and records the payout owed on the source chain in a `Claim`. `send_pay_yield`
// then delivers it. Redeeming these Gemas with tesoro_core's plain `redeem` would burn the claim
// without recording a payout, so the app must route non-Solana Sources through here.
#[derive(Accounts)]
pub struct RedeemToEvm<'info> {
    #[account(mut)]
    pub holder_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub holder_account: Account<'info, TesoroAccount>,
    #[account(
        seeds = [CORE_POSITION_SEED, &[chain_byte(core_position.inner.source_chain)], core_position.position_id.as_ref()],
        bump = core_position.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_position: Account<'info, PositionState>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, core_position.key().as_ref(), &core_source.inner.index.to_le_bytes()],
        bump = core_source.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source: Account<'info, SourceState>,
    #[account(
        mut,
        seeds = [HOLDING_SEED, holder_account.key().as_ref(), core_source.key().as_ref()],
        bump = core_holding.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_holding: Account<'info, HoldingState>,
    #[account(
        init_if_needed,
        payer = holder_authority,
        space = 8 + Claim::INIT_SPACE,
        seeds = [CLAIM_SEED, holder_account.key().as_ref(), core_source.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, Claim>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl RedeemToEvm<'_> {
    pub fn apply(ctx: &mut Context<RedeemToEvm>, gemas: u64) -> Result<()> {
        require!(ctx.accounts.holder_account.evm_address != [0u8; 20], BridgeError::NoEvmAddress);
        require!(
            ctx.accounts.core_position.inner.source_chain != SourceChain::Solana,
            BridgeError::NotBridgedPosition
        );
        let units_before = ctx.accounts.core_source.inner.redeemed_units;

        tesoro_core::cpi::redeem(
            CpiContext::new(
                ctx.accounts.core_program.to_account_info(),
                Redeem {
                    holder_authority: ctx.accounts.holder_authority.to_account_info(),
                    holder_account: ctx.accounts.holder_account.to_account_info(),
                    position: ctx.accounts.core_position.to_account_info(),
                    source: ctx.accounts.core_source.to_account_info(),
                    holding: ctx.accounts.core_holding.to_account_info(),
                },
            ),
            gemas,
        )?;
        ctx.accounts.core_source.reload()?;
        let units = ctx
            .accounts
            .core_source
            .inner
            .redeemed_units
            .checked_sub(units_before)
            .ok_or(BridgeError::AmountOverflow)?;

        let claim = &mut ctx.accounts.claim;
        if claim.holder_account == Pubkey::default() {
            claim.holder_account = ctx.accounts.holder_account.key();
            claim.source = ctx.accounts.core_source.key();
            claim.position = ctx.accounts.core_position.key();
            claim.bump = ctx.bumps.claim;
        }
        claim.gemas_total = claim.gemas_total.checked_add(gemas).ok_or(BridgeError::AmountOverflow)?;
        claim.units_total = claim.units_total.checked_add(units).ok_or(BridgeError::AmountOverflow)?;
        Ok(())
    }
}

pub fn chain_byte(chain: SourceChain) -> u8 {
    match chain {
        SourceChain::Solana => 0,
        SourceChain::Ethereum => 1,
        SourceChain::HyperEvm => 2,
    }
}
