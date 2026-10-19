use crate::*;

// Takes the Treasury balance and Instant payouts carried by a Position's latest yield
// report into the mirror of the vault's Treasury, without applying the yield. Permissionless: the value only ever comes from the vault.
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
        let position = &ctx.accounts.bridge_position;
        let (balance, paid) = (position.treasury_balance, position.instant_paid);
        ctx.accounts.vault_treasury.apply_report(balance, paid);
        Ok(())
    }
}
