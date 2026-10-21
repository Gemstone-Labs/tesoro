use crate::*;
use msg_codec::{encode_pay_prize, pad_address, route_word, MSG_PAY_PRIZE};

// Sends (or sends again) a pending prize payout. `PayPrize` binds the chain (the message's source
// chain), the vault (the destination and the route word), the asset, the prize Source, the
// recipient, the share quantity and the payout id; the vault pays each id at most once and debits
// only its prize escrow. Until the vault answers the shares stay reserved: nothing here releases
// them on a timeout. Permissionless; the payer funds the LayerZero fee.
#[derive(Accounts)]
#[instruction(params: SendPayPrizeParams)]
pub struct SendPayPrize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes(), &params.peer_address],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(
        mut,
        seeds = [PAYOUT_SEED, &params.eid.to_be_bytes(), &params.peer_address, &params.payout_id.to_be_bytes()],
        bump = payout.bump
    )]
    pub payout: Box<Account<'info, PayoutRecord>>,
    pub system_program: Program<'info, System>,
}

impl SendPayPrize<'_> {
    pub fn apply(ctx: &mut Context<SendPayPrize>, params: &SendPayPrizeParams) -> Result<()> {
        let payout = &mut ctx.accounts.payout;
        require!(payout.state == PAYOUT_PENDING, BridgeError::PayoutNotPending);
        let message = encode_pay_prize(
            payout.eid,
            &payout.peer_address,
            payout.id,
            payout.asset,
            payout.prize_source.to_bytes(),
            pad_address(&payout.recipient),
            payout.shares,
        );
        payout.sends = payout.sends.saturating_add(1);
        let send = SendParams {
            eid: params.eid,
            position_id: route_word(&params.peer_address),
            options: params.options.clone(),
            native_fee: params.native_fee,
            lz_token_fee: params.lz_token_fee,
        };
        lz_send(&ctx.accounts.store, &ctx.accounts.peer, ctx.remaining_accounts, &send, message)?;
        emit!(MessageSent {
            dst_eid: params.eid,
            position_id: route_word(&params.peer_address),
            msg_type: MSG_PAY_PRIZE,
            seq: params.payout_id,
            amount: ctx.accounts.payout.shares,
        });
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendPayPrizeParams {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub payout_id: u64,
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}
