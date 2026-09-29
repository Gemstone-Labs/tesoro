use crate::*;

/// Resolves an EVM address to the tesoro_core Account that proved it owns it (an EIP-191
/// signature over the Account key, checked in `link_evm`). Seeds `["evm", evm_address]`.
#[account]
#[derive(InitSpace)]
pub struct EvmLink {
    pub evm_address: [u8; 20],
    /// The `TesoroAccount` PDA.
    pub account: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
}
