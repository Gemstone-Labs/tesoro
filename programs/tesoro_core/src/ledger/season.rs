//! Leaderboard seasons: weekly, points per won Match, a sliding-scale prize from the pool.
//!
//! Points are not stored per Player on chain. Every won Match emits `MatchWon` (see
//! `instructions::matching`) and sends its Leaderboard Fee to the pool Account, so anyone can
//! recompute a season from the pool's transaction history. The keeper does, and records the top
//! ranks once the season is over (`PrizeSeason`, ticket 06).

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// Monday 2026-10-05 00:00:00 UTC. Season 1 starts here; every season is `SEASON_SECS` long.
pub const SEASON_EPOCH: i64 = 1_791_158_400;
pub const SEASON_SECS: i64 = 7 * 24 * 60 * 60;
/// Ranks that are paid.
pub const PRIZE_PLACES: usize = 10;
/// Share of the pool per rank, in basis points of the pool. Sums to 10,000.
pub const PRIZE_BPS: [u16; PRIZE_PLACES] =
    [2_500, 1_800, 1_300, 1_000, 800, 700, 600, 500, 400, 400];
/// How long after `record_season` ranks may not be paid. Inside it the admin can void a rank.
pub const PAYOUT_WINDOW_SECS: i64 = 48 * 60 * 60;
/// A won Match earns `entry / POINTS_DIVISOR` points: 5, 10 and 25 on the ladder.
pub const POINTS_DIVISOR: u64 = 100;

/// Season number (from 1) that contains `ts`. Times before the epoch belong to no season.
pub fn season_at(ts: i64) -> CoreResult<u32> {
    if ts < SEASON_EPOCH {
        return Err(CoreError::SeasonInvalid);
    }
    let n = (ts - SEASON_EPOCH) / SEASON_SECS + 1;
    u32::try_from(n).map_err(|_| CoreError::Math)
}

/// First second of season `n`.
pub fn season_start(n: u32) -> CoreResult<i64> {
    if n == 0 {
        return Err(CoreError::SeasonInvalid);
    }
    (n as i64 - 1)
        .checked_mul(SEASON_SECS)
        .and_then(|d| d.checked_add(SEASON_EPOCH))
        .ok_or(CoreError::Math)
}

/// First second after season `n` (the start of season `n + 1`).
pub fn season_end(n: u32) -> CoreResult<i64> {
    season_start(n)?
        .checked_add(SEASON_SECS)
        .ok_or(CoreError::Math)
}

pub fn points_for_win(entry: u64) -> u64 {
    entry / POINTS_DIVISOR
}

/// One ranked Player: their Account and the points they finished with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Ranked {
    pub account: Key,
    pub points: u64,
}

/// The payout window of a recorded Season (ADR 0012), kept beside the `Season` so that Seasons
/// recorded before the window existed keep their layout. Created by the same `record_season`.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct SeasonWindow {
    pub number: u32,
    /// Unix seconds `record_season` ran.
    pub recorded_at: i64,
    /// Bit `i` set once rank `i` was voided: it pays nothing and its share stays in the pool.
    pub voided_mask: u16,
}

impl SeasonWindow {
    pub fn new(number: u32, recorded_at: i64) -> Self {
        Self {
            number,
            recorded_at,
            voided_mask: 0,
        }
    }

    /// First second a rank may be paid.
    pub fn opens_at(&self) -> CoreResult<i64> {
        self.recorded_at
            .checked_add(PAYOUT_WINDOW_SECS)
            .ok_or(CoreError::Math)
    }

    pub fn voided(&self, rank: u8) -> bool {
        rank < 16 && self.voided_mask & (1u16 << rank) != 0
    }

    /// Whether rank `rank` of `season` may be paid at `now`: the window has passed and it was
    /// not voided. Slots stay where they are; a voided slot pays nothing, nobody moves up.
    pub fn check_pay(&self, rank: u8, now: i64) -> CoreResult<()> {
        if now < self.opens_at()? {
            return Err(CoreError::PayoutWindowOpen);
        }
        if self.voided(rank) {
            return Err(CoreError::RankVoided);
        }
        Ok(())
    }
}
