//! A Player's Extend Limit: how often and how far Extend may be used (ADR 0009).
//!
//! All times are unix seconds of the real clock, not the simulated yield clock.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// Months Extend may add in one period until the Player sets their own limit.
pub const DEFAULT_EXTEND_LIMIT: u8 = 3;
/// Highest limit a Player can set.
pub const MAX_EXTEND_LIMIT: u8 = 11;
/// Wait between two Extends of one Player, and before a raised limit takes effect.
pub const EXTEND_WAIT_SECS: i64 = 24 * 60 * 60;
/// Length of the period the limit counts over.
pub const EXTEND_PERIOD_SECS: i64 = 30 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct ExtendLimit {
    /// The limit in force, before any due raise.
    pub months: u8,
    /// A raise waiting for `pending_at` (zero = none).
    pub pending_months: u8,
    pub pending_at: i64,
    /// When the current period began (zero = no Extend yet) and the months added in it.
    pub window_start: i64,
    pub window_months: u8,
    pub last_extend_at: i64,
}

impl Default for ExtendLimit {
    fn default() -> Self {
        Self {
            months: DEFAULT_EXTEND_LIMIT,
            pending_months: 0,
            pending_at: 0,
            window_start: 0,
            window_months: 0,
            last_extend_at: 0,
        }
    }
}

impl ExtendLimit {
    /// Serialized size of the struct.
    pub const SPACE: usize = 1 + 1 + 8 + 8 + 1 + 8;

    /// The limit in force at `now`: a pending raise counts once it is due.
    pub fn effective(&self, now: i64) -> u8 {
        if self.pending_at != 0 && now >= self.pending_at {
            self.pending_months
        } else {
            self.months
        }
    }

    fn settled(&self, now: i64) -> Self {
        let mut s = *self;
        s.months = self.effective(now);
        if self.pending_at != 0 && now >= self.pending_at {
            s.pending_months = 0;
            s.pending_at = 0;
        }
        s
    }

    /// Lowering applies at once (and drops a pending raise); a raise applies `EXTEND_WAIT_SECS` later.
    /// Setting the pending value again keeps its timer; setting the value in force cancels the raise.
    pub fn set_limit(&mut self, now: i64, months: u8) -> CoreResult<()> {
        if months > MAX_EXTEND_LIMIT {
            return Err(CoreError::InvalidExtendLimit);
        }
        let mut next = self.settled(now);
        if next.pending_at != 0 && months == next.pending_months {
            *self = next;
            return Ok(());
        }
        if months > next.months {
            next.pending_months = months;
            next.pending_at = now.checked_add(EXTEND_WAIT_SECS).ok_or(CoreError::Math)?;
        } else {
            next.months = months;
            next.pending_months = 0;
            next.pending_at = 0;
        }
        *self = next;
        Ok(())
    }

    /// Counts an Extend of `extra_months` at `now`, or refuses it.
    pub fn record_extend(&mut self, now: i64, extra_months: u8) -> CoreResult<()> {
        let mut next = self.settled(now);
        let ready = next
            .last_extend_at
            .checked_add(EXTEND_WAIT_SECS)
            .ok_or(CoreError::Math)?;
        if next.last_extend_at != 0 && now < ready {
            return Err(CoreError::ExtendCoolingDown);
        }
        let period_end = next
            .window_start
            .checked_add(EXTEND_PERIOD_SECS)
            .ok_or(CoreError::Math)?;
        if next.window_start == 0 || now >= period_end {
            next.window_start = now;
            next.window_months = 0;
        }
        let used = next
            .window_months
            .checked_add(extra_months)
            .ok_or(CoreError::Math)?;
        if used > next.months {
            return Err(CoreError::ExtendLimitReached);
        }
        next.window_months = used;
        next.last_extend_at = now;
        *self = next;
        Ok(())
    }
}
