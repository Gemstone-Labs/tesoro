//! When a table may be committed to base, and when a commit may be repeated.
//!
//! A table is committed once when a result lands (`on_result` marks it, the game's `dirty` flag
//! gates the first commit). A commit can be lost without the rollup noticing: the transaction
//! succeeds in the rollup but the validator never delivers it to base (a MagicBlock commit outage).
//! The rollup cannot read base's copy of its own delegated table, so it cannot confirm the commit.
//! Instead a commit may be **repeated**, with a growing wait, for as long as the ring still holds
//! a result that may be unconfirmed: a Done slot younger than core's own refund window. Once the
//! keeper frees the slot (core's settlement receipt exists) nothing is left to repeat, and a
//! repeated call costs nothing but a refused transaction. The wait doubles from
//! [`COMMIT_RETRY_SECS`] up to [`COMMIT_RETRY_MAX_SECS`], so a stuck result costs the Sponsor at most
//! one commit fee an hour, and only until core's 24 hour refund.

use crate::{KitError, Ring, SLOT_DONE};
use anchor_lang::prelude::*;

/// The wait before the first repeat of a commit.
pub const COMMIT_RETRY_SECS: i64 = 120;
/// The longest wait between repeats.
pub const COMMIT_RETRY_MAX_SECS: i64 = 3_600;
/// A Done slot older than this is no longer repeated: core refunds the Match by then anyway.
pub const COMMIT_WINDOW_SECS: i64 = 24 * 60 * 60;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug,
)]
pub struct CommitGuard {
    /// Commits sent since the last result landed.
    pub tries: u8,
    /// Rollup time of the latest one.
    pub last_at: i64,
}

impl CommitGuard {
    /// A new result landed: the first commit is owed and the wait starts over.
    pub fn on_result(&mut self) {
        self.tries = 0;
    }

    /// The wait before the next repeat, given the commits sent so far.
    pub fn wait_secs(&self) -> i64 {
        let doublings = u32::from(self.tries.saturating_sub(1)).min(6);
        (COMMIT_RETRY_SECS << doublings).min(COMMIT_RETRY_MAX_SECS)
    }

    /// May the table be committed now? `owed` is the game's own "a result is waiting for its first
    /// commit" flag. Otherwise only a repeat is possible: a young Done slot in the ring and the
    /// wait since the last commit passed.
    pub fn allow(&self, owed: bool, ring: &Ring, now: i64) -> core::result::Result<(), KitError> {
        if owed {
            return Ok(());
        }
        let young = ring.slots.iter().any(|s| {
            s.state == SLOT_DONE
                && s.at
                    .checked_add(COMMIT_WINDOW_SECS)
                    .is_some_and(|end| now < end)
        });
        let due = self
            .last_at
            .checked_add(self.wait_secs())
            .is_some_and(|t| now >= t);
        if young && due {
            Ok(())
        } else {
            Err(KitError::CommitNotDue)
        }
    }

    /// A commit is being sent.
    pub fn record(&mut self, now: i64) {
        self.tries = self.tries.saturating_add(1);
        self.last_at = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OUTCOME_WIN0;

    fn ring_with_result(at: i64) -> Ring {
        let mut r = Ring::default();
        let m = Pubkey::new_from_array([1; 32]);
        let i = r.reserve(m, 0).unwrap();
        r.record(i, &m, 0, OUTCOME_WIN0, at).unwrap();
        r
    }

    #[test]
    fn the_first_commit_is_owed_and_a_repeat_waits_and_backs_off() {
        let ring = ring_with_result(1_000);
        let mut g = CommitGuard::default();
        g.on_result();
        assert!(g.allow(true, &ring, 1_000).is_ok());
        g.record(1_000);
        assert_eq!(g.allow(false, &ring, 1_119), Err(KitError::CommitNotDue));
        assert!(g.allow(false, &ring, 1_120).is_ok());
        g.record(1_120);
        assert_eq!(g.wait_secs(), 240);
        assert_eq!(g.allow(false, &ring, 1_359), Err(KitError::CommitNotDue));
        assert!(g.allow(false, &ring, 1_360).is_ok());
        for _ in 0..20 {
            g.record(1_360);
        }
        assert_eq!(g.wait_secs(), COMMIT_RETRY_MAX_SECS);
    }

    #[test]
    fn nothing_is_repeated_without_a_young_result() {
        let mut g = CommitGuard::default();
        g.record(0);
        // No Done slot (freed, or never written): nothing to repeat however long we wait.
        assert_eq!(
            g.allow(false, &Ring::default(), 1_000_000),
            Err(KitError::CommitNotDue)
        );
        // A result older than core's refund window is left to core.
        let ring = ring_with_result(0);
        assert_eq!(
            g.allow(false, &ring, COMMIT_WINDOW_SECS),
            Err(KitError::CommitNotDue)
        );
        assert!(g.allow(false, &ring, COMMIT_WINDOW_SECS - 1).is_ok());
    }
}
