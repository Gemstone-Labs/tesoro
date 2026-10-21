use crate::*;
use tesoro_core::{
    cpi::accounts::BeginPrizePayoutFromSource,
    program::TesoroCore,
    state::{
        PrizeSourceState, SourceAuthority, TesoroAccount, ACCOUNT_SEED, SOURCE_AUTHORITY_SEED,
    },
    storage::{BASKET_SEED, SPILL_SEED},
};

// A holder redeems prize Gemas of an ETH or HyperEVM route. Core burns the Gemas and takes their
// share of the prize Source (`begin_prize_payout_from_source`, signed by the holder and this
// program's authority PDA); this program records the payout with a route-scoped id and reserves
// its shares. `send_pay_prize` delivers it and the vault pays it from its prize escrow, whatever
// its Treasury holds. The recipient is the holder's proven EVM address.
#[derive(Accounts)]
pub struct RedeemPrizeToEvm<'info> {
    #[account(mut)]
    pub holder_authority: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [ROUTE_SEED, &route.eid.to_be_bytes(), &route.peer_address],
        bump = route.bump
    )]
    pub route: Account<'info, VaultRoute>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[core_chain_byte(route.eid).unwrap_or(u8::MAX)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Box<Account<'info, SourceAuthority>>,
    #[account(
        seeds = [ACCOUNT_SEED, holder_authority.key().as_ref()],
        bump = holder_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub holder_account: Box<Account<'info, TesoroAccount>>,
    #[account(
        seeds = [EVM_LINK_SEED, &holder_account.evm_address],
        bump = evm_link.bump,
        constraint = evm_link.account == holder_account.key() @ BridgeError::EvmAddressMismatch
    )]
    pub evm_link: Account<'info, EvmLink>,
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
        mut,
        constraint = prize_source.route == route.key() @ BridgeError::WrongRoute
    )]
    pub prize_source: Box<Account<'info, PrizeSourceState>>,
    #[account(
        init,
        payer = holder_authority,
        space = 8 + PayoutRecord::INIT_SPACE,
        seeds = [
            PAYOUT_SEED,
            &route.eid.to_be_bytes(),
            &route.peer_address,
            &route.last_payout_id.saturating_add(1).to_be_bytes()
        ],
        bump
    )]
    pub payout: Box<Account<'info, PayoutRecord>>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl RedeemPrizeToEvm<'_> {
    pub fn apply(ctx: &mut Context<RedeemPrizeToEvm>, gemas: u64) -> Result<()> {
        require!(ctx.accounts.holder_account.evm_address != [0u8; 20], BridgeError::NoEvmAddress);
        let before = ctx.accounts.prize_source.inner.shares;
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        tesoro_core::cpi::begin_prize_payout_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                BeginPrizePayoutFromSource {
                    holder_authority: ctx.accounts.holder_authority.to_account_info(),
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    holder_account: ctx.accounts.holder_account.to_account_info(),
                    basket: ctx.accounts.core_basket.to_account_info(),
                    spill: ctx.accounts.core_spill.to_account_info(),
                    prize_source: ctx.accounts.prize_source.to_account_info(),
                },
                signer_seeds,
            ),
            core_chain(ctx.accounts.route.eid)?,
            gemas,
        )?;
        ctx.accounts.prize_source.reload()?;
        let shares = before
            .checked_sub(ctx.accounts.prize_source.inner.shares)
            .ok_or(BridgeError::AmountOverflow)?;
        require!(shares > 0, BridgeError::NothingToPay);
        let route = &mut ctx.accounts.route;
        let id = route.next_payout_id()?;
        route.begin_payout(shares)?;
        let payout = &mut ctx.accounts.payout;
        payout.eid = route.eid;
        payout.peer_address = route.peer_address;
        payout.id = id;
        payout.bump = ctx.bumps.payout;
        payout.state = PAYOUT_PENDING;
        payout.holder_account = ctx.accounts.holder_account.key();
        payout.recipient = ctx.accounts.holder_account.evm_address;
        payout.prize_source = ctx.accounts.prize_source.key();
        payout.asset = route.asset;
        payout.gemas = gemas;
        payout.shares = shares;
        emit!(PrizePayoutOpened {
            eid: payout.eid,
            peer_address: payout.peer_address,
            payout_id: id,
            gemas,
            shares,
        });
        Ok(())
    }
}

#[event]
pub struct PrizePayoutOpened {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub payout_id: u64,
    pub gemas: u64,
    pub shares: u128,
}
