#![allow(unexpected_cfgs)]
//! A stand-in for the LayerZero endpoint, loaded at the endpoint's id by the bridge's flow tests
//! (`flow_tests.rs`). It accepts `clear` (the receive side) and `send` (the outbound side) without
//! checking anything, returns what the bridge expects from them, and logs each call's instruction
//! data with `sol_log_data` so a test can read the exact message the bridge sent. Never deployed.
use anchor_lang::solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, hash::hash,
    log::sol_log_data, program::set_return_data, program_error::ProgramError, pubkey::Pubkey,
};

entrypoint!(process);

fn process(_program_id: &Pubkey, _accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    sol_log_data(&[data]);
    let disc = data.get(..8).ok_or(ProgramError::InvalidInstructionData)?;
    if disc == &hash(b"global:send").to_bytes()[..8] {
        // MessagingReceipt { guid: [u8; 32], nonce: u64, fee: MessagingFee { native: u64, lz_token: u64 } }
        set_return_data(&[0u8; 56]);
    } else if disc == &hash(b"global:clear").to_bytes()[..8] {
        set_return_data(&[0u8; 32]);
    } else {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}
