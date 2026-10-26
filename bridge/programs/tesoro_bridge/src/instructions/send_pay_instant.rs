use crate::*;
use msg_codec::{encode_pay_instant, pad_address, MSG_PAY_INSTANT};
use oapp::endpoint::{state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID};
use tesoro_core::state::{
    PositionState, TesoroAccount, ACCOUNT_SEED, POSITION_SEED as CORE_POSITION_SEED,
};

// Sends `PayInstant` for a recorded Instant Redeem: the units not sent yet, to the EVM address of
// the holder's Account (linked with proof). The vault pays them from its treasury. Permissionless;
// the payer funds the LayerZero fee. `units_sent` moves in the same transaction as the send, so
// each unit is paid once.
#[derive(Accounts)]
#[instruction(params: SendParams)]
pub struct SendPayInstant<'info> {
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
    #[account(
        seeds = [ACCOUNT_SEED, holder_account.authority.as_ref()],
        bump = holder_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub holder_account: Account<'info, TesoroAccount>,
    #[account(
        seeds = [EVM_LINK_SEED, &holder_account.evm_address],
        bump = evm_link.bump,
        constraint = evm_link.account == holder_account.key() @ BridgeError::EvmAddressMismatch
    )]
    pub evm_link: Account<'info, EvmLink>,
    #[account(
        mut,
        seeds = [INSTANT_SEED, holder_account.key().as_ref(), instant_claim.source.as_ref()],
        bump = instant_claim.bump,
        constraint = instant_claim.holder_account == holder_account.key()
            && instant_claim.position == core_position.key() @ BridgeError::InvalidAccount
    )]
    pub instant_claim: Account<'info, InstantClaim>,
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Account<'info, EndpointSettings>,
    pub system_program: Program<'info, System>,
}

impl SendPayInstant<'_> {
    pub fn apply(ctx: &mut Context<SendPayInstant>, params: &SendParams) -> Result<()> {
        let claim = &mut ctx.accounts.instant_claim;
        let pending = claim
            .units_total
            .checked_sub(claim.units_sent)
            .ok_or(BridgeError::AmountOverflow)?;
        require!(pending > 0, BridgeError::NothingToPay);
        let position = &mut ctx.accounts.bridge_position;
        require!(position.opened, BridgeError::NotOpened);
        claim.units_sent = claim.units_total;
        let seq = next_out_seq(position)?;
        // A Position opened before units were normalised holds wei: it is retired, never paid.
        require!(
            ctx.accounts.core_position.inner.decimals == ctx.accounts.peer.core_decimals(),
            BridgeError::LegacyUnits
        );
        // Core's units are 9 decimals; the vault pays in its own base unit, exactly.
        let amount = ctx.accounts.peer.to_vault(pending)?;

        lz_send(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            ctx.remaining_accounts,
            params,
            encode_pay_instant(
                params.eid,
                params.position_id,
                seq,
                pad_address(&ctx.accounts.holder_account.evm_address),
                amount,
            ),
        )?;
        emit!(MessageSent {
            dst_eid: params.eid,
            position_id: params.position_id,
            msg_type: MSG_PAY_INSTANT,
            seq,
            amount,
        });
        Ok(())
    }
}
