use crate::*;
use tesoro_core::{
    cpi::accounts::FillInstantRedeemFromSource,
    ledger::SourceChain,
    program::TesoroCore,
    state::{
        InstantOrderState, PositionState, SourceAuthority, SourceState, TesoroAccount, Treasury,
        ACCOUNT_SEED, POSITION_SEED as CORE_POSITION_SEED, SOURCE_AUTHORITY_SEED, SOURCE_SEED,
        TREASURY_SEED as CORE_TREASURY_SEED,
    },
    storage::{BASKET_SEED, SPILL_SEED},
};

// Fills (part of) a seller's Instant Redeem order for an ETH- or HyperEVM-Sourced Advance. Tesoro's
// store admin is the filler: tesoro_core sells the order's Gemas at the Source price less the
// Instant Redeem Fee and returns the payout in the vault's units, signed by this program's
// authority PDA. The vault's spendable figure (`treasury.available()`) is the only budget of the
// fill, so a payout the vault cannot make is refused by tesoro_core. The payout is recorded in an
// `InstantClaim`; `send_pay_instant` delivers it and the vault pays it from its treasury.
#[derive(Accounts)]
pub struct InstantRedeemToEvm<'info> {
    #[account(mut, address = store.admin @ BridgeError::Unauthorized)]
    pub filler: Signer<'info>,
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
        seeds = [tesoro_core::state::INSTANT_ORDER_SEED, core_order.account.as_ref(), &core_order.nonce.to_le_bytes()],
        bump = core_order.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_order: Box<Account<'info, InstantOrderState>>,
    /// CHECK: the seller's wallet; tesoro_core checks it against the order and refunds the
    /// order's rent to it.
    #[account(mut)]
    pub owner_wallet: UncheckedAccount<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, owner_wallet.key().as_ref()],
        bump = holder_account.bump,
        seeds::program = tesoro_core::ID,
        constraint = holder_account.key() == core_order.account @ BridgeError::Unauthorized
    )]
    pub holder_account: Box<Account<'info, TesoroAccount>>,
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
    #[account(
        seeds = [CORE_TREASURY_SEED],
        bump = core_treasury.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury: Box<Account<'info, Treasury>>,
    #[account(
        seeds = [ACCOUNT_SEED, core_treasury.key().as_ref()],
        bump = core_treasury_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury_account: Box<Account<'info, TesoroAccount>>,
    /// CHECK: the Treasury Account's basket; checked by tesoro_core against its seeds.
    #[account(
        mut,
        seeds = [BASKET_SEED, core_treasury_account.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury_basket: UncheckedAccount<'info>,
    /// CHECK: the Treasury Account's spill; checked by tesoro_core against its seeds.
    #[account(
        mut,
        seeds = [SPILL_SEED, core_treasury_account.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_treasury_spill: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            TREASURY_SEED,
            &vault_treasury.eid.to_be_bytes(),
            &vault_of(&core_position.position_id)
        ],
        bump = vault_treasury.bump,
        constraint = core_chain(vault_treasury.eid)? == core_position.inner.source_chain
            @ BridgeError::UnsupportedChain
    )]
    pub vault_treasury: Box<Account<'info, VaultTreasury>>,
    #[account(
        init_if_needed,
        payer = filler,
        space = 8 + InstantClaim::INIT_SPACE,
        seeds = [INSTANT_SEED, holder_account.key().as_ref(), core_source.key().as_ref()],
        bump
    )]
    pub instant_claim: Box<Account<'info, InstantClaim>>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl InstantRedeemToEvm<'_> {
    pub fn apply<'info>(
        ctx: &mut Context<'_, '_, '_, 'info, InstantRedeemToEvm<'info>>,
        gemas: u64,
    ) -> Result<()> {
        require!(ctx.accounts.holder_account.evm_address != [0u8; 20], BridgeError::NoEvmAddress);
        require!(
            ctx.accounts.core_position.inner.source_chain != SourceChain::Solana,
            BridgeError::NotBridgedPosition
        );
        let available = u64::try_from(ctx.accounts.vault_treasury.available()).unwrap_or(u64::MAX);
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        let payout = tesoro_core::cpi::fill_instant_redeem_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                FillInstantRedeemFromSource {
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    treasury: ctx.accounts.core_treasury.to_account_info(),
                    treasury_account: ctx.accounts.core_treasury_account.to_account_info(),
                    treasury_basket: ctx.accounts.core_treasury_basket.to_account_info(),
                    treasury_spill: ctx.accounts.core_treasury_spill.to_account_info(),
                    order: ctx.accounts.core_order.to_account_info(),
                    owner_wallet: ctx.accounts.owner_wallet.to_account_info(),
                    position: ctx.accounts.core_position.to_account_info(),
                    source: ctx.accounts.core_source.to_account_info(),
                },
                signer_seeds,
            )
            // The Source's book and checkpoint pages.
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            gemas,
            available,
        )?
        .get();

        let treasury = &mut ctx.accounts.vault_treasury;
        require!(u128::from(payout) <= treasury.available(), BridgeError::TreasuryShort);
        let recorded = treasury
            .instant_recorded
            .checked_add(u128::from(payout))
            .ok_or(BridgeError::AmountOverflow)?;
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
