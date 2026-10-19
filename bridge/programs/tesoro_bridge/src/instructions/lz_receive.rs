use crate::*;
use msg_codec::{decode_inbound, Inbound};
use oapp::{
    endpoint::{
        cpi::accounts::Clear, instructions::ClearParams, ConstructCPIContext, ID as ENDPOINT_ID,
    },
    LzReceiveParams,
};

// Account order is a contract with `lz_receive_types_v2`: payer, store, peer, bridge_position,
// system_program, then the Endpoint::clear accounts as remaining accounts.
#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    // Emitter authentication: the sender must be a registered vault of this src_eid. The PDA is
    // derived from the sender itself, so an unregistered sender fails account deserialization.
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.src_eid.to_be_bytes(), &params.sender],
        bump = peer.bump,
        constraint = params.sender == peer.peer_address @ BridgeError::UnknownPeer
    )]
    pub peer: Account<'info, PeerConfig>,
    // Must already exist (see `init_position`): the default Executor on Hoodi/HyperEVM caps the
    // native drop to Solana at 0, so nobody can fund rent for an account created inside lz_receive.
    #[account(
        mut,
        seeds = [POSITION_SEED, &params.src_eid.to_be_bytes(), &msg_codec::position_id_or_zero(&params.message)],
        bump = bridge_position.bump
    )]
    pub bridge_position: Account<'info, BridgePosition>,
    pub system_program: Program<'info, System>,
}

impl LzReceive<'_> {
    pub fn apply(ctx: &mut Context<LzReceive>, params: &LzReceiveParams) -> Result<()> {
        let (header, body) = decode_inbound(&params.message)?;
        require!(header.source_chain == params.src_eid, BridgeError::InvalidSourceChain);
        // A vault can only speak for its own Positions: the id embeds the vault address.
        require!(valid_position_id(&header.position_id), BridgeError::InvalidPositionId);
        require!(vault_of(&header.position_id) == params.sender, BridgeError::InvalidPositionId);

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

        // Application-level idempotency: duplicates and stale messages are consumed as no-ops.
        // PositionLocked and YieldAccrued are tracked separately so a yield report that overtakes
        // its PositionLocked cannot make the Position unopenable.
        let position = &mut ctx.accounts.bridge_position;
        require!(
            position.position_id == header.position_id && position.eid == header.source_chain,
            BridgeError::PositionMismatch
        );
        let applied = match body {
            Inbound::Locked { owner, asset, principal, horizon } => {
                if position.locked_seq == 0 {
                    position.owner_evm =
                        msg_codec::unpad_address(&owner).ok_or(BridgeError::InvalidMessageType)?;
                    position.asset = asset;
                    position.principal = principal;
                    position.horizon_months = horizon;
                    position.locked_seq = header.seq;
                    true
                } else {
                    false
                }
            },
            Inbound::Yield { cumulative, treasury_balance, instant_paid, report_time } => {
                if header.seq > position.last_yield_seq {
                    position.last_yield_seq = header.seq;
                    position.yield_cumulative = cumulative;
                    position.treasury_balance = treasury_balance;
                    position.instant_paid = instant_paid;
                    position.report_time = report_time;
                    true
                } else {
                    false
                }
            },
        };
        position.last_in_seq = position.last_in_seq.max(header.seq);
        emit!(MessageReceived {
            src_eid: params.src_eid,
            position_id: header.position_id,
            msg_type: header.msg_type,
            seq: header.seq,
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
    pub applied: bool,
}
