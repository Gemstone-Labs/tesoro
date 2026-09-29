use crate::*;
use msg_codec::{encode_unlock, MSG_UNLOCK};
use oapp::endpoint::{state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID};
use tesoro_core::{
    ledger::PositionStatus,
    state::{PositionState, POSITION_SEED as CORE_POSITION_SEED},
};

// Sends `Unlock` to the Position's vault once tesoro_core says the Position is Unlocked (its
// Debt is zero and the owner asked for the unlock). Permissionless; the payer funds the
// LayerZero fee. `unlock_sent` and the outbound seq stop it from being sent twice.
#[derive(Accounts)]
#[instruction(params: SendParams)]
pub struct SendUnlock<'info> {
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
        mut,
        seeds = [POSITION_SEED, &params.eid.to_be_bytes(), &params.position_id],
        bump = bridge_position.bump
    )]
    pub bridge_position: Account<'info, BridgePosition>,
    #[account(
        seeds = [CORE_POSITION_SEED, &[core_chain_byte(params.eid).unwrap_or(u8::MAX)], &params.position_id],
        bump = core_position.bump,
        seeds::program = tesoro_core::ID
    )]
    pub core_position: Account<'info, PositionState>,
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Account<'info, EndpointSettings>,
    pub system_program: Program<'info, System>,
}

impl SendUnlock<'_> {
    pub fn apply(ctx: &mut Context<SendUnlock>, params: &SendParams) -> Result<()> {
        let core = &ctx.accounts.core_position.inner;
        require!(
            core.status == PositionStatus::Unlocked && core.open_advance.is_none(),
            BridgeError::NotUnlocked
        );
        let position = &mut ctx.accounts.bridge_position;
        require!(position.opened, BridgeError::NotOpened);
        require!(!position.unlock_sent, BridgeError::UnlockAlreadySent);
        let seq = next_out_seq(position)?;
        position.unlock_sent = true;

        lz_send(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            ctx.remaining_accounts,
            params,
            encode_unlock(params.eid, params.position_id, seq),
        )?;
        emit!(MessageSent {
            dst_eid: params.eid,
            position_id: params.position_id,
            msg_type: MSG_UNLOCK,
            seq,
            amount: 0,
        });
        Ok(())
    }
}
