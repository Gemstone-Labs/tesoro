use crate::*;

// Anyone can pay to create the Position record for (eid, position_id) ahead of the first message
// from that chain. The record is inert until a message for the same key arrives.
#[derive(Accounts)]
#[instruction(params: InitPositionParams)]
pub struct InitPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [PEER_SEED, &store.key().to_bytes(), &params.eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = payer,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, &params.eid.to_be_bytes(), &params.position_id],
        bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

impl InitPosition<'_> {
    pub fn apply(ctx: &mut Context<InitPosition>, params: &InitPositionParams) -> Result<()> {
        let position = &mut ctx.accounts.position;
        position.source_chain = params.eid;
        position.position_id = params.position_id;
        position.bump = ctx.bumps.position;
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct InitPositionParams {
    pub eid: u32,
    pub position_id: [u8; 32],
}
