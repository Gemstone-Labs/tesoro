use crate::*;

// Raises the mirror of a vault's treasury to the total carried by a Position's latest yield
// report, without applying the yield. Permissionless: the value only ever comes from the vault.
#[derive(Accounts)]
#[instruction(params: PositionRef)]
pub struct SyncTreasury<'info> {
    #[account(
        seeds = [POSITION_SEED, &params.eid.to_be_bytes(), &params.position_id],
        bump = bridge_position.bump
    )]
    pub bridge_position: Account<'info, BridgePosition>,
    #[account(
        mut,
        seeds = [TREASURY_SEED, &params.eid.to_be_bytes(), &vault_of(&params.position_id)],
        bump = vault_treasury.bump
    )]
    pub vault_treasury: Account<'info, VaultTreasury>,
}

impl SyncTreasury<'_> {
    pub fn apply(ctx: &mut Context<SyncTreasury>, _params: &PositionRef) -> Result<()> {
        let reported = ctx.accounts.bridge_position.treasury_in;
        ctx.accounts.vault_treasury.raise(reported);
        Ok(())
    }
}
