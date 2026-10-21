use crate::*;

// Returns the rent of a finished batch to whoever paid it. Only a Done batch (every entry
// acknowledged in full) can close. Nothing a closed batch held is needed again: its id is below the
// route's `last_batch_id`, which only grows, so the id is never handed out twice, and a repeated
// acknowledgement for it is consumed as a no-op by `lz_receive`. Permissionless.
#[derive(Accounts)]
pub struct CloseBatch<'info> {
    #[account(
        mut,
        close = rent_receiver,
        seeds = [BATCH_SEED, &batch.eid.to_be_bytes(), &batch.peer_address, &batch.id.to_be_bytes()],
        bump = batch.bump,
        constraint = batch.state == BATCH_DONE @ BridgeError::BatchNotDone
    )]
    pub batch: Box<Account<'info, Batch>>,
    /// CHECK: must be the account that paid the batch's rent.
    #[account(mut, address = batch.rent_payer @ BridgeError::WrongRentReceiver)]
    pub rent_receiver: UncheckedAccount<'info>,
}

impl CloseBatch<'_> {
    pub fn apply(ctx: &mut Context<CloseBatch>) -> Result<()> {
        emit!(BatchClosed {
            eid: ctx.accounts.batch.eid,
            peer_address: ctx.accounts.batch.peer_address,
            batch_id: ctx.accounts.batch.id,
        });
        Ok(())
    }
}

#[event]
pub struct BatchClosed {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub batch_id: u64,
}
