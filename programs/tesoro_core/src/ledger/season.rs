//! Leaderboard seasons: weekly, points per won Match, a sliding-scale prize from the pool.
//!
//! Points are not stored per Player on chain. Every won Match emits `MatchWon` (see
//! `instructions::matching`) and sends its Leaderboard Fee to the pool Account, so anyone can
//! recompute a season from the pool's transaction history. The keeper does, and records the top
//! ranks in a `Season` once the season is over; `Season::pay` then moves the prizes exactly.

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

/// What a finished season pays, fixed when it is recorded.
#[derive(Clone, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct Season {
    pub number: u32,
    /// Gemas in the pool when the season was recorded; prizes are shares of this.
    pub pool_total: u64,
    /// Ranked Players (at most `PRIZE_PLACES`).
    pub count: u8,
    pub winners: [Key; PRIZE_PLACES],
    pub points: [u64; PRIZE_PLACES],
    pub amounts: [u64; PRIZE_PLACES],
    /// Bit `i` set once rank `i` was paid.
    pub paid_mask: u16,
}

impl Season {
    /// Records the ranking of a season that has ended. Ranks must be distinct Accounts with
    /// points above zero, in non-increasing order (ties are broken by the caller's rule, see
    /// docs/adr/0006-leaderboard-pool.md). Unfilled ranks pay nothing, so their shares stay in
    /// the pool for the next season.
    pub fn record(number: u32, now: i64, pool_total: u64, ranking: &[Ranked]) -> CoreResult<Self> {
        if now < season_end(number)? {
            return Err(CoreError::SeasonNotEnded);
        }
        if ranking.len() > PRIZE_PLACES {
            return Err(CoreError::SeasonInvalid);
        }
        for (i, r) in ranking.iter().enumerate() {
            if r.points == 0 || (i > 0 && r.points > ranking[i - 1].points) {
                return Err(CoreError::SeasonInvalid);
            }
            if ranking[..i].iter().any(|o| o.account == r.account) {
                return Err(CoreError::SeasonInvalid);
            }
        }
        let mut s = Self {
            number,
            pool_total,
            count: ranking.len() as u8,
            winners: [[0; 32]; PRIZE_PLACES],
            points: [0; PRIZE_PLACES],
            amounts: [0; PRIZE_PLACES],
            paid_mask: 0,
        };
        for (i, r) in ranking.iter().enumerate() {
            s.winners[i] = r.account;
            s.points[i] = r.points;
            s.amounts[i] = to_u64(mul_div_floor(
                pool_total as u128,
                PRIZE_BPS[i] as u128,
                BPS,
            )?)?;
        }
        Ok(s)
    }

    /// Marks rank `rank` paid and returns its amount. Once per rank.
    pub fn pay(&mut self, rank: u8) -> CoreResult<u64> {
        if rank >= self.count {
            return Err(CoreError::SeasonInvalid);
        }
        let bit = 1u16 << rank;
        if self.paid_mask & bit != 0 {
            return Err(CoreError::AlreadyPaid);
        }
        self.paid_mask |= bit;
        Ok(self.amounts[rank as usize])
    }

    pub fn paid(&self, rank: u8) -> bool {
        self.paid_mask & (1u16 << rank) != 0
    }
}

/// The payout window of a recorded Season (ADR 0011), kept beside the `Season` so that Seasons
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

    /// Voids rank `rank` of `season`: only inside the window, only while unpaid, once.
    pub fn void(&mut self, season: &Season, rank: u8, now: i64) -> CoreResult<()> {
        if rank >= season.count {
            return Err(CoreError::SeasonInvalid);
        }
        if now >= self.opens_at()? {
            return Err(CoreError::PayoutWindowClosed);
        }
        if season.paid(rank) {
            return Err(CoreError::AlreadyPaid);
        }
        if self.voided(rank) {
            return Err(CoreError::RankVoided);
        }
        self.voided_mask |= 1u16 << rank;
        Ok(())
    }
}

/// Splits `amount` over the pool's Holdings in the canonical order: ascending by Source, each
/// drained completely, the last one partly. `holdings` must be that prefix of the pool's
/// non-empty Holdings in strict order, and together hold exactly `amount`.
pub fn plan_prize(holdings: &[Holding], amount: u64) -> CoreResult<Vec<u64>> {
    let mut left = amount;
    let mut out = Vec::with_capacity(holdings.len());
    for (i, h) in holdings.iter().enumerate() {
        if i > 0 && holdings[i - 1].source >= h.source {
            return Err(CoreError::NonCanonicalPrize);
        }
        let free = h.free();
        if free == 0 || left == 0 {
            return Err(CoreError::NonCanonicalPrize);
        }
        let take = free.min(left);
        out.push(take);
        left -= take;
    }
    if left != 0 {
        return Err(CoreError::PrizeShortfall);
    }
    Ok(out)
}
