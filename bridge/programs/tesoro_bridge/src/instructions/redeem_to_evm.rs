use crate::*;
use tesoro_core::{
    cpi::accounts::RedeemFromSource,
    ledger::SourceChain,
    program::TesoroCore,
    state::{
        PositionState, SourceAuthority, SourceState, TesoroAccount, ACCOUNT_SEED,
        POSITION_SEED as CORE_POSITION_SEED, SOURCE_AUTHORITY_SEED, SOURCE_SEED,
    },
    storage::{BASKET_SEED, SPILL_SEED},
    LineRef,
};

// Redeems Gemas of an ETH- or HyperEVM-Sourced Advance through tesoro_core (`redeem_from_source`,
// signed by the holder and by this program's authority PDA, the registered source authority of the
// chain) and records the payout owed on the source chain in a `Claim`. `send_pay_yield` then
// delivers it. tesoro_core's plain `redeem` refuses these Sources, because it would burn the claim
// without recording a payout.
#[derive(Accounts)]
pub struct RedeemToEvm<'info> {
    /// The holder: signs the Redeem as the Account's authority. Pays and receives nothing, so a holder
    /// with no SOL can redeem.
    pub holder_authority: Signer<'info>,
    /// Pays the rent of the `Claim` the first time this holder redeems this Source: the holder, or a
    /// sponsor on the holder's behalf. It only funds the account; it gains no say over it.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[chain_byte(core_position.inner.source_chain)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Account<'info, SourceAuthority>,
    #[account(
        mut,
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump,
        seeds::program = tesoro_core::ID
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
    /// CHECK: the holder's basket; checked by tesoro_core against its seeds.
    #[account(
        mut,
        seeds = [BASKET_SEED, holder_account.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_basket: UncheckedAccount<'info>,
    /// CHECK: the holder's spill; checked by tesoro_core against its seeds.
    #[account(
        mut,
        seeds = [SPILL_SEED, holder_account.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_spill: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Claim::INIT_SPACE,
        seeds = [CLAIM_SEED, holder_account.key().as_ref(), core_source.key().as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, Claim>>,
    /// The vault's Delivery Fee terms; their eid and vault must be this Position's.
    #[account(
        seeds = [DELIVERY_SEED, &delivery_terms.eid.to_be_bytes(), &delivery_terms.peer_address],
        bump = delivery_terms.bump,
        constraint = delivery_terms.peer_address == vault_of(&core_position.position_id)
            && core_chain(delivery_terms.eid)? == core_position.inner.source_chain
            @ BridgeError::InvalidAccount
    )]
    pub delivery_terms: Box<Account<'info, DeliveryTerms>>,
    /// The vault's terms: its decimals give the core-unit to vault-unit scale.
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &delivery_terms.eid.to_be_bytes(), &delivery_terms.peer_address],
        bump = peer.bump
    )]
    pub peer: Box<Account<'info, PeerConfig>>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl RedeemToEvm<'_> {
    pub fn apply<'info>(
        ctx: &mut Context<'_, '_, '_, 'info, RedeemToEvm<'info>>,
        line: LineRef,
        gemas: u64,
    ) -> Result<()> {
        require!(ctx.accounts.holder_account.evm_address != [0u8; 20], BridgeError::NoEvmAddress);
        require!(
            ctx.accounts.core_position.inner.source_chain != SourceChain::Solana,
            BridgeError::NotBridgedPosition
        );
        require_normalised_units(ctx.accounts.core_position.inner.decimals)?;
        let before = &ctx.accounts.core_source.inner;
        let (units_before, fee_before, pool_before) =
            (before.redeemed_units, before.fee_units, before.pool_units);

        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        tesoro_core::cpi::redeem_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                RedeemFromSource {
                    holder_authority: ctx.accounts.holder_authority.to_account_info(),
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    holder_account: ctx.accounts.holder_account.to_account_info(),
                    basket: ctx.accounts.core_basket.to_account_info(),
                    spill: ctx.accounts.core_spill.to_account_info(),
                    position: ctx.accounts.core_position.to_account_info(),
                    source: ctx.accounts.core_source.to_account_info(),
                },
                signer_seeds,
            )
            // The Source's book and checkpoint pages.
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            line,
            gemas,
        )?;
        ctx.accounts.core_source.reload()?;
        let after = &ctx.accounts.core_source.inner;
        let delta = |now: u64, then: u64| now.checked_sub(then).ok_or(BridgeError::AmountOverflow);
        let units = delta(after.redeemed_units, units_before)?;
        // The Yield Fee split core applied to this cash-out (ticket 31): the vault keeps `fee` for
        // the Treasury and owes `pool` of what the Treasury keeps to the Leaderboard Pool.
        let fee = delta(after.fee_units, fee_before)?;
        let pool = delta(after.pool_units, pool_before)?;

        let claim = &mut ctx.accounts.claim;
        if claim.holder_account == Pubkey::default() {
            claim.holder_account = ctx.accounts.holder_account.key();
            claim.source = ctx.accounts.core_source.key();
            claim.position = ctx.accounts.core_position.key();
            claim.bump = ctx.bumps.claim;
        }
        // The Player's share of this Redeem, in the vault's units, must clear the minimum; the fee
        // is fixed now for the units that wait for the next send (one fee per message).
        let share = ctx.accounts.peer.to_vault(units.saturating_sub(fee))?;
        let terms = &ctx.accounts.delivery_terms;
        terms.require_min_redeem(share)?;
        if claim.units_total == claim.units_sent {
            claim.delivery_fee = terms.fee_for(share, terms.max_bps_yield);
        }
        claim.gemas_total =
            claim.gemas_total.checked_add(gemas).ok_or(BridgeError::AmountOverflow)?;
        claim.units_total =
            claim.units_total.checked_add(units).ok_or(BridgeError::AmountOverflow)?;
        claim.fee_total = claim.fee_total.checked_add(fee).ok_or(BridgeError::AmountOverflow)?;
        claim.pool_total = claim.pool_total.checked_add(pool).ok_or(BridgeError::AmountOverflow)?;
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

/// A Position opened before units were normalised holds wei (18 decimals), which `send_pay_yield`
/// refuses to pay. Redeeming it would burn the Gemas and book a Claim that can never be paid, so
/// the redeem paths refuse it first. Current bridged Positions never exceed `CORE_DECIMALS`.
pub fn require_normalised_units(position_decimals: u8) -> Result<()> {
    require!(position_decimals <= CORE_DECIMALS, BridgeError::LegacyUnits);
    Ok(())
}
