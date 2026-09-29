use crate::*;

#[account]
#[derive(InitSpace)]
pub struct Store {
    pub admin: Pubkey,
    pub endpoint_program: Pubkey,
    pub bump: u8,
}

// The Executor derives this PDA with the exact seed `LzReceiveTypes`.
#[account]
#[derive(InitSpace)]
pub struct LzReceiveTypesAccounts {
    pub store: Pubkey,
    pub alt: Pubkey,
    pub bump: u8,
}
