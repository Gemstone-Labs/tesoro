use crate::*;
use tesoro_core::{
    cpi::accounts::InstantRedeemFromSource,
    ledger::SourceChain,
    program::TesoroCore,
    state::{
        HoldingState, PositionState, SourceAuthority, SourceState, TesoroAccount, Treasury,
        ACCOUNT_SEED, HOLDING_SEED, POSITION_SEED as CORE_POSITION_SEED, SOURCE_AUTHORITY_SEED,
        SOURCE_SEED, TREASURY_SEED as CORE_TREASURY_SEED,
    },
};

// Instant Redeem of won Gemas of an ETH- or HyperEVM-Sourced Advance: tesoro_core moves them to
// the Treasury Account and returns the payout (their value less the Instant Redeem Fee), signed by
// the holder and by this program's authority PDA. The payout is accepted only if the mirror of the
// vault's treasury still covers it, then recorded in an `InstantClaim`; `send_pay_instant` delivers
// it and the vault pays it from its treasury.
#[derive(Accounts)]
pub struct InstantRedeemToEvm<'info> {
    #[account(mut)]
    pub holder_authority: Signer<'info>,
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
        mut,
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub holder_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        seeds = [CORE_POSITION_SEED, &[chain_byte(core_position.inner.source_chain)], core_position.position_id.as_ref()],
        bump = core_position.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_position: Box<Account<'info, PositionState>>,
    #[account(
        seeds = [SOURCE_SEED, core_position.key().as_ref(), &core_source.inner.index.to_le_bytes()],
        bump = core_source.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source: Box<Account<'info, SourceState>>,
    #[account(
        mut,
        seeds = [HOLDING_SEED, holder_account.key().as_ref(), core_source.key().as_ref()],
        bump = core_holding.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_holding: Box<Account<'info, HoldingState>>,
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
    /// CHECK: the Treasury Account's Holding of the Source; created (if needed) and checked by
    /// tesoro_core against its seeds.
    #[account(
        mut,
        seeds = [HOLDING_SEED, core_treasury_account.key().as_ref(), core_source.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury_holding: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            TREASURY_SEED,
            &eid_of(core_position.inner.source_chain).unwrap_or(0).to_be_bytes(),
            &vault_of(&core_position.position_id)
        ],
        bump = vault_treasury.bump
    )]
    pub vault_treasury: Box<Account<'info, VaultTreasury>>,
    #[account(
        init_if_needed,
        payer = holder_authority,
        space = 8 + InstantClaim::INIT_SPACE,
        seeds = [INSTANT_SEED, holder_account.key().as_ref(), core_source.key().as_ref()],
        bump
    )]
    pub instant_claim: Box<Account<'info, InstantClaim>>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl InstantRedeemToEvm<'_> {
    pub fn apply(ctx: &mut Context<InstantRedeemToEvm>, gemas: u64) -> Result<()> {
        require!(ctx.accounts.holder_account.evm_address != [0u8; 20], BridgeError::NoEvmAddress);
        require!(
            ctx.accounts.core_position.inner.source_chain != SourceChain::Solana,
            BridgeError::NotBridgedPosition
        );
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        let payout = tesoro_core::cpi::instant_redeem_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                InstantRedeemFromSource {
                    holder_authority: ctx.accounts.holder_authority.to_account_info(),
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    holder_account: ctx.accounts.holder_account.to_account_info(),
                    position: ctx.accounts.core_position.to_account_info(),
                    source: ctx.accounts.core_source.to_account_info(),
                    holding: ctx.accounts.core_holding.to_account_info(),
                    treasury: ctx.accounts.core_treasury.to_account_info(),
                    treasury_account: ctx.accounts.core_treasury_account.to_account_info(),
                    treasury_holding: ctx.accounts.core_treasury_holding.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                signer_seeds,
            ),
            gemas,
        )?
        .get();

        // Never accept a payout the vault's treasury may not be able to make.
        let treasury = &mut ctx.accounts.vault_treasury;
        let recorded = treasury
            .instant_recorded
            .checked_add(u128::from(payout))
            .ok_or(BridgeError::AmountOverflow)?;
        require!(recorded <= treasury.reported_in, BridgeError::TreasuryShort);
        treasury.instant_recorded = recorded;

        let claim = &mut ctx.accounts.instant_claim;
        if claim.holder_account == Pubkey::default() {
            claim.holder_account = ctx.accounts.holder_account.key();
            claim.source = ctx.accounts.core_source.key();
            claim.position = ctx.accounts.core_position.key();
            claim.bump = ctx.bumps.instant_claim;
        }
        claim.gemas_total =
            claim.gemas_total.checked_add(gemas).ok_or(BridgeError::AmountOverflow)?;
        claim.units_total =
            claim.units_total.checked_add(payout).ok_or(BridgeError::AmountOverflow)?;
        Ok(())
    }
}
