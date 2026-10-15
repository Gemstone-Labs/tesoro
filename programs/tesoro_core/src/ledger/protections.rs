//! A Player's Protections (ADR 0011 and CONTEXT.md): rules the Player sets on their own play.
//!
//! One `Protections` value lives in one account per Player Account (`["protections", account]`).
//! It holds the Entry Limit now. `break_until` and `self_exclusion_until` are reserved for Break
//! and Self-Exclusion (unix seconds, zero = none) and are not read by any rule yet; `reserved`
//! keeps the serialized size fixed so those rules can take their bytes without reallocating.
//!
//! All times are unix seconds of the real clock, not the simulated yield clock.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// Length of the period an Entry Limit counts over.
pub const ENTRY_LIMIT_PERIOD_SECS: i64 = 7 * 24 * 60 * 60;
/// Wait before a raised Entry Limit (or removing it) takes effect.
pub const ENTRY_LIMIT_RAISE_WAIT_SECS: i64 = 24 * 60 * 60;
/// Bytes kept free in `Protections` for Break and Self-Exclusion.
pub const PROTECTIONS_RESERVED: usize = 48;

/// The Gemas a Player may enter in one period. Zero is off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, AnchorSerialize, AnchorDeserialize)]
pub struct EntryLimit {
    /// The limit in force, before any due raise (zero = off).
    pub gemas: u64,
    /// A raise waiting for `pending_at` (zero `pending_at` = none). A pending zero means "off".
    pub pending_gemas: u64,
    pub pending_at: i64,
    /// When the current period began (zero = no entry counted yet) and the Gemas entered in it.
    pub window_start: i64,
    pub window_used: u64,
}

fn cap(limit: u64) -> u64 {
    if limit == 0 {
        u64::MAX
    } else {
        limit
    }
}

impl EntryLimit {
    pub const SPACE: usize = 8 + 8 + 8 + 8 + 8;

    /// The limit in force at `now` (zero = off): a pending raise counts once it is due.
    pub fn effective(&self, now: i64) -> u64 {
        if self.pending_at != 0 && now >= self.pending_at {
            self.pending_gemas
        } else {
            self.gemas
        }
    }

    fn settled(&self, now: i64) -> Self {
        let mut s = *self;
        s.gemas = self.effective(now);
        if self.pending_at != 0 && now >= self.pending_at {
            s.pending_gemas = 0;
            s.pending_at = 0;
        }
        s
    }

    /// Gemas entered in the period that contains `now` (zero once that period is over).
    pub fn used(&self, now: i64) -> u64 {
        match self.window_start.checked_add(ENTRY_LIMIT_PERIOD_SECS) {
            Some(end) if self.window_start != 0 && now < end => self.window_used,
            _ => 0,
        }
    }

    /// Lowering applies at once (and drops a pending raise); a raise, including removing the
    /// limit (`gemas` zero), applies `ENTRY_LIMIT_RAISE_WAIT_SECS` later. Setting the pending value
    /// again keeps its timer; setting the value in force cancels the raise.
    pub fn set_limit(&mut self, now: i64, gemas: u64) -> CoreResult<()> {
        let mut next = self.settled(now);
        if next.pending_at != 0 && gemas == next.pending_gemas {
            *self = next;
            return Ok(());
        }
        if cap(gemas) > cap(next.gemas) {
            next.pending_gemas = gemas;
            next.pending_at = now
                .checked_add(ENTRY_LIMIT_RAISE_WAIT_SECS)
                .ok_or(CoreError::Math)?;
        } else {
            next.gemas = gemas;
            next.pending_gemas = 0;
            next.pending_at = 0;
        }
        *self = next;
        Ok(())
    }

    /// Counts an entry of `gemas` at `now`, or refuses it. With no limit in force nothing is counted.
    pub fn record_entry(&mut self, now: i64, gemas: u64) -> CoreResult<()> {
        let mut next = self.settled(now);
        if next.gemas != 0 {
            let period_end = next
                .window_start
                .checked_add(ENTRY_LIMIT_PERIOD_SECS)
                .ok_or(CoreError::Math)?;
            if next.window_start == 0 || now >= period_end {
                next.window_start = now;
                next.window_used = 0;
            }
            let used = next.window_used.checked_add(gemas).ok_or(CoreError::Math)?;
            if used > next.gemas {
                return Err(CoreError::EntryLimitReached);
            }
            next.window_used = used;
        }
        *self = next;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Protections {
    pub entry_limit: EntryLimit,
    /// Reserved for Break: no Match entries until this time.
    pub break_until: i64,
    /// Reserved for Self-Exclusion: no Match entries, Advances or Extends until this time.
    pub self_exclusion_until: i64,
    pub reserved: [u8; PROTECTIONS_RESERVED],
}

impl Default for Protections {
    fn default() -> Self {
        Self {
            entry_limit: EntryLimit::default(),
            break_until: 0,
            self_exclusion_until: 0,
            reserved: [0; PROTECTIONS_RESERVED],
        }
    }
}

impl Protections {
    pub const SPACE: usize = EntryLimit::SPACE + 8 + 8 + PROTECTIONS_RESERVED;
}
