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
