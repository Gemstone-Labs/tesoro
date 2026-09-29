use crate::*;
use msg_codec::{PositionMessage, MSG_PAY_YIELD, MSG_UNLOCK};
use oapp::endpoint::{
    instructions::SendParams, state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID,
};

// Solana -> source chain. In tesoro_core only program logic will reach this path; in the spike
// the store admin stands in for that authority.
#[derive(Accounts)]
#[instruction(params: SendMessageParams)]
pub struct Send<'info> {
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.dst_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, &params.dst_eid.to_be_bytes(), &params.position_id],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Account<'info, EndpointSettings>,
    pub system_program: Program<'info, System>,
}

impl Send<'_> {
    pub fn apply(ctx: &mut Context<Send>, params: &SendMessageParams) -> Result<()> {
        require!(
            params.msg_type == MSG_UNLOCK || params.msg_type == MSG_PAY_YIELD,
            LzOAppError::InvalidMessageType
        );

        let position = &mut ctx.accounts.position;
        position.source_chain = params.dst_eid;
        position.position_id = params.position_id;
        position.bump = ctx.bumps.position;
        let seq = position
            .last_out_seq
            .checked_add(1)
            .ok_or(LzOAppError::SeqOverflow)?;
        position.last_out_seq = seq;
        position.last_out_type = params.msg_type;
        position.last_out_amount = params.amount;

        let message = PositionMessage {
            msg_type: params.msg_type,
            source_chain: params.dst_eid,
            position_id: params.position_id,
            seq,
            amount: params.amount,
        }
        .encode();

        let seeds: &[&[u8]] = &[STORE_SEED, &[ctx.accounts.store.bump]];
        oapp::endpoint_cpi::send(
            ENDPOINT_ID,
            ctx.accounts.store.key(),
            ctx.remaining_accounts,
            seeds,
            SendParams {
                dst_eid: params.dst_eid,
                receiver: ctx.accounts.peer.peer_address,
                message,
                options: ctx.accounts.peer.combine_options(&params.options)?,
                native_fee: params.native_fee,
                lz_token_fee: params.lz_token_fee,
            },
        )?;
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendMessageParams {
    pub dst_eid: u32,
    pub msg_type: u8,
    pub position_id: [u8; 32],
    pub amount: u128,
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}
