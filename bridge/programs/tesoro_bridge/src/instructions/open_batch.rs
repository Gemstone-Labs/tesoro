use crate::*;
use msg_codec::{KIND_LEADERBOARD, KIND_STUDIO};

// Opens the route's next cash-in batch. Permissionless: what a batch pays, and to whom, is fixed by
// tesoro_core's fee settings when entries are added, never by the opener. Leaderboard batches
// need the route's prize escrow switched on.
#[derive(Accounts)]
#[instruction(params: OpenBatchParams)]
pub struct OpenBatch<'info> {
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
        seeds = [ROUTE_SEED, &params.eid.to_be_bytes(), &params.peer_address],
        bump = route.bump
    )]
    pub route: Account<'info, VaultRoute>,
    #[account(
        init,
        payer = payer,
        space = 8 + Batch::INIT_SPACE,
        seeds = [
            BATCH_SEED,
            &params.eid.to_be_bytes(),
            &params.peer_address,
            &route.last_batch_id.saturating_add(1).to_be_bytes()
        ],
        bump
    )]
    pub batch: Box<Account<'info, Batch>>,
    pub system_program: Program<'info, System>,
}

impl OpenBatch<'_> {
    pub fn apply(ctx: &mut Context<OpenBatch>, params: &OpenBatchParams) -> Result<()> {
        require!(params.kind <= KIND_LEADERBOARD, BridgeError::InvalidMessageType);
        let route = &mut ctx.accounts.route;
        if params.kind == KIND_LEADERBOARD {
            require!(route.escrow_enabled, BridgeError::EscrowOff);
        } else {
            require!(params.kind <= KIND_STUDIO, BridgeError::InvalidMessageType);
        }
        let id = route.next_batch_id()?;
        let batch = &mut ctx.accounts.batch;
        batch.eid = params.eid;
        batch.peer_address = params.peer_address;
        batch.id = id;
        batch.bump = ctx.bumps.batch;
        batch.rent_payer = ctx.accounts.payer.key();
        batch.kind = params.kind;
        emit!(BatchOpened {
            eid: params.eid,
            peer_address: params.peer_address,
            batch_id: id,
            kind: params.kind
        });
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct OpenBatchParams {
    pub eid: u32,
    pub peer_address: [u8; 32],
    /// 0 Platform, 1 Studio, 2 Leaderboard.
    pub kind: u8,
}

#[event]
pub struct BatchOpened {
    pub eid: u32,
    pub peer_address: [u8; 32],
    pub batch_id: u64,
    pub kind: u8,
}
