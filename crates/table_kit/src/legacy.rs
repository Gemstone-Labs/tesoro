//! Closing the per-Match game records that existed before persistent tables.
//!
//! Devnet state is disposable, so these records are retired, never migrated. The check is by
//! owner, discriminator and exact length only: no field is read, a record of the current length
//! (or of another type) is never closable, and a record delegated to a rollup is owned by the
//! delegation program, so it is refused by owner.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Why a record was not retired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyError {
    /// Not an old record of the exact length, owner and type the retire instruction closes.
    NotLegacy,
    Overflow,
}

/// Moves the rent of `info` to `dest` and hands the account back to the system program.
/// Refused unless `info` is owned by `program_id`, starts with `discriminator` and has one of
/// the exact historical `lengths`. Returns the lamports moved.
pub fn retire_legacy_record<'info>(
    info: &AccountInfo<'info>,
    dest: &AccountInfo<'info>,
    program_id: &Pubkey,
    discriminator: &[u8],
    lengths: &[usize],
) -> core::result::Result<u64, LegacyError> {
    if info.owner != program_id || info.key == dest.key {
        return Err(LegacyError::NotLegacy);
    }
    {
        let data = info.try_borrow_data().map_err(|_| LegacyError::NotLegacy)?;
        if !lengths.contains(&data.len()) || data.len() < 8 || data[..8] != *discriminator {
            return Err(LegacyError::NotLegacy);
        }
    }
    let moved = info.lamports();
    let total = dest
        .lamports()
        .checked_add(moved)
        .ok_or(LegacyError::Overflow)?;
    **dest
        .try_borrow_mut_lamports()
        .map_err(|_| LegacyError::Overflow)? = total;
    **info
        .try_borrow_mut_lamports()
        .map_err(|_| LegacyError::Overflow)? = 0;
    info.assign(&system_program::ID);
    info.resize(0).map_err(|_| LegacyError::Overflow)?;
    Ok(moved)
}
