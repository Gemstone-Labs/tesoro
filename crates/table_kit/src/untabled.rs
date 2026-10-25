//! Fast refunds for a Match that never gets a table or never begins (ticket 35).
//!
//! * A joined Match no Assignment names, after [`TABLE_WAIT_SECS`], is refunded by its Game.
//!   `tesoro_core` records no join time, so it is derived: `join` sets
//!   `deadline = min(joined_at + MATCH_TIMEOUT_SECS, deadline_abs)` and only a Game's
//!   `assign_match` ever moves it (the same instruction that creates the Assignment).
//! * An Assignment whose start window passed with its table still Idle at its epoch can never
//!   begin; `skip_epoch` writes a Draw into the ring so the Match refunds from a committed result.

use crate::Ring;
use crate::{KitError, OUTCOME_DRAW};
use anchor_lang::prelude::*;
use tesoro_core::ledger::MATCH_TIMEOUT_SECS;

/// How long a joined Match waits for a table before its Game refunds it.
pub const TABLE_WAIT_SECS: i64 = 300;

/// When a joined Match with no Assignment joined, or `None` when the deadline was clamped to the
/// absolute deadline (then it is not derivable and core's own deadline is near anyway).
pub fn untabled_since(deadline: i64, deadline_abs: i64) -> Option<i64> {
    if deadline >= deadline_abs {
        return None;
    }
    deadline.checked_sub(MATCH_TIMEOUT_SECS)
}

/// A joined Match no Assignment names has waited for a table long enough.
pub fn table_wait_over(deadline: i64, deadline_abs: i64, now: i64) -> bool {
    untabled_since(deadline, deadline_abs)
        .and_then(|t| t.checked_add(TABLE_WAIT_SECS))
        .is_some_and(|due| now >= due)
}

/// The Assignment address holds nothing: system-owned and empty. Lamports are not checked, since
/// anyone may send one to an address, and `init` still works on a pre-funded address.
pub fn assignment_absent(info: &AccountInfo, expected: &Pubkey) -> bool {
    info.key == expected && info.owner == &anchor_lang::system_program::ID && info.data_is_empty()
}

/// May an Assignment's Match be given up on its table? Only a table Idle at exactly the
/// Assignment's epoch, once `begin_match` can no longer accept it (it needs `now <= start_deadline`).
pub fn may_skip(
    idle: bool,
    table_epoch: u64,
    assign_epoch: u64,
    start_deadline: i64,
    now: i64,
) -> bool {
    idle && table_epoch == assign_epoch && now > start_deadline
}

impl Ring {
    /// Records a Draw for a Match that never began: reserve, then record, in one step.
    pub fn record_never_begun(
        &mut self,
        match_key: Pubkey,
        epoch: u64,
        now: i64,
    ) -> core::result::Result<u8, KitError> {
        let i = self.reserve(match_key, epoch)?;
        self.record(i, &match_key, epoch, OUTCOME_DRAW, now)?;
        Ok(i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SLOT_DONE, SLOT_RESERVED};

    #[test]
    fn join_time_is_the_deadline_less_the_core_timeout() {
        let joined = 10_000;
        let deadline = joined + MATCH_TIMEOUT_SECS;
        assert_eq!(untabled_since(deadline, deadline + 1), Some(joined));
        assert!(!table_wait_over(
            deadline,
            deadline + 1,
            joined + TABLE_WAIT_SECS - 1
        ));
        assert!(table_wait_over(
            deadline,
            deadline + 1,
            joined + TABLE_WAIT_SECS
        ));
    }

    #[test]
    fn a_clamped_deadline_gives_no_join_time() {
        assert_eq!(untabled_since(5_000, 5_000), None);
        assert!(!table_wait_over(5_000, 5_000, i64::MAX));
    }

    #[test]
    fn skip_needs_idle_the_same_epoch_and_a_closed_window() {
        assert!(may_skip(true, 4, 4, 100, 101));
        assert!(!may_skip(true, 4, 4, 100, 100));
        assert!(!may_skip(false, 4, 4, 100, 101));
        assert!(!may_skip(true, 5, 4, 100, 101));
        assert!(!may_skip(true, 3, 4, 100, 101));
    }

    #[test]
    fn a_never_begun_match_is_recorded_once() {
        let mut r = Ring::default();
        let m = Pubkey::new_from_array([7; 32]);
        let i = r.record_never_begun(m, 2, 50).unwrap();
        assert_eq!(r.slots[i as usize].state, SLOT_DONE);
        assert_eq!(r.slots[i as usize].outcome, OUTCOME_DRAW);
        assert_eq!(r.record_never_begun(m, 2, 51), Err(KitError::RingDuplicate));
        // a full ring refuses and leaves it unchanged
        let mut full = Ring::default();
        for n in 0..crate::RING_LEN as u8 {
            full.reserve(Pubkey::new_from_array([n + 10; 32]), 0)
                .unwrap();
        }
        let before = full;
        assert_eq!(full.record_never_begun(m, 2, 1), Err(KitError::RingFull));
        assert_eq!(full, before);
        let _ = SLOT_RESERVED;
    }

    #[test]
    fn an_assignment_address_with_a_lamport_still_counts_as_absent() {
        let key = Pubkey::new_unique();
        let mut lamports = 1u64;
        let mut data: [u8; 0] = [];
        let sys = anchor_lang::system_program::ID;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &sys, false, 0);
        assert!(assignment_absent(&info, &key));
        assert!(!assignment_absent(&info, &Pubkey::new_unique()));
    }
}
