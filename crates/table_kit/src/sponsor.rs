//! Commits paid by a delegated Sponsor PDA.
//!
//! A commit's fee payer that is not delegated is capped at 10 commits per session (devnet,
//! 2026-10-22); a delegated payer gets 25 free commits, then 100,000 lamports each from its
//! rollup balance. So every table Game keeps a delegated Sponsor PDA and commits through it.

use crate::{KitError, DELEGATION_PROGRAM};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

pub const FEE_VAULT_SEED: &[u8] = b"magic-fee-vault";

/// The magic fee vault of `validator`.
pub fn fee_vault_address(validator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[FEE_VAULT_SEED, validator.as_ref()], &DELEGATION_PROGRAM).0
}

/// Commits `table` to base with the Sponsor as the fee payer. The caller has already called
/// `exit` on the table's typed account so that the written bytes are what gets committed.
pub fn sponsor_commit<'info>(
    sponsor: &AccountInfo<'info>,
    sponsor_seeds: &[&[u8]],
    magic_context: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    fee_vault: &AccountInfo<'info>,
    validator: &Pubkey,
    table: &AccountInfo<'info>,
) -> core::result::Result<(), Error> {
    sponsor_commit_many(
        sponsor,
        sponsor_seeds,
        magic_context,
        magic_program,
        fee_vault,
        validator,
        std::slice::from_ref(table),
    )
}

/// Like [`sponsor_commit`] for a game whose public state spans several delegated accounts (a
/// table and its public game body). Only public accounts may be passed: hidden seats are
/// ephemeral and cannot be committed anyway.
pub fn sponsor_commit_many<'info>(
    sponsor: &AccountInfo<'info>,
    sponsor_seeds: &[&[u8]],
    magic_context: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    fee_vault: &AccountInfo<'info>,
    validator: &Pubkey,
    accounts: &[AccountInfo<'info>],
) -> core::result::Result<(), Error> {
    if fee_vault.key != &fee_vault_address(validator) {
        return Err(error!(ErrorCode::ConstraintAddress));
    }
    MagicIntentBundleBuilder::new(
        sponsor.clone(),
        magic_context.clone(),
        magic_program.clone(),
    )
    .magic_fee_vault(fee_vault.clone())
    .commit(accounts)
    .build_and_invoke_signed(&[sponsor_seeds])?;
    Ok(())
}

/// Moves `amount` lamports from a delegated, program-owned `from` to the Sponsor inside the
/// rollup, never taking `from` below `keep`. (A base-layer transfer to a delegated PDA is not
/// seen by the rollup, so this is how a Sponsor is refilled.)
pub fn move_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
    keep: u64,
) -> core::result::Result<(), KitError> {
    let new_from = from
        .lamports()
        .checked_sub(amount)
        .filter(|l| *l >= keep)
        .ok_or(KitError::Overflow)?;
    let new_to = to
        .lamports()
        .checked_add(amount)
        .ok_or(KitError::Overflow)?;
    **from
        .try_borrow_mut_lamports()
        .map_err(|_| KitError::Overflow)? = new_from;
    **to.try_borrow_mut_lamports()
        .map_err(|_| KitError::Overflow)? = new_to;
    Ok(())
}
