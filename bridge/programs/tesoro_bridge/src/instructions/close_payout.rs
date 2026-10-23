use crate::*;

// Returns the rent of a final prize payout to whoever paid it: paid by the vault, or refunded after
// the vault's signed rejection. A Pending or Rejected payout still holds reserved shares or burned
// Gemas and stays. The id is below the route's `last_payout_id`, which only grows, so it is never
// handed out twice, and a repeated answer for it is consumed as a no-op by `lz_receive`.
// Permissionless.
#[derive(Accounts)]
pub struct ClosePayout<'info> {
    #[account(
        mut,
        close = rent_receiver,
        seeds = [PAYOUT_SEED, &payout.eid.to_be_bytes(), &payout.peer_address, &payout.id.to_be_bytes()],
        bump = payout.bump,
        constraint = payout.state == PAYOUT_PAID || payout.state == PAYOUT_REFUNDED
            @ BridgeError::PayoutNotFinal
    )]
    pub payout: Box<Account<'info, PayoutRecord>>,
    /// CHECK: must be the account that paid the payout's rent.
    #[account(mut, address = payout.rent_payer @ BridgeError::WrongRentReceiver)]
    pub rent_receiver: UncheckedAccount<'info>,
}

impl ClosePayout<'_> {
    pub fn apply(ctx: &mut Context<ClosePayout>) -> Result<()> {
        emit!(PayoutClosed {
            eid: ctx.accounts.payout.eid,
            peer_address: ctx.accounts.payout.peer_address,
            payout_id: ctx.accounts.payout.id,
        });
        Ok(())
    }
}

#[event]
pub struct PayoutClosed {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub payout_id: u64,
}
