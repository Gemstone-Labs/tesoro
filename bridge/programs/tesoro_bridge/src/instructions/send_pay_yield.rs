use crate::*;
use msg_codec::{encode_pay_yield, pad_address, YieldPayment, MSG_PAY_YIELD};
use oapp::endpoint::{state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID};
use tesoro_core::state::{
    PositionState, TesoroAccount, ACCOUNT_SEED, POSITION_SEED as CORE_POSITION_SEED,
};

// Sends `PayYield` for a recorded redemption claim: the units redeemed through `redeem_to_evm`
// that have not been sent yet, to the EVM address of the holder's Account (which must be linked
// with proof). A claim of the Treasury Account (`redeem_treasury_to_evm`) is paid to the vault's
// own address, which the vault books into its treasury. Permissionless; the payer funds the
// LayerZero fee. `claim.units_sent` moves in the same transaction as the send, so each redeemed
// unit is paid once.
#[derive(Accounts)]
#[instruction(params: SendParams)]
pub struct SendPayYield<'info> {
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
    /// The holder's proof of their EVM address; absent for the Treasury Account, which is paid
    /// into the vault's own treasury.
    #[account(
        seeds = [EVM_LINK_SEED, &holder_account.evm_address],
        bump = evm_link.bump,
        constraint = evm_link.account == holder_account.key() @ BridgeError::EvmAddressMismatch
    )]
    pub evm_link: Option<Account<'info, EvmLink>>,
    #[account(
        mut,
        seeds = [CLAIM_SEED, holder_account.key().as_ref(), claim.source.as_ref()],
        bump = claim.bump,
        constraint = claim.holder_account == holder_account.key()
            && claim.position == core_position.key() @ BridgeError::InvalidAccount
    )]
    pub claim: Account<'info, Claim>,
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Account<'info, EndpointSettings>,
    pub system_program: Program<'info, System>,
}

impl SendPayYield<'_> {
    pub fn apply(ctx: &mut Context<SendPayYield>, params: &SendParams) -> Result<()> {
        let claim = &mut ctx.accounts.claim;
        let pending = claim
            .units_total
            .checked_sub(claim.units_sent)
            .ok_or(BridgeError::AmountOverflow)?;
        require!(pending > 0, BridgeError::NothingToPay);
        let position = &mut ctx.accounts.bridge_position;
        require!(position.opened, BridgeError::NotOpened);
        let holder = &ctx.accounts.holder_account;
        let to = if holder.key() == core_treasury_account() {
            vault_of(&params.position_id)
        } else {
            require!(ctx.accounts.evm_link.is_some(), BridgeError::EvmAddressMismatch);
            pad_address(&holder.evm_address)
        };
        let fee = claim.fee_total.checked_sub(claim.fee_sent).ok_or(BridgeError::AmountOverflow)?;
        let pool = claim
            .pool_total
            .checked_sub(claim.pool_sent)
            .ok_or(BridgeError::AmountOverflow)?;
        claim.units_sent = claim.units_total;
        claim.fee_sent = claim.fee_total;
        claim.pool_sent = claim.pool_total;
        let seq = next_out_seq(position)?;
        let pay = YieldPayment { amount: pending as u128, fee: fee as u128, pool: pool as u128 };

        lz_send(
            &ctx.accounts.store,
            &ctx.accounts.peer,
            ctx.remaining_accounts,
            params,
            encode_pay_yield(params.eid, params.position_id, seq, to, pay),
        )?;
        emit!(MessageSent {
            dst_eid: params.eid,
            position_id: params.position_id,
            msg_type: MSG_PAY_YIELD,
            seq,
            amount: pending as u128,
        });
        Ok(())
    }
}
