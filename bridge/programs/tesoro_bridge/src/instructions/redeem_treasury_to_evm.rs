use crate::*;
use tesoro_core::{
    cpi::accounts::RedeemTreasuryFromSource,
    ledger::SourceChain,
    program::TesoroCore,
    state::{
        HoldingState, PositionState, SourceAuthority, SourceState, TesoroAccount, Treasury,
        ACCOUNT_SEED, HOLDING_SEED, POSITION_SEED as CORE_POSITION_SEED, SOURCE_AUTHORITY_SEED,
        SOURCE_SEED, TREASURY_SEED as CORE_TREASURY_SEED,
    },
};

// The Treasury Account redeems Gemas of an ETH- or HyperEVM-Sourced Advance it bought by Instant
// Redeem, at full value and by the normal Redeem rules, and the payout is recorded in a `Claim`
// like any holder's. `send_pay_yield` then pays it to the vault itself, which books it into its
// treasury. Permissionless: nobody can sign for the Treasury Account and the destination is fixed.
#[derive(Accounts)]
pub struct RedeemTreasuryToEvm<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(core_position.inner.source_chain)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Box<Account<'info, SourceAuthority>>,
    #[account(
        seeds = [CORE_TREASURY_SEED],
        bump = core_treasury.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury: Box<Account<'info, Treasury>>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, core_treasury.key().as_ref()],
        bump = core_treasury_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        seeds = [CORE_POSITION_SEED, &[chain_byte(core_position.inner.source_chain)], core_position.position_id.as_ref()],
        bump = core_position.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_position: Box<Account<'info, PositionState>>,
    #[account(
        mut,
        seeds = [SOURCE_SEED, core_position.key().as_ref(), &core_source.inner.index.to_le_bytes()],
        bump = core_source.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source: Box<Account<'info, SourceState>>,
    #[account(
        mut,
        seeds = [HOLDING_SEED, core_treasury_account.key().as_ref(), core_source.key().as_ref()],
        bump = core_treasury_holding.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury_holding: Box<Account<'info, HoldingState>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Claim::INIT_SPACE,
        seeds = [CLAIM_SEED, core_treasury_account.key().as_ref(), core_source.key().as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, Claim>>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl RedeemTreasuryToEvm<'_> {
    pub fn apply(ctx: &mut Context<RedeemTreasuryToEvm>, gemas: u64) -> Result<()> {
        require!(
            ctx.accounts.core_position.inner.source_chain != SourceChain::Solana,
            BridgeError::NotBridgedPosition
        );
        let units_before = ctx.accounts.core_source.inner.redeemed_units;
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        tesoro_core::cpi::redeem_treasury_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                RedeemTreasuryFromSource {
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    treasury: ctx.accounts.core_treasury.to_account_info(),
                    treasury_account: ctx.accounts.core_treasury_account.to_account_info(),
                    position: ctx.accounts.core_position.to_account_info(),
                    source: ctx.accounts.core_source.to_account_info(),
                    treasury_holding: ctx.accounts.core_treasury_holding.to_account_info(),
                },
                signer_seeds,
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
            claim.holder_account = ctx.accounts.core_treasury_account.key();
            claim.source = ctx.accounts.core_source.key();
            claim.position = ctx.accounts.core_position.key();
            claim.bump = ctx.bumps.claim;
        }
        claim.gemas_total =
            claim.gemas_total.checked_add(gemas).ok_or(BridgeError::AmountOverflow)?;
        claim.units_total =
            claim.units_total.checked_add(units).ok_or(BridgeError::AmountOverflow)?;
        Ok(())
    }
}
