use crate::error::{core_err, TesoroError};
use crate::state::*;
use anchor_lang::prelude::*;

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Whether `signer` may act for the Player `account` on a Match side or Entry Ticket that names
/// `named` as its seat key: the Account's own wallet (the key its address derives from), or the
/// seat key the entry named. A wallet that wanted no seat key names itself, so `named` is then the
/// wallet. Only the single side or Ticket the caller passes is looked at: another Match's seat key
/// is a stranger here. Phase and ownership rules stay with the caller.
pub fn acts_for(account: &Pubkey, signer: &Pubkey, named: &Pubkey) -> bool {
    signer == named
        || Pubkey::find_program_address(&[ACCOUNT_SEED, signer.as_ref()], &crate::ID).0 == *account
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
///
/// Returns the start of the limit period the entry counts in (`None`: nothing counted), so a
/// step-off before departure can release it (`release_entry`).
pub fn count_entry(protections: &AccountInfo, gemas: u64) -> Result<Option<i64>> {
    if protections.owner != &crate::ID || protections.data_is_empty() {
        return Ok(None);
    }
    require!(protections.is_writable, TesoroError::NotWritable);
    let mut data = protections.try_borrow_mut_data()?;
    let mut p = ProtectionsState::try_deserialize(&mut &data[..])?;
    let ts = now()?;
    p.inner.check_play(ts).map_err(core_err)?;
    let period = p
        .inner
        .entry_limit
        .count_entry(ts, gemas)
        .map_err(core_err)?;
    p.try_serialize(&mut &mut data[..])?;
    Ok(period)
}

/// Gives back `gemas` that `count_entry` counted in the period starting at `period_start`, while
/// that period is still the current one. `protections` is the Account's address (checked by the
/// caller's seeds).
pub fn release_entry(protections: &AccountInfo, gemas: u64, period_start: i64) -> Result<()> {
    if protections.owner != &crate::ID || protections.data_is_empty() {
        return Ok(());
    }
    require!(protections.is_writable, TesoroError::NotWritable);
    let mut data = protections.try_borrow_mut_data()?;
    let mut p = ProtectionsState::try_deserialize(&mut &data[..])?;
    p.inner
        .entry_limit
        .release_entry(now()?, gemas, period_start);
    p.try_serialize(&mut &mut data[..])?;
    Ok(())
}

/// [`release_entry`] into `account`'s Protections, an account the caller did not check: it must be
/// this program's Protections of `account` (its recorded owner, or else its address). A count was
/// stored, so the Protections exist; anything else is refused.
pub fn release_entry_of(
    protections: &AccountInfo,
    account: &Pubkey,
    gemas: u64,
    period_start: i64,
) -> Result<()> {
    require_keys_eq!(*protections.owner, crate::ID, TesoroError::InvalidAccount);
    require!(protections.is_writable, TesoroError::NotWritable);
    let mut data = protections.try_borrow_mut_data()?;
    let mut p = ProtectionsState::try_deserialize(&mut &data[..])?;
    // `touch_protections` records the owner when the account is made; an account made before it
    // did is checked by its address
    require!(
        p.account == *account
            || *protections.key
                == Pubkey::find_program_address(&[PROTECTIONS_SEED, account.as_ref()], &crate::ID)
                    .0,
        TesoroError::InvalidAccount
    );
    p.inner
        .entry_limit
        .release_entry(now()?, gemas, period_start);
    p.try_serialize(&mut &mut data[..])?;
    Ok(())
}

/// The Protections of `account` among `infos`: this program's, with the Protections
/// discriminator, recorded for `account` (or, for one made before that was recorded, at its
/// address). [`release_entry_of`] checks it again.
pub fn find_protections<'a, 'info>(
    infos: &'a [AccountInfo<'info>],
    account: &Pubkey,
) -> Option<&'a AccountInfo<'info>> {
    use anchor_lang::Discriminator;
    // discriminator, bump, then the recorded owner
    const OWNER_AT: usize = 8 + 1;
    let is_protections = |i: &AccountInfo| {
        i.owner == &crate::ID
            && i.try_borrow_data().is_ok_and(|d| {
                d.len() >= OWNER_AT + 32 && d[..8] == *ProtectionsState::DISCRIMINATOR
            })
    };
    infos
        .iter()
        .find(|i| {
            is_protections(i)
                && i.try_borrow_data()
                    .is_ok_and(|d| d[OWNER_AT..OWNER_AT + 32] == account.to_bytes())
        })
        .or_else(|| {
            let at =
                Pubkey::find_program_address(&[PROTECTIONS_SEED, account.as_ref()], &crate::ID).0;
            infos.iter().find(|i| i.key == &at && is_protections(i))
        })
}
