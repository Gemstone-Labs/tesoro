//! Leaderboard Pool, prize escrow and Season payout (economy upgrade, ticket 06).
//!
//! Pure Rust, like the rest of `ledger`: no accounts, no clocks, no CPIs. Ticket 11 wires the
//! instructions. Three parts:
//!
//! * [`route`]: one vault route's share books (`T`, owed to holders, `pool_owed`, reservations),
//!   the single `spendable` figure, `harvest`, `fund_season_prize`, prize Sources and prize
//!   Redeem. Everything is counted in whole staking-token shares, never in coin amounts, so a
//!   slash can never make the Treasury owe more than it holds.
//! * [`season`]: the Season payout with a budget frozen when the Season is recorded.
//! * this file: the shared words ([`SourceKind`], [`PoolShare`], prize lines).
//!
//! Prize Gemas stay out of `ledger::book`: a prize Source has no classes, no fee counters and no
//! unpaid part. Its lines are fully covered basket lines (`uncovered = 0`) and move with
//! [`prize_move`].

pub mod route;
pub mod season;

#[cfg(test)]
mod tests;

pub use route::*;
pub use season::*;

use super::book::P_ONE;
use super::line_store::{Line, CLASS_GENERAL};
use super::{season_at, CoreError, CoreResult, Key, BPS};
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// What backs a Source's Gemas.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum SourceKind {
    /// Gemas repaid by staking yield (a Position's Advance): the `SourceBook` rules.
    Yield,
    /// Gemas issued against shares held in a prize escrow. Fully covered from the start.
    Prize,
}

impl SourceKind {
    /// Redeem of a Yield Source, fee cash-ins, `harvest`, Instant Redeem and every other path
    /// that is not prize Redeem call this first.
    pub fn require_yield(self) -> CoreResult<()> {
        match self {
            SourceKind::Yield => Ok(()),
            SourceKind::Prize => Err(CoreError::PrizeSourceRefused),
        }
    }
}

/// Default share of the Yield Fee owed to the Pool, in basis points of the fee (founder
/// 2026-10-20: 10% Tesoro + 10% Pool of the 20%).
pub const DEFAULT_POOL_SHARE_BPS: u16 = 5_000;

/// The Pool's share of every realised Yield Fee, changeable only from a Season announced ahead.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct PoolShare {
    pub bps: u16,
    /// First Season the pending change applies to; 0 = none pending.
    pub next_from: u32,
    pub next_bps: u16,
}

impl Default for PoolShare {
    fn default() -> Self {
        Self {
            bps: DEFAULT_POOL_SHARE_BPS,
            next_from: 0,
            next_bps: 0,
        }
    }
}

impl PoolShare {
    /// The share in force during Season `season`.
    pub fn bps_at(&self, season: u32) -> u16 {
        if self.next_from != 0 && season >= self.next_from {
            self.next_bps
        } else {
            self.bps
        }
    }

    /// The share in force at `now`. Before the first Season (a test clock) the standing share
    /// applies.
    pub fn bps_now(&self, now: i64) -> CoreResult<u16> {
        Ok(self.bps_at(season_at(now).unwrap_or(0)))
    }

    /// `set_prize_share`: applies from `from_season`, which must start after the Season `now`
    /// is in (a full Season of notice at the least), so nobody can front-run a change. A
    /// pending change replaces an earlier pending one; one already in force is folded in first.
    pub fn set(&mut self, now: i64, from_season: u32, bps: u16) -> CoreResult<()> {
        if u128::from(bps) > BPS {
            return Err(CoreError::InvalidBps);
        }
        let current = season_at(now)?;
        if from_season <= current {
            return Err(CoreError::PoolShareTooSoon);
        }
        if self.next_from != 0 && self.next_from <= current {
            self.bps = self.next_bps;
        }
        self.next_from = from_season;
        self.next_bps = bps;
        Ok(())
    }
}

/// A fully covered line of a prize Source: every Gema ready, no index to keep up to date.
pub fn prize_line(side: u8, due_at: i64, source: Key, amount: u64) -> Line {
    Line {
        side,
        class: CLASS_GENERAL,
        tranche: 0,
        due_at,
        source,
        amount,
        uncovered: 0,
        p: P_ONE,
        scale: 0,
        epoch: 0,
        ck: 0,
        shares: 0,
        s_snap: Default::default(),
        reserved: [0; 1],
    }
}

/// Moves `k` Gemas between two lines of one prize Source: a Match Pot entry, a payout, a Season
/// prize, and a fee cut (the cut becomes an ordinary, fully ready line of the recipient). Both
/// lines must be ordinary (General class) and fully covered; nothing about a prize line is ever
/// unpaid, so there is no index or ready part to split.
pub fn prize_move(src: &mut Line, dst: &mut Line, k: u64) -> CoreResult<()> {
    if k == 0 {
        return Err(CoreError::ZeroAmount);
    }
    if src.source != dst.source
        || src.class != CLASS_GENERAL
        || dst.class != CLASS_GENERAL
        || src.uncovered != 0
        || dst.uncovered != 0
    {
        return Err(CoreError::SourceMismatch);
    }
    let new_src = src
        .amount
        .checked_sub(k)
        .ok_or(CoreError::InsufficientGemas)?;
    let new_dst = dst.amount.checked_add(k).ok_or(CoreError::Math)?;
    src.amount = new_src;
    dst.amount = new_dst;
    Ok(())
}
