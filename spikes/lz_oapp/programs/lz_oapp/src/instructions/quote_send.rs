use crate::*;
use msg_codec::{PositionMessage, MSG_UNLOCK};
use oapp::endpoint::{
    instructions::QuoteParams, state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID,
};

#[derive(Accounts)]
#[instruction(params: QuoteSendParams)]
pub struct QuoteSend<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, store.key().as_ref(), &params.dst_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Account<'info, EndpointSettings>,
}

impl QuoteSend<'_> {
    pub fn apply(ctx: &Context<QuoteSend>, params: &QuoteSendParams) -> Result<MessagingFee> {
        // Every Position message has the same fixed length, so a placeholder prices them all.
        let message = PositionMessage {
            msg_type: MSG_UNLOCK,
            source_chain: params.dst_eid,
            position_id: [0u8; 32],
            seq: 1,
            amount: 0,
        }
        .encode();
        oapp::endpoint_cpi::quote(
            ENDPOINT_ID,
            ctx.remaining_accounts,
            QuoteParams {
                sender: ctx.accounts.store.key(),
                dst_eid: params.dst_eid,
                receiver: ctx.accounts.peer.peer_address,
                message,
                pay_in_lz_token: params.pay_in_lz_token,
                options: ctx.accounts.peer.combine_options(&params.options)?,
            },
        )
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct QuoteSendParams {
    pub dst_eid: u32,
    pub options: Vec<u8>,
    pub pay_in_lz_token: bool,
}
