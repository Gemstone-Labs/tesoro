//! The persistent-table protocol, shared by every table Game (Trading Duel, Hold'em, Vanguard,
//! Block Burst Live). A Game keeps its own Table body and rules; this crate holds the parts whose
//! mistakes cost money, so that they are written, reviewed and tested once.
//!
//! * [`Ring`]: where a finished Match's result waits until `tesoro_core` has frozen the Match.
//! * [`receipt_at`], [`match_state_gone`]: the only evidence that frees a ring slot.
//! * [`read_table`]: how base-layer code reads a table that MagicBlock still holds.
//! * [`sponsor_commit`]: the commit, paid by a delegated Sponsor PDA.
//! * [`CommitGuard`]: when a commit is owed and when a lost one may be repeated.
//! * [`open_private_seat`], [`close_private_seat`]: hidden seat data in ephemeral accounts.
//!
//! The protocol is described in `.scratch/economy-upgrade` notes `table-protocol.md`.

pub mod commit;
pub mod ring;
pub mod seat;
pub mod sponsor;
pub mod untabled;

use anchor_lang::prelude::*;
pub use commit::*;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
pub use ring::*;
pub use seat::*;
pub use sponsor::*;
use tesoro_core::state::{SettlementReceipt, RECEIPT_SEED};
pub use untabled::*;

/// The MagicBlock delegation program: the owner of a delegated account.
pub const DELEGATION_PROGRAM: Pubkey = ephemeral_rollups_sdk::cpi::DELEGATION_PROGRAM_ID;

pub fn magic_program() -> Pubkey {
    MAGIC_PROGRAM_ID
}

/// What a table protocol check refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KitError {
    /// Every ring slot holds a Match whose result core has not yet confirmed.
    RingFull,
    /// The Match already has a ring slot.
    RingDuplicate,
    /// The slot is not in the state the call needs, or names another Match or epoch.
    RingSlot,
    /// The table account is not the expected PDA, not owned by this program or the delegation
    /// program, or does not decode.
    BadTable,
    /// The fee vault is not the TEE validator's.
    BadFeeVault,
    Overflow,
    /// No first commit is owed and no repeat is due (nothing unconfirmed, or the wait has not passed).
    CommitNotDue,
}

/// The settlement receipt `tesoro_core` writes when a Match enters Settling or Refunding, as
/// proof that the outcome is frozen. Returns the time the receipt was written, or `None` for
/// anything that is not exactly that receipt (missing, empty, foreign owner, wrong address,
/// malformed, another Match): a slot is never freed on a doubtful read.
pub fn receipt_at(receipt: &AccountInfo, match_key: &Pubkey) -> Option<i64> {
    let (expected, _) =
        Pubkey::find_program_address(&[RECEIPT_SEED, match_key.as_ref()], &tesoro_core::ID);
    if receipt.key != &expected || receipt.owner != &tesoro_core::ID {
        return None;
    }
    let data = receipt.try_borrow_data().ok()?;
    let parsed = SettlementReceipt::try_deserialize(&mut &data[..]).ok()?;
    (parsed.match_key == *match_key).then_some(parsed.receipt.at)
}

/// The core Match account reads as gone: system-owned, no lamports, no data. A Match account
/// closes only after the Match is Closed, and Match ids never repeat.
pub fn match_state_gone(state: &AccountInfo, match_key: &Pubkey) -> bool {
    state.key == match_key
        && state.owner == &anchor_lang::system_program::ID
        && state.lamports() == 0
        && state.data_is_empty()
}

/// Reads a table at `expected` for base-layer code: the account must sit at the Game's PDA, be
/// owned by the delegation program (delegated, the normal case) or by `program_id` (if ever
/// undelegated), and decode as `T` with its discriminator.
pub fn read_table<T: AccountDeserialize>(
    info: &AccountInfo,
    expected: &Pubkey,
    program_id: &Pubkey,
) -> core::result::Result<T, KitError> {
    if info.key != expected || (info.owner != &DELEGATION_PROGRAM && info.owner != program_id) {
        return Err(KitError::BadTable);
    }
    let data = info.try_borrow_data().map_err(|_| KitError::BadTable)?;
    T::try_deserialize(&mut &data[..]).map_err(|_| KitError::BadTable)
}
