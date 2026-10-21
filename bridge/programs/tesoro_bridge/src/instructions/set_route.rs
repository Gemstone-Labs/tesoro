use crate::*;

// Admin: the vault's route terms. `escrow_enabled` stays off until the treasury slashing fix is
// accepted (spec): while off, no Leaderboard batch opens and no prize is issued. `asset` keys the
// price of prize Gemas. `min_batch_units` is the smallest total a batch needs to be sealed, so a
// fee payout is never worth less than its gas (0 = no minimum).
#[derive(Accounts)]
#[instruction(params: SetRouteParams)]
pub struct SetRoute<'info> {
    #[account(address = store.admin @ BridgeError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        mut,
        seeds = [ROUTE_SEED, &params.eid.to_be_bytes(), &params.peer_address],
        bump = route.bump
    )]
    pub route: Account<'info, VaultRoute>,
}

impl SetRoute<'_> {
    pub fn apply(ctx: &mut Context<SetRoute>, params: &SetRouteParams) -> Result<()> {
        let route = &mut ctx.accounts.route;
        route.asset = params.asset;
        route.escrow_enabled = params.escrow_enabled;
        route.min_batch_units = params.min_batch_units;
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetRouteParams {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub asset: [u8; 32],
    pub escrow_enabled: bool,
    pub min_batch_units: u64,
}
