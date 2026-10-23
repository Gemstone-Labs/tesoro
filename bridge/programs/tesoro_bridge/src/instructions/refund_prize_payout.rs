use crate::*;
use tesoro_core::{
    cpi::accounts::CancelPrizePayoutFromSource,
    program::TesoroCore,
    state::{
        PrizeSourceState, SourceAuthority, TesoroAccount, ACCOUNT_SEED, SOURCE_AUTHORITY_SEED,
    },
    storage::{BASKET_SEED, SPILL_SEED},
};

// The vault rejected a prize payout for good (its signed answer, never a timeout): the holder gets
// the Gemas back and the prize Source its shares. Permissionless.
#[derive(Accounts)]
pub struct RefundPrizePayout<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [ROUTE_SEED, &payout.eid.to_be_bytes(), &payout.peer_address],
        bump = route.bump
    )]
    pub route: Account<'info, VaultRoute>,
    #[account(
        mut,
        seeds = [PAYOUT_SEED, &payout.eid.to_be_bytes(), &payout.peer_address, &payout.id.to_be_bytes()],
        bump = payout.bump,
        constraint = payout.holder_account == holder_account.key()
            && payout.prize_source == prize_source.key() @ BridgeError::PayoutMismatch
    )]
    pub payout: Box<Account<'info, PayoutRecord>>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[core_chain_byte(payout.eid).unwrap_or(u8::MAX)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Box<Account<'info, SourceAuthority>>,
    #[account(
        seeds = [ACCOUNT_SEED, holder_account.authority.as_ref()],
        bump = holder_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub holder_account: Box<Account<'info, TesoroAccount>>,
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
    #[account(mut)]
    pub prize_source: Box<Account<'info, PrizeSourceState>>,
    pub core_program: Program<'info, TesoroCore>,
}

impl RefundPrizePayout<'_> {
    pub fn apply(ctx: &mut Context<RefundPrizePayout>) -> Result<()> {
        let payout = &mut ctx.accounts.payout;
        require!(payout.state == PAYOUT_REJECTED, BridgeError::PayoutNotRejected);
        let (gemas, shares) = (payout.gemas, payout.shares);
        payout.state = PAYOUT_REFUNDED;
        ctx.accounts.route.cancel_payout(shares)?;
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        tesoro_core::cpi::cancel_prize_payout_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                CancelPrizePayoutFromSource {
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    holder_account: ctx.accounts.holder_account.to_account_info(),
                    basket: ctx.accounts.core_basket.to_account_info(),
                    spill: ctx.accounts.core_spill.to_account_info(),
                    prize_source: ctx.accounts.prize_source.to_account_info(),
                },
                signer_seeds,
            ),
            core_chain(ctx.accounts.payout.eid)?,
            gemas,
            shares,
        )?;
        Ok(())
    }
}
