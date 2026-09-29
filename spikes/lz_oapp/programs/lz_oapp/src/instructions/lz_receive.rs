use crate::*;
use msg_codec::{PositionMessage, MSG_POSITION_LOCKED, MSG_YIELD_ACCRUED};
use oapp::{
    endpoint::{cpi::accounts::Clear, instructions::ClearParams, ConstructCPIContext, ID as ENDPOINT_ID},
    LzReceiveParams,
};

// Account order is a contract with `lz_receive_types_v2`: payer, store, peer, position,
// system_program, then the Endpoint::clear accounts as remaining accounts.
#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    // Emitter authentication: the sender must be exactly the peer registered for this src_eid.
    // A src_eid with no PeerConfig fails account deserialization, i.e. unknown chains are rejected.
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.src_eid.to_be_bytes()],
        bump = peer.bump,
        constraint = params.sender == peer.peer_address @ LzOAppError::UnknownPeer
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, &params.src_eid.to_be_bytes(), &msg_codec::position_id_or_zero(&params.message)],
        bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

impl LzReceive<'_> {
    pub fn apply(ctx: &mut Context<LzReceive>, params: &LzReceiveParams) -> Result<()> {
        let msg = PositionMessage::decode(&params.message)?;
        require!(
            msg.source_chain == params.src_eid,
            LzOAppError::InvalidSourceChain
        );
        require!(
            msg.msg_type == MSG_POSITION_LOCKED || msg.msg_type == MSG_YIELD_ACCRUED,
            LzOAppError::InvalidMessageType
        );

        // Endpoint::clear burns the nonce: the transport-level replay protection.
        let seeds: &[&[u8]] = &[STORE_SEED, &[ctx.accounts.store.bump]];
        let accounts_for_clear = ctx
            .remaining_accounts
            .get(..Clear::MIN_ACCOUNTS_LEN)
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        oapp::endpoint_cpi::clear(
            ENDPOINT_ID,
            ctx.accounts.store.key(),
            accounts_for_clear,
            seeds,
            ClearParams {
                receiver: ctx.accounts.store.key(),
                src_eid: params.src_eid,
                sender: params.sender,
                nonce: params.nonce,
                guid: params.guid,
                message: params.message.clone(),
            },
        )?;

        // Application-level idempotency: a duplicate or stale seq is consumed as a no-op.
        let position = &mut ctx.accounts.position;
        require!(
            position.bump == 0 || position.position_id == msg.position_id,
            LzOAppError::PositionMismatch
        );
        let applied = msg.seq > position.last_in_seq;
        if applied {
            position.source_chain = msg.source_chain;
            position.position_id = msg.position_id;
            position.bump = ctx.bumps.position;
            position.last_in_seq = msg.seq;
            position.last_in_type = msg.msg_type;
            position.last_in_amount = msg.amount;
        }
        emit!(MessageReceived {
            src_eid: params.src_eid,
            position_id: msg.position_id,
            msg_type: msg.msg_type,
            seq: msg.seq,
            amount: msg.amount,
            applied,
        });
        Ok(())
    }
}

#[event]
pub struct MessageReceived {
    pub src_eid: u32,
    pub position_id: [u8; 32],
    pub msg_type: u8,
    pub seq: u64,
    pub amount: u128,
    pub applied: bool,
}
