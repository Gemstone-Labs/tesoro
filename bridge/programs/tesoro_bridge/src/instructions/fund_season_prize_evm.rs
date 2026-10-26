use crate::*;
use tesoro_core::{
    cpi::accounts::IssuePrizeFromSource,
    program::TesoroCore,
    state::{
        Config, EconomyConfig, SourceAuthority, TesoroAccount, ACCOUNT_SEED, CONFIG_SEED,
        ECONOMY_SEED, PRIZE_SOURCE_SEED, SOURCE_AUTHORITY_SEED,
    },
    storage::{BASKET_SEED, SPILL_SEED},
};

// Issues the Pool's prize Source for an ended Season on this route: one Source for the escrow
// inflow the vault has confirmed (Yield Reports and batch acknowledgements) and no prize Gema has
// been issued for yet, so prize Gemas never exceed what the vault holds for them. Core checks the
// Season authority (admin or keeper), that the Season has ended and the price (the asset's Pyth
// feed when it has one, else the oracle's). Remaining accounts: the asset's `OnchainPrice`
// address, then its feed when that account exists.
#[derive(Accounts)]
#[instruction(params: FundSeasonPrizeEvmParams)]
pub struct FundSeasonPrizeEvm<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The Season authority: the core admin or the Season keeper.
    pub season_authority: Signer<'info>,
    /// Only for the oracle-priced path.
    pub oracle: Option<Signer<'info>>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// CHECK: PDA that signs into tesoro_core; address fixed by seeds and the stored bump.
    #[account(seeds = [AUTHORITY_SEED], bump = store.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes(), &params.peer_address],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(
        mut,
        seeds = [ROUTE_SEED, &params.eid.to_be_bytes(), &params.peer_address],
        bump = route.bump
    )]
    pub route: Account<'info, VaultRoute>,
    #[account(
        seeds = [SOURCE_AUTHORITY_SEED, &[core_chain_byte(params.eid).unwrap_or(u8::MAX)]],
        bump = core_source_authority.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_source_authority: Box<Account<'info, SourceAuthority>>,
    #[account(seeds = [CONFIG_SEED], bump = core_config.bump, seeds::program = tesoro_core::ID)]
    pub core_config: Box<Account<'info, Config>>,
    #[account(seeds = [ECONOMY_SEED], bump = core_economy.bump, seeds::program = tesoro_core::ID)]
    pub core_economy: Box<Account<'info, EconomyConfig>>,
    #[account(
        seeds = [ACCOUNT_SEED, pool_account.authority.as_ref()],
        bump = pool_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub pool_account: Box<Account<'info, TesoroAccount>>,
    /// CHECK: the Pool's basket; checked by tesoro_core against its seeds.
    #[account(
        mut,
        seeds = [BASKET_SEED, pool_account.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub pool_basket: UncheckedAccount<'info>,
    /// CHECK: the Pool's spill; checked by tesoro_core against its seeds.
    #[account(
        mut,
        seeds = [SPILL_SEED, pool_account.key().as_ref()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub pool_spill: UncheckedAccount<'info>,
    /// CHECK: created by tesoro_core at `["prize", route, season]`, which is checked here.
    #[account(
        mut,
        seeds = [PRIZE_SOURCE_SEED, route.key().as_ref(), &params.season.to_le_bytes()],
        bump,
        seeds::program = tesoro_core::ID
    )]
    pub prize_source: UncheckedAccount<'info>,
    pub core_program: Program<'info, TesoroCore>,
    pub system_program: Program<'info, System>,
}

impl FundSeasonPrizeEvm<'_> {
    pub fn apply<'info>(
        ctx: &mut Context<'_, '_, '_, 'info, FundSeasonPrizeEvm<'info>>,
        params: &FundSeasonPrizeEvmParams,
    ) -> Result<()> {
        let peer = &ctx.accounts.peer;
        let route = &mut ctx.accounts.route;
        require!(route.escrow_enabled, BridgeError::EscrowOff);
        // The escrow's units are the vault's (wei). All open shares are issued, so all open units
        // leave the escrow with them; core values the prize in whole core units, rounded down
        // (less than one unit of dust stays in the vault and is never owed).
        let (shares, open_units) = route.unissued();
        let units = peer.to_core_u64(open_units)?;
        route.issue(params.season, shares, open_units)?;
        require!(units > 0, BridgeError::NothingToIssue);
        let route_key = ctx.accounts.route.key();
        let asset = Pubkey::new_from_array(ctx.accounts.route.asset);
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[ctx.accounts.store.authority_bump]]];
        tesoro_core::cpi::issue_prize_from_source(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.to_account_info(),
                IssuePrizeFromSource {
                    payer: ctx.accounts.payer.to_account_info(),
                    authority: ctx.accounts.season_authority.to_account_info(),
                    source_signer: ctx.accounts.authority.to_account_info(),
                    source_authority: ctx.accounts.core_source_authority.to_account_info(),
                    config: ctx.accounts.core_config.to_account_info(),
                    economy: ctx.accounts.core_economy.to_account_info(),
                    oracle: ctx.accounts.oracle.as_ref().map(|o| o.to_account_info()),
                    pool_account: ctx.accounts.pool_account.to_account_info(),
                    pool_basket: ctx.accounts.pool_basket.to_account_info(),
                    pool_spill: ctx.accounts.pool_spill.to_account_info(),
                    prize_source: ctx.accounts.prize_source.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                signer_seeds,
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            core_chain(params.eid)?,
            params.season,
            route_key,
            asset,
            ctx.accounts.peer.core_decimals(),
            shares,
            units,
            params.price_micro_usd,
        )?;
        emit!(RoutePrizeIssued {
            eid: params.eid,
            peer_address: params.peer_address,
            season: params.season,
            shares,
            units: u128::from(units),
        });
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct FundSeasonPrizeEvmParams {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub season: u32,
    /// Micro-USD per whole Source asset, used only when the asset has no `OnchainPrice` (the oracle
    /// must then sign).
    pub price_micro_usd: u64,
}

#[event]
pub struct RoutePrizeIssued {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub season: u32,
    pub shares: u128,
    pub units: u128,
}
