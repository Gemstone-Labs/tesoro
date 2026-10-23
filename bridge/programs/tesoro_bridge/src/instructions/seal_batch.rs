use crate::*;

// Freezes a batch: no entry can be added or changed afterwards, and the message that names them is
// the same bytes every time it is sent. Needs at least one entry and the route's minimum size.
// Permissionless.
#[derive(Accounts)]
pub struct SealBatch<'info> {
    #[account(
        seeds = [ROUTE_SEED, &batch.eid.to_be_bytes(), &batch.peer_address],
        bump = route.bump
    )]
    pub route: Account<'info, VaultRoute>,
    #[account(
        mut,
        seeds = [BATCH_SEED, &batch.eid.to_be_bytes(), &batch.peer_address, &batch.id.to_be_bytes()],
        bump = batch.bump
    )]
    pub batch: Box<Account<'info, Batch>>,
}

impl SealBatch<'_> {
    pub fn apply(ctx: &mut Context<SealBatch>) -> Result<()> {
        ctx.accounts.batch.seal(ctx.accounts.route.min_batch_units)?;
        emit!(BatchSealed {
            eid: ctx.accounts.batch.eid,
            peer_address: ctx.accounts.batch.peer_address,
            batch_id: ctx.accounts.batch.id,
            total_units: ctx.accounts.batch.total_units,
        });
        Ok(())
    }
}

#[event]
pub struct BatchSealed {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub batch_id: u64,
    pub total_units: u128,
}
