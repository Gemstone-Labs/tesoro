//! Lazy table cleaning. `begin_match` cleans the table it is about to use, so no keeper has to:
//! it resets a finished table, frees ring slots whose receipts the caller passes, and voids a
//! table stuck on a Match that `tesoro_core` already froze. The caller pays.
//!
//! Receipts arrive as the instruction's remaining accounts, in any order. Each is trusted only
//! through [`receipt_at`], and only once it is `delay` old.

use crate::{receipt_at, Ring, Slot, RING_LEN, SLOT_DONE};
use anchor_lang::prelude::*;

/// Is one of `accounts` the settlement receipt of `match_key`, written at least `delay` seconds ago?
pub fn receipt_aged(accounts: &[AccountInfo], match_key: &Pubkey, now: i64, delay: i64) -> bool {
    accounts
        .iter()
        .filter_map(|r| receipt_at(r, match_key))
        .any(|at| at.checked_add(delay).is_some_and(|due| now >= due))
}

/// The ticket 24 rule: once a Match settles, the next one is assigned at the table's epoch plus
/// one, before anyone resets the table. A finished table is reset for exactly that Assignment.
pub fn is_next_epoch(table_epoch: u64, assign_epoch: u64) -> bool {
    table_epoch.checked_add(1) == Some(assign_epoch)
}

impl Ring {
    /// Frees every Done slot whose Match has a receipt among `accounts` that is `delay` old.
    /// Returns how many it freed.
    pub fn free_proven(&mut self, accounts: &[AccountInfo], now: i64, delay: i64) -> usize {
        let mut freed = 0;
        for i in 0..RING_LEN {
            let slot = self.slots[i];
            if slot.state == SLOT_DONE && receipt_aged(accounts, &slot.match_key, now, delay) {
                self.slots[i] = Slot::default();
                freed += 1;
            }
        }
        freed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_very_next_epoch_follows() {
        assert!(is_next_epoch(4, 5));
        assert!(!is_next_epoch(4, 4));
        assert!(!is_next_epoch(4, 6));
        assert!(!is_next_epoch(5, 4));
        assert!(!is_next_epoch(u64::MAX, 0));
    }

    #[test]
    fn no_receipts_free_nothing() {
        let mut r = Ring::default();
        for n in 0..RING_LEN as u8 {
            let i = r.reserve(Pubkey::new_from_array([n + 1; 32]), 0).unwrap();
            r.record(i, &Pubkey::new_from_array([n + 1; 32]), 0, 1, 0)
                .unwrap();
        }
        let before = r;
        assert_eq!(r.free_proven(&[], 1_000_000, 60), 0);
        assert_eq!(r, before);
    }
}
