use crate::error::{core_err, TesoroError};
use crate::state::*;
use anchor_lang::prelude::*;

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Reads the Protections held at a Player Account's `["protections", account]` address (checked
/// by the caller's seeds). Nothing lives there until the Player sets a Protection: `None`.
fn read_protections(protections: &AccountInfo) -> Result<Option<crate::ledger::Protections>> {
    if protections.owner != &crate::ID || protections.data_is_empty() {
        return Ok(None);
    }
    let data = protections.try_borrow_data()?;
    Ok(Some(
        ProtectionsState::try_deserialize(&mut &data[..])?.inner,
    ))
}

/// Refuses while the Account is on a Break or Self-Excluded (Match entries, Requests, Offers,
/// being backed).
pub fn require_can_play(protections: &AccountInfo) -> Result<()> {
    match read_protections(protections)? {
        Some(p) => p.check_play(now()?).map_err(core_err),
        None => Ok(()),
    }
}

/// Refuses while the Account is Self-Excluded (new Advances and Extends).
pub fn require_can_advance(protections: &AccountInfo) -> Result<()> {
    match read_protections(protections)? {
        Some(p) => p.check_advance(now()?).map_err(core_err),
        None => Ok(()),
    }
}

/// True while the Account is on a Break or Self-Excluded.
pub fn is_away(protections: &AccountInfo) -> Result<bool> {
    Ok(match read_protections(protections)? {
        Some(p) => p.away(now()?),
        None => false,
    })
}

/// Counts `gemas` of the Player Account being put at risk: refused during a Break or
/// Self-Exclusion, else against its Entry Limit. `protections` is the Account's
/// `["protections", account]` address (checked by the caller's seeds); when nothing lives there the
/// Player set no Protection and nothing is counted.
pub fn count_entry(protections: &AccountInfo, gemas: u64) -> Result<()> {
    if protections.owner != &crate::ID || protections.data_is_empty() {
        return Ok(());
    }
    require!(protections.is_writable, TesoroError::NotWritable);
    let mut data = protections.try_borrow_mut_data()?;
    let mut p = ProtectionsState::try_deserialize(&mut &data[..])?;
    let ts = now()?;
    p.inner.check_play(ts).map_err(core_err)?;
    p.inner
        .entry_limit
        .record_entry(ts, gemas)
        .map_err(core_err)?;
    p.try_serialize(&mut &mut data[..])?;
    Ok(())
}
