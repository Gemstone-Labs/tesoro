use crate::ledger::CoreError;
use anchor_lang::error::AnchorError;
use anchor_lang::prelude::*;

/// Ledger errors surface as `CORE_ERROR_OFFSET + CoreError::code()`.
pub const CORE_ERROR_OFFSET: u32 = 6100;

#[error_code]
pub enum TesoroError {
    #[msg("signer is not authorised")]
    Unauthorized,
    #[msg("game is not registered")]
    GameNotRegistered,
    #[msg("game registry is full")]
    GameRegistryFull,
    #[msg("account does not match")]
    InvalidAccount,
    #[msg("wrong number of remaining accounts")]
    BadRemainingAccounts,
    #[msg("the same account was supplied twice")]
    DuplicateAccount,
    #[msg("account must be writable")]
    NotWritable,
    #[msg("pool is not the canonical sim_lst pool")]
    InvalidPool,
    #[msg("mint is not the sim_lst pool's simSOL mint")]
    InvalidMint,
    #[msg("native Positions are opened and driven only by the native instructions")]
    NativePosition,
    #[msg("position is not a native Position")]
    NotNativePosition,
    #[msg("price is stale or not set")]
    StalePrice,
    #[msg("Gemas of an EVM-sourced Advance are redeemed through the bridge")]
    BridgedSource,
    #[msg("a name is 3 to 20 letters, digits, spaces, dots, underscores or dashes, with no space at either end")]
    InvalidProfileName,
    #[msg("avatar is not one of the available pictures")]
    InvalidAvatar,
    #[msg("the EVM address is not linked to this Account through the bridge")]
    EvmNotLinked,
    #[msg("the leaderboard is not set up")]
    LeaderboardOff,
    #[msg("the treasury cannot pay this instant redeem now")]
    TreasuryShort,
}

pub fn core_err(e: CoreError) -> Error {
    Error::from(AnchorError {
        error_name: e.name().to_string(),
        error_code_number: CORE_ERROR_OFFSET + e.code(),
        error_msg: e.msg().to_string(),
        error_origin: None,
        compared_values: None,
    })
}
