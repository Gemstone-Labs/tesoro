use crate::*;
use tesoro_core::{
    cpi::accounts::ApplyYieldFromSource,
    program::TesoroCore,
    state::{
        PositionState, SourceAuthority, SourceState, POSITION_SEED as CORE_POSITION_SEED,
        SOURCE_AUTHORITY_SEED, SOURCE_SEED,
    },
};

// Applies the latest received `YieldAccrued` to tesoro_core: repays Debt automatically and
// makes that much of the Source redeemable, and takes the Treasury balance it carried into the mirror.
// Permissionless; tesoro_core is idempotent by seq.
#[derive(Accounts)]
#[instruction(params: PositionRef)]
pub struct ApplyYield<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// The vault's terms: its decimals give the wei -> core unit scale.
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes(), &vault_of(&params.position_id)],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, &params.eid.to_be_bytes(), &params.position_id],
        bump = bridge_position.bump
    )]
    pub bridge_position: Account<'info, BridgePosition>,
    /// Takes the Treasury balance and Instant payouts this yield report carried.
    #[account(
        mut,
        seeds = [TREASURY_SEED, &params.eid.to_be_bytes(), &vault_of(&params.position_id)],
        bump = vault_treasury.bump
    )]
    pub vault_treasury: Account<'info, VaultTreasury>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[core_chain_byte(params.eid).unwrap_or(u8::MAX)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Account<'info, SourceAuthority>,
    #[account(
        mut,
        seeds = [CORE_POSITION_SEED, &[core_chain_byte(params.eid).unwrap_or(u8::MAX)], &params.position_id],
        bump = core_position.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_position: Account<'info, PositionState>,
    /// The Position's open Advance, when it has one.
    #[account(
        mut,
        seeds = [SOURCE_SEED, core_position.key().as_ref(), &core_source.inner.index.to_le_bytes()],
        bump = core_source.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source: Option<Account<'info, SourceState>>,
    pub core_program: Program<'info, TesoroCore>,
}

impl ApplyYield<'_> {
    pub fn apply<'info>(
        ctx: &mut Context<'_, '_, '_, 'info, ApplyYield<'info>>,
        _params: &PositionRef,
    ) -> Result<()> {
        let position = &mut ctx.accounts.bridge_position;
        require!(position.opened, BridgeError::NotOpened);
        require!(position.last_yield_seq > position.applied_yield_seq, BridgeError::NothingToApply);
        // A Position opened before units were normalised holds wei: it is retired, never paid.
        require!(ctx.accounts.core_position.inner.decimals == ctx.accounts.peer.core_decimals(), BridgeError::LegacyUnits);
        // The vault reports wei; core holds 9-decimal units, rounded down (never above what accrued).
        let cumulative = ctx.accounts.peer.to_core_u64(position.yield_cumulative)?;

        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        // The Source's book and checkpoint pages are the remaining accounts: core lands the yield.
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.core_program.to_account_info(),
            ApplyYieldFromSource {
                source_signer: ctx.accounts.authority.to_account_info(),
                source_authority: ctx.accounts.core_source_authority.to_account_info(),
                position: ctx.accounts.core_position.to_account_info(),
                source: ctx.accounts.core_source.as_ref().map(|s| s.to_account_info()),
            },
            signer_seeds,
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());
        tesoro_core::cpi::apply_yield_from_source(cpi, position.last_yield_seq, cumulative)?;
        position.applied_yield_seq = position.last_yield_seq;
        ctx.accounts.vault_treasury.apply_report(
            position.treasury_balance,
            position.instant_paid,
            position.report_time,
        );
        Ok(())
    }
}
