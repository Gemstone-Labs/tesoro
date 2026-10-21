use crate::*;
use msg_codec::{
    encode_cash_in_batch, encode_pay_instant, encode_pay_prize, encode_pay_yield, encode_unlock,
    BatchEntryWire, MAX_BATCH_ENTRIES, MSG_CASH_IN_BATCH, MSG_PAY_INSTANT, MSG_PAY_PRIZE,
    MSG_PAY_YIELD, MSG_UNLOCK,
};
use oapp::endpoint::{
    instructions::QuoteParams, state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID,
};

#[derive(Accounts)]
#[instruction(params: QuoteSendParams)]
pub struct QuoteSend<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        seeds = [PEER_SEED, store.key().as_ref(), &params.dst_eid.to_be_bytes(), &params.peer_address],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Account<'info, EndpointSettings>,
}

impl QuoteSend<'_> {
    pub fn apply(ctx: &Context<QuoteSend>, params: &QuoteSendParams) -> Result<MessagingFee> {
        // Each outbound type has a fixed length, so a placeholder of the right type prices it.
        let message = match params.msg_type {
            MSG_UNLOCK => encode_unlock(params.dst_eid, [0u8; 32], 1),
            MSG_PAY_YIELD => encode_pay_yield(params.dst_eid, [0u8; 32], 1, [0u8; 32], 0),
            MSG_PAY_INSTANT => encode_pay_instant(params.dst_eid, [0u8; 32], 1, [0u8; 32], 0),
            // A full batch prices the largest one.
            MSG_CASH_IN_BATCH => {
                let entries: Vec<BatchEntryWire> = (0..MAX_BATCH_ENTRIES)
                    .map(|_| BatchEntryWire { vault_position_id: 0, units: 0 })
                    .collect();
                encode_cash_in_batch(
                    params.dst_eid,
                    &params.peer_address,
                    1,
                    0,
                    [0u8; 32],
                    &entries,
                )
            },
            MSG_PAY_PRIZE => encode_pay_prize(
                params.dst_eid,
                &params.peer_address,
                1,
                [0u8; 32],
                [0u8; 32],
                [0u8; 32],
                0,
            ),
            _ => return err!(BridgeError::InvalidMessageType),
        };
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
    pub peer_address: [u8; 32],
    /// 3 = Unlock, 4 = PayYield, 5 = PayInstant, 6 = CashInBatch (priced at its largest), 7 = PayPrize.
    pub msg_type: u8,
    pub options: Vec<u8>,
    pub pay_in_lz_token: bool,
}
