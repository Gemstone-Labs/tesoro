use crate::*;
use tesoro_core::{
    cpi::accounts::CashInFeeFromSource,
    ledger::SourceChain,
    program::TesoroCore,
    state::{
        Config, EconomyConfig, PositionState, SourceAuthority, SourceState, TesoroAccount,
        CONFIG_SEED, ECONOMY_SEED, POSITION_SEED as CORE_POSITION_SEED, SOURCE_AUTHORITY_SEED,
        SOURCE_SEED,
    },
};

// Adds one Source's covered fee counter to an open batch. Core debits the counter
// (`cash_in_fee_from_source`, signed by this program's authority PDA) and adds the units to the
// Source's redeemed units; the entry records exactly that delta, so the units are owed by the
// vault from this transaction on and enter exactly one batch. Permissionless. Remaining accounts:
// the Source's book and checkpoint pages.
#[derive(Accounts)]
pub struct AddToBatch<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [BATCH_SEED, &batch.eid.to_be_bytes(), &batch.peer_address, &batch.id.to_be_bytes()],
        bump = batch.bump
    )]
    pub batch: Box<Account<'info, Batch>>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(core_position.inner.source_chain)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Box<Account<'info, SourceAuthority>>,
    #[account(seeds = [CONFIG_SEED], bump = core_config.bump, seeds::program = tesoro_core::ID)]
    pub core_config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = core_economy.bump, seeds::program = tesoro_core::ID)]
    pub core_economy: Box<Account<'info, EconomyConfig>>,
    /// The Platform, Studio or Pool Account the batch's kind pays; core checks it against its
    /// settings.
    pub recipient_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        mut,
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
    pub core_program: Program<'info, TesoroCore>,
}

impl AddToBatch<'_> {
    pub fn apply<'info>(ctx: &mut Context<'_, '_, '_, 'info, AddToBatch<'info>>) -> Result<()> {
        let batch = &ctx.accounts.batch;
        require!(batch.state == BATCH_OPEN, BridgeError::BatchNotOpen);
        let position = &ctx.accounts.core_position;
        // The Position must live in this batch's vault.
        require!(
            position.inner.source_chain == core_chain(batch.eid)?
                && position.inner.source_chain != SourceChain::Solana
                && vault_of(&position.position_id) == batch.peer_address,
            BridgeError::WrongRoute
        );
        let units_before = ctx.accounts.core_source.inner.redeemed_units;
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        tesoro_core::cpi::cash_in_fee_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                CashInFeeFromSource {
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    config: ctx.accounts.core_config.to_account_info(),
                    economy: ctx.accounts.core_economy.to_account_info(),
                    recipient_account: ctx.accounts.recipient_account.to_account_info(),
                    position: ctx.accounts.core_position.to_account_info(),
                    source: ctx.accounts.core_source.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            ctx.accounts.batch.kind,
            1,
        )?;
        ctx.accounts.core_source.reload()?;
        let units = ctx
            .accounts
            .core_source
            .inner
            .redeemed_units
            .checked_sub(units_before)
            .ok_or(BridgeError::AmountOverflow)?;
        let recipient = if ctx.accounts.batch.is_fee() {
            ctx.accounts.recipient_account.evm_address
        } else {
            [0u8; 20]
        };
        let mut id = [0u8; 8];
        id.copy_from_slice(&ctx.accounts.core_position.position_id[20..28]);
        let entry = BatchEntry {
            vault_position_id: u64::from_be_bytes(id),
            source: ctx.accounts.core_source.key(),
            units,
            paid: 0,
        };
        ctx.accounts.batch.add(entry, recipient)
    }
}
