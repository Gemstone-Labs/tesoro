use crate::*;

// Anyone can pay to create the BridgePosition record for (eid, position_id) ahead of the first
// message from that vault (the Executor cannot fund rent inside `lz_receive`). The record is
// inert until a message for the same key arrives from the registered vault named in the id.
#[derive(Accounts)]
#[instruction(params: PositionRef)]
pub struct InitPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes(), &vault_of(&params.position_id)],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = payer,
        space = 8 + BridgePosition::INIT_SPACE,
        seeds = [POSITION_SEED, &params.eid.to_be_bytes(), &params.position_id],
        bump
    )]
    pub bridge_position: Account<'info, BridgePosition>,
    pub system_program: Program<'info, System>,
}

impl InitPosition<'_> {
    pub fn apply(ctx: &mut Context<InitPosition>, params: &PositionRef) -> Result<()> {
        require!(valid_position_id(&params.position_id), BridgeError::InvalidPositionId);
        core_chain(params.eid)?;
        let position = &mut ctx.accounts.bridge_position;
        position.eid = params.eid;
        position.position_id = params.position_id;
        position.bump = ctx.bumps.bridge_position;
        Ok(())
    }
}

/// Identifies a Position: the source chain eid and the 32-byte id
/// (`vault address (20) | vault position id (u64 BE) | 4 zero bytes`).
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct PositionRef {
    pub eid: u32,
    pub position_id: [u8; 32],
}
