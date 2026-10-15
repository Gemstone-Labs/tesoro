//! A Player's Protections (ADR 0011 and CONTEXT.md): rules the Player sets on their own play.
//!
//! One `Protections` value lives in one account per Player Account (`["protections", account]`).
//! It holds the Entry Limit, the end of a Break and the end of a Self-Exclusion (unix seconds,
//! zero = none); `reserved` keeps the serialized size fixed for later rules.
//!
//! All times are unix seconds of the real clock, not the simulated yield clock.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// Length of the period an Entry Limit counts over.
pub const ENTRY_LIMIT_PERIOD_SECS: i64 = 7 * 24 * 60 * 60;
/// Wait before a raised Entry Limit (or removing it) takes effect.
pub const ENTRY_LIMIT_RAISE_WAIT_SECS: i64 = 24 * 60 * 60;
/// Bytes kept free in `Protections` for later rules.
pub const PROTECTIONS_RESERVED: usize = 48;
pub const BREAK_MAX_DAYS: u16 = 42;
pub const SELF_EXCLUSION_MIN_MONTHS: u16 = 6;
/// Longest Self-Exclusion one call can set (5 years); a later call can extend it.
pub const SELF_EXCLUSION_MAX_MONTHS: u16 = 60;
pub const DAY_SECS: i64 = 24 * 60 * 60;
/// A Self-Exclusion month is 30 days.
pub const MONTH_SECS: i64 = 30 * DAY_SECS;

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
    /// A Break: no Match entries, Requests, Offers or being backed until this time.
    pub break_until: i64,
    /// A Self-Exclusion: all of a Break, plus no Advances or Extends, until this time.
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

    pub fn on_break(&self, now: i64) -> bool {
        now < self.break_until
    }

    pub fn self_excluded(&self, now: i64) -> bool {
        now < self.self_exclusion_until
    }

    /// Refuses Match entries, Requests, Offers and being backed during a Break or Self-Exclusion.
    pub fn check_play(&self, now: i64) -> CoreResult<()> {
        if self.self_excluded(now) {
            return Err(CoreError::SelfExcluded);
        }
        if self.on_break(now) {
            return Err(CoreError::OnBreak);
        }
        Ok(())
    }

    /// Refuses new Advances and Extends during a Self-Exclusion. A Break leaves them open.
    pub fn check_advance(&self, now: i64) -> CoreResult<()> {
        if self.self_excluded(now) {
            return Err(CoreError::SelfExcluded);
        }
        Ok(())
    }

    /// True while a Break or Self-Exclusion is in force (what clean-up looks at).
    pub fn away(&self, now: i64) -> bool {
        self.on_break(now) || self.self_excluded(now)
    }

    fn lengthen(current: i64, now: i64, secs: i64) -> CoreResult<i64> {
        let end = now.checked_add(secs).ok_or(CoreError::Math)?;
        if end < current {
            return Err(CoreError::ProtectionCannotShorten);
        }
        Ok(end)
    }

    /// Starts a Break of `days` from `now`, or extends the one running. Never ends it earlier.
    pub fn set_break(&mut self, now: i64, days: u16) -> CoreResult<()> {
        if days == 0 || days > BREAK_MAX_DAYS {
            return Err(CoreError::InvalidBreak);
        }
        self.break_until = Self::lengthen(self.break_until, now, i64::from(days) * DAY_SECS)?;
        Ok(())
    }

    /// Starts a Self-Exclusion of `months` (30 days each) from `now`, or extends the one running.
    pub fn set_self_exclusion(&mut self, now: i64, months: u16) -> CoreResult<()> {
        if !(SELF_EXCLUSION_MIN_MONTHS..=SELF_EXCLUSION_MAX_MONTHS).contains(&months) {
            return Err(CoreError::InvalidSelfExclusion);
        }
        self.self_exclusion_until = Self::lengthen(
            self.self_exclusion_until,
            now,
            i64::from(months) * MONTH_SECS,
        )?;
        Ok(())
    }
}
