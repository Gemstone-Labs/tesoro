use crate::*;
use tesoro_core::state::{TesoroAccount, ACCOUNT_SEED};

// Links an EVM address to the caller's Tesoro Account. Two proofs: the Account's stored
// `evm_address` (set by its authority in tesoro_core) must match, and the EVM wallet must have
// signed `evm_sig::link_message(account)` (EIP-191), so nobody can claim someone else's address
// and receive their Positions or payouts.
#[derive(Accounts)]
#[instruction(params: LinkEvmParams)]
pub struct LinkEvm<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ACCOUNT_SEED, authority.key().as_ref()],
        bump = owner_account.bump,
        seeds::program = tesoro_core::ID
    )]
    pub owner_account: Account<'info, TesoroAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + EvmLink::INIT_SPACE,
        seeds = [EVM_LINK_SEED, &params.evm_address],
        bump
    )]
    pub evm_link: Account<'info, EvmLink>,
    pub system_program: Program<'info, System>,
}

impl LinkEvm<'_> {
    pub fn apply(ctx: &mut Context<LinkEvm>, params: &LinkEvmParams) -> Result<()> {
        let account_key = ctx.accounts.owner_account.key();
        require!(
            ctx.accounts.owner_account.evm_address == params.evm_address,
            BridgeError::EvmAddressMismatch
        );
        let message = evm_sig::link_message(&account_key);
        let signer = evm_sig::recover_address(message.as_bytes(), &params.signature);
        require!(signer == Some(params.evm_address), BridgeError::InvalidEvmSignature);

        let link = &mut ctx.accounts.evm_link;
        link.evm_address = params.evm_address;
        link.account = account_key;
        link.authority = ctx.accounts.authority.key();
        link.bump = ctx.bumps.evm_link;
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LinkEvmParams {
    pub evm_address: [u8; 20],
    /// EIP-191 `personal_sign` signature (`r | s | v`) of `evm_sig::link_message(account)`.
    pub signature: [u8; 65],
}
