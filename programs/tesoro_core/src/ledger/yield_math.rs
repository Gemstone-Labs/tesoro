//! Accrued Yield computed on the spot (ADR 0010): nothing here is recorded by a crank.
//!
//! * `growth_since_open` is the single place the network matters. Devnet:
//!   `1 + APY * (now - opened_at) * speedup / YEAR`. Mainnet will return
//!   `Staking Rate now / Staking Rate at open` through the same [`Growth`] ratio.
//! * `Accrued Yield = Principal * (growth - 1)`, then the Yield Fee splits it.
//! * Debt and redeemable are derived from the net Accrued Yield counted toward a Source, so they
//!   equal what the stored `Source.yield_units` would have been after a crank.
//! * The Treasury claim comes from pool totals that change only when a Position opens or unlocks.

use super::*;
use anchor_lang::prelude::{borsh, AnchorDeserialize, AnchorSerialize};

/// Seconds in a year, as in sim_lst.
pub const YEAR_SECS: u128 = 31_536_000;
/// Devnet speed-up: one month of yield in ten minutes.
pub const DEVNET_SPEEDUP: u32 = 4_380;

/// Growth since a Position opened, as the exact ratio `num / den` (at least 1 for devnet).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Growth {
    pub num: u128,
    pub den: u128,
}

/// Devnet growth since open: `1 + apy * elapsed * speedup / YEAR` with `elapsed = now - opened_at`
/// (zero when `now` is before the open). Exact as `(BPS*YEAR + apy*elapsed*speedup) / (BPS*YEAR)`,
/// so `Principal * (growth - 1)` floors to sim_lst's `yield_units`.
pub fn growth_since_open(
    apy_bps: u16,
    opened_at: i64,
    now: i64,
    speedup: u32,
) -> CoreResult<Growth> {
    let elapsed =
        u128::try_from(now.saturating_sub(opened_at).max(0)).map_err(|_| CoreError::Math)?;
    let den = BPS.checked_mul(YEAR_SECS).ok_or(CoreError::Math)?;
    let extra = (apy_bps as u128)
        .checked_mul(elapsed)
        .and_then(|x| x.checked_mul(speedup as u128))
        .ok_or(CoreError::Math)?;
    Ok(Growth {
        num: den.checked_add(extra).ok_or(CoreError::Math)?,
        den,
    })
}

/// Accrued Yield of one Position, in source-asset units.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccruedYield {
    pub gross: u64,
    /// The Yield Fee, floored so rounding favours the Position.
    pub fee: u64,
    /// What counts toward Debt and free yield: `gross - fee`.
    pub net: u64,
}

/// `Principal * (growth - 1)` floored, split by [`split_yield_fee`]. A growth below 1 gives zero.
pub fn accrued_yield_at(principal: u64, growth: Growth, fee_bps: u16) -> CoreResult<AccruedYield> {
    if growth.den == 0 {
        return Err(CoreError::Math);
    }
    let gross = to_u64(mul_div_floor(
        principal as u128,
        growth.num.saturating_sub(growth.den),
        growth.den,
    )?)?;
    let (net, fee) = split_yield_fee(gross, fee_bps)?;
    Ok(AccruedYield { gross, fee, net })
}

/// A Source with its derived yield, and the yield left over for the owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceNow {
    /// The Source with `yield_units` set to what a crank would have stored.
    pub source: Source,
    /// Accrued Yield beyond what the Source still owed, units: belongs to the owner.
    pub free_units: u64,
}

impl SourceNow {
    pub fn debt(&self) -> u64 {
        self.source.debt()
    }
    pub fn redeemable(&self) -> u64 {
        self.source.redeemable()
    }
    pub fn redeemable_for(&self, held: u64) -> u64 {
        self.source.redeemable_for(held)
    }
}

/// Debt and redeemable of `source` now. `net_accrued` is the Position's net Accrued Yield and
/// `applied_before` the net yield already consumed by earlier Sources of the Position (zero for
/// its first); the Source counts `min(net_accrued - applied_before, units owed)`, the same rule
/// `Position::apply_yield` applied per crank.
pub fn source_now(source: &Source, net_accrued: u64, applied_before: u64) -> CoreResult<SourceNow> {
    let counted = net_accrued.saturating_sub(applied_before);
    let owed = source.units_to_repay_total()?;
    let units = counted.min(owed);
    let mut source = source.clone();
    source.yield_units = units;
    Ok(SourceNow {
        source,
        free_units: counted - units,
    })
}

/// Pool-wide totals behind the Treasury's Yield Fee claim. Change only on open and unlock.
///
/// Each Position carries its own APY and Yield Fee, both fixed at open, so the totals are weighted
/// by them: `w = Principal * rate_bps * fee_bps`. A fee (or APY) change therefore affects only
/// Positions opened afterwards, and the claim stays at most the sum of the per-Position fees.
/// `speedup` is the one value read live (a devnet constant by founder decision).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct PoolTotals {
    /// `sum Principal` of Locked Positions (informational).
    pub principal: u128,
    /// `W = sum Principal * rate_bps * fee_bps` of Locked Positions.
    pub fee_weight: u128,
    /// `WT = sum Principal * rate_bps * fee_bps * opened_at` of Locked Positions.
    pub fee_weight_time: u128,
    /// Yield Fees of Positions already unlocked, units.
    pub realised_fee: u128,
    /// Number of Locked Positions in the totals; sizes the rounding allowance.
    pub open_positions: u64,
}

fn weight(principal: u64, rate_bps: u16, fee_bps: u16) -> CoreResult<u128> {
    (principal as u128)
        .checked_mul(rate_bps as u128)
        .and_then(|x| x.checked_mul(fee_bps as u128))
        .ok_or(CoreError::Math)
}

impl PoolTotals {
    pub fn add_position(
        &mut self,
        principal: u64,
        opened_at: i64,
        rate_bps: u16,
        fee_bps: u16,
    ) -> CoreResult<()> {
        if fee_bps > MAX_YIELD_FEE_BPS {
            return Err(CoreError::InvalidBps);
        }
        let at = u128::try_from(opened_at).map_err(|_| CoreError::Math)?;
        let w = weight(principal, rate_bps, fee_bps)?;
        let p = self
            .principal
            .checked_add(principal as u128)
            .ok_or(CoreError::Math)?;
        let fw = self.fee_weight.checked_add(w).ok_or(CoreError::Math)?;
        let fwt = w
            .checked_mul(at)
            .and_then(|x| self.fee_weight_time.checked_add(x))
            .ok_or(CoreError::Math)?;
        let n = self.open_positions.checked_add(1).ok_or(CoreError::Math)?;
        self.principal = p;
        self.fee_weight = fw;
        self.fee_weight_time = fwt;
        self.open_positions = n;
        Ok(())
    }

    /// Removes a Position (same arguments as [`PoolTotals::add_position`]) and books its fee
    /// (computed by the caller with [`accrued_yield_at`]) into the realised total.
    pub fn remove_position(
        &mut self,
        principal: u64,
        opened_at: i64,
        rate_bps: u16,
        fee_bps: u16,
        fee: u64,
    ) -> CoreResult<()> {
        let at = u128::try_from(opened_at).map_err(|_| CoreError::Math)?;
        let w = weight(principal, rate_bps, fee_bps)?;
        let p = self
            .principal
            .checked_sub(principal as u128)
            .ok_or(CoreError::Math)?;
        let fw = self.fee_weight.checked_sub(w).ok_or(CoreError::Math)?;
        let fwt = w
            .checked_mul(at)
            .and_then(|x| self.fee_weight_time.checked_sub(x))
            .ok_or(CoreError::Math)?;
        let realised = self
            .realised_fee
            .checked_add(fee as u128)
            .ok_or(CoreError::Math)?;
        let n = self.open_positions.checked_sub(1).ok_or(CoreError::Math)?;
        self.principal = p;
        self.fee_weight = fw;
        self.fee_weight_time = fwt;
        self.realised_fee = realised;
        self.open_positions = n;
        Ok(())
    }

    /// Yield Fee earned by the Treasury at `now`, units: `speedup * (W*now - WT) / (BPS^2 * YEAR)`
    /// over Locked Positions, plus the realised total. Conservative: never more than the sum of
    /// the per-Position fees. With N open Positions the pooled value is at most the exact fee `E`,
    /// while the per-Position sum exceeds `E - 1.5N` (each Position floors its gross and its fee).
    /// Subtracting an allowance of `2N` therefore gives `sum - (2N + 2) <= earned <= sum` (realised
    /// fees of unlocked Positions are exact and added on top).
    pub fn earned_fee(&self, now: i64, speedup: u32) -> CoreResult<u64> {
        let now = u128::try_from(now).map_err(|_| CoreError::Math)?;
        let weighted = self
            .fee_weight
            .checked_mul(now)
            .and_then(|x| x.checked_sub(self.fee_weight_time))
            .and_then(|x| x.checked_mul(speedup as u128))
            .ok_or(CoreError::Math)?;
        let live = mul_div_floor(
            weighted,
            1,
            BPS.checked_mul(BPS)
                .and_then(|x| x.checked_mul(YEAR_SECS))
                .ok_or(CoreError::Math)?,
        )?
        .saturating_sub((self.open_positions as u128).saturating_mul(2));
        to_u64(live.checked_add(self.realised_fee).ok_or(CoreError::Math)?)
    }

    /// Earned minus already withdrawn, never negative.
    pub fn withdrawable(&self, now: i64, speedup: u32, withdrawn: u64) -> CoreResult<u64> {
        Ok(self.earned_fee(now, speedup)?.saturating_sub(withdrawn))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const SOL: u64 = 1_000_000_000;
    const MONTH_REAL: i64 = 600;
    const FEE: u16 = 2_000;
    const T0: i64 = 1_800_000_000;

    fn net_at(principal: u64, apy: u16, secs: i64) -> AccruedYield {
        let g = growth_since_open(apy, T0, T0 + secs, DEVNET_SPEEDUP).unwrap();
        accrued_yield_at(principal, g, FEE).unwrap()
    }

    fn position_and_source(principal: u64, apy: u16, months: u8) -> (Position, Source) {
        let mut p =
            Position::new([1; 32], SourceChain::Solana, [7; 32], 9, principal, apy).unwrap();
        let s = p.open_advance([2; 32], months, 150_000_000, FEE).unwrap();
        (p, s)
    }

    #[test]
    fn zero_at_open_and_before() {
        assert_eq!(net_at(10 * SOL, 500, 0), AccruedYield::default());
        let g = growth_since_open(500, T0, T0 - 100, DEVNET_SPEEDUP).unwrap();
        assert_eq!(accrued_yield_at(10 * SOL, g, FEE).unwrap().gross, 0);
    }

    #[test]
    fn equals_sim_lst_linear_formula() {
        // principal * apy * elapsed * speedup / (BPS * YEAR), floored.
        for (p, apy, secs) in [
            (10 * SOL, 495u16, 300i64),
            (7_777_777, 1_234, 12_345),
            (SOL, 500, 6_000),
        ] {
            let expect = (p as u128 * apy as u128 * secs as u128 * 4_380) / (10_000 * 31_536_000);
            assert_eq!(net_at(p, apy, secs).gross as u128, expect);
        }
    }

    #[test]
    fn mid_horizon_and_one_month() {
        // 10 SOL at 4.95% for one sim month (600 s): 10e9 * 0.0495 / 12 = 41_250_000.
        let a = net_at(10 * SOL, 495, MONTH_REAL);
        assert_eq!(a.gross, 41_250_000);
        assert_eq!(a.fee, 8_250_000);
        assert_eq!(a.net, 33_000_000);
        assert_eq!(net_at(10 * SOL, 495, MONTH_REAL / 2).gross, 20_625_000);
    }

    #[test]
    fn fee_split_floors_in_favour_of_position() {
        let g = Growth {
            num: 10_000 + 1,
            den: 10_000,
        };
        let a = accrued_yield_at(5_003, g, FEE).unwrap(); // gross 0
        assert_eq!(a.gross, 0);
        let g = Growth { num: 3, den: 2 };
        let a = accrued_yield_at(11, g, 3_333).unwrap(); // gross 5, fee floor(1.66)=1
        assert_eq!((a.gross, a.fee, a.net), (5, 1, 4));
        assert_eq!(accrued_yield_at(1, g, 5_001), Err(CoreError::InvalidBps));
    }

    #[test]
    fn falling_rate_gives_zero() {
        let g = Growth { num: 9, den: 10 };
        assert_eq!(
            accrued_yield_at(1_000, g, FEE).unwrap(),
            AccruedYield::default()
        );
        assert_eq!(
            accrued_yield_at(1, Growth { num: 1, den: 0 }, FEE),
            Err(CoreError::Math)
        );
    }

    #[test]
    fn debt_falls_to_zero_exactly_at_the_horizon() {
        for months in 1..=12u8 {
            for (principal, apy) in [
                (10 * SOL, 495u16),
                (3 * SOL + 17, 500),
                (1_000_000_003, 1_234),
            ] {
                let (_, s) = position_and_source(principal, apy, months);
                let horizon = months as i64 * MONTH_REAL;
                let at = net_at(principal, apy, horizon).net;
                let now = source_now(&s, at, 0).unwrap();
                eprintln!(
                    "issued {} owed {} at {}",
                    s.issued,
                    s.units_to_repay_total().unwrap(),
                    at
                );
                assert_eq!(now.debt(), 0, "months {months} principal {principal}");
                assert_eq!(now.redeemable(), s.issued);
                assert_eq!(now.redeemable_for(s.issued), s.issued);
                // Before the Horizon Debt is still open; it never increases.
                let before = net_at(principal, apy, horizon - MONTH_REAL / 2).net;
                let mid = source_now(&s, before, 0).unwrap();
                assert!(mid.debt() > 0 || s.issued < 2);
                assert!(mid.debt() >= now.debt());
            }
        }
    }

    #[test]
    fn debt_at_open_is_the_whole_advance_and_long_after_is_free_yield() {
        let (_, s) = position_and_source(10 * SOL, 495, 3);
        let at_open = source_now(&s, 0, 0).unwrap();
        assert_eq!(at_open.debt(), s.issued);
        assert_eq!(at_open.redeemable(), 0);
        assert_eq!(at_open.free_units, 0);
        let long = net_at(10 * SOL, 495, 100 * MONTH_REAL);
        let now = source_now(&s, long.net, 0).unwrap();
        assert_eq!(now.debt(), 0);
        assert_eq!(now.source.yield_units, s.units_to_repay_total().unwrap());
        assert_eq!(now.free_units + now.source.yield_units, long.net);
        assert!(now.free_units > 0);
    }

    #[test]
    fn matches_crank_apply_yield() {
        let (mut p, mut s) = position_and_source(10 * SOL, 495, 6);
        for (i, secs) in [60i64, 900, 2_000, 3_600, 9_000].into_iter().enumerate() {
            let a = net_at(10 * SOL, 495, secs).net;
            p.apply_yield(Some(&mut s), i as u64 + 1, a).unwrap();
            let derived = source_now(
                &Source {
                    yield_units: 0,
                    ..s.clone()
                },
                a,
                0,
            )
            .unwrap();
            assert_eq!(derived.source.yield_units, s.yield_units);
            assert_eq!(derived.debt(), s.debt());
            assert_eq!(derived.free_units, p.free_yield);
        }
    }

    #[test]
    fn later_source_counts_only_yield_after_earlier_ones() {
        let (_, s) = position_and_source(10 * SOL, 495, 1);
        let owed = s.units_to_repay_total().unwrap();
        let now = source_now(&s, owed + 5, owed).unwrap();
        assert_eq!(now.source.yield_units, 5);
        assert_eq!(
            source_now(&s, owed, owed + 1).unwrap().source.yield_units,
            0
        );
    }

    #[test]
    fn treasury_claim_empty_and_at_open() {
        let mut t = PoolTotals::default();
        assert_eq!(t.earned_fee(T0, DEVNET_SPEEDUP).unwrap(), 0);
        t.add_position(10 * SOL, T0, 495, FEE).unwrap();
        assert_eq!(t.earned_fee(T0, DEVNET_SPEEDUP).unwrap(), 0);
        assert_eq!(
            t.earned_fee(T0 + MONTH_REAL, DEVNET_SPEEDUP).unwrap(),
            8_249_998
        );
        assert_eq!(
            t.withdrawable(T0 + MONTH_REAL, DEVNET_SPEEDUP, 3_000_000)
                .unwrap(),
            5_249_998
        );
        assert_eq!(
            t.withdrawable(T0 + MONTH_REAL, DEVNET_SPEEDUP, u64::MAX)
                .unwrap(),
            0
        );
    }

    #[test]
    fn unlock_realises_the_fee_and_leaves_the_claim_unchanged() {
        let mut t = PoolTotals::default();
        t.add_position(10 * SOL, T0, 495, FEE).unwrap();
        t.add_position(4 * SOL, T0 + 100, 495, FEE).unwrap();
        let now = T0 + 1_000;
        let before = t.earned_fee(now, DEVNET_SPEEDUP).unwrap();
        let g = growth_since_open(495, T0, now, DEVNET_SPEEDUP).unwrap();
        let a = accrued_yield_at(10 * SOL, g, FEE).unwrap();
        t.remove_position(10 * SOL, T0, 495, FEE, a.fee).unwrap();
        let after = t.earned_fee(now, DEVNET_SPEEDUP).unwrap();
        assert!(before.abs_diff(after) <= 4, "{before} vs {after}");
        // The unlocked Position no longer grows the claim.
        let later = t.earned_fee(now + 600, DEVNET_SPEEDUP).unwrap();
        let single = {
            let mut s = PoolTotals::default();
            s.add_position(4 * SOL, T0 + 100, 495, FEE).unwrap();
            s.earned_fee(now + 600, DEVNET_SPEEDUP).unwrap()
        };
        assert_eq!(later, single + a.fee);
        assert_eq!(
            t.remove_position(u64::MAX, T0, 495, FEE, 0),
            Err(CoreError::Math)
        );
    }

    proptest! {
        #[test]
        fn pool_claim_matches_sum_of_position_fees(
            positions in prop::collection::vec((1u64..=10_000 * SOL, 0i64..2_000_000), 1..40),
            apy in 1u16..=3_000,
            fee in 0u16..=MAX_YIELD_FEE_BPS,
            horizon in 0i64..5_000_000,
        ) {
            let now = T0 + 2_000_000 + horizon;
            let mut t = PoolTotals::default();
            let mut sum = 0u128;
            for (p, off) in &positions {
                t.add_position(*p, T0 + off, apy, fee).unwrap();
                let g = growth_since_open(apy, T0 + off, now, DEVNET_SPEEDUP).unwrap();
                sum += accrued_yield_at(*p, g, fee).unwrap().fee as u128;
            }
            let pool = t.earned_fee(now, DEVNET_SPEEDUP).unwrap() as u128;
            let n = positions.len() as u128;
            prop_assert!(sum <= pool + 2 + 2 * n, "pool {pool} sum {sum}");
            prop_assert!(pool <= sum, "pool {pool} sum {sum}");
        }

        #[test]
        fn open_then_unlock_everything_returns_to_zero_totals(
            positions in prop::collection::vec((1u64..=u64::MAX / 64, 0i64..1_000_000), 1..20),
        ) {
            let mut t = PoolTotals::default();
            for (p, off) in &positions { t.add_position(*p, T0 + off, 495, FEE).unwrap(); }
            for (p, off) in &positions { t.remove_position(*p, T0 + off, 495, FEE, 0).unwrap(); }
            prop_assert_eq!((t.principal, t.fee_weight, t.fee_weight_time), (0, 0, 0));
        }
    }

    #[test]
    fn overflow_returns_errors_never_panics() {
        // Long elapsed time, huge speedup.
        let huge = growth_since_open(u16::MAX, 0, i64::MAX, u32::MAX).unwrap();
        assert_eq!(accrued_yield_at(u64::MAX, huge, FEE), Err(CoreError::Math));
        // Gross does not fit in u64.
        let g = growth_since_open(u16::MAX, 0, 4_000_000_000, 1_000_000).unwrap();
        assert_eq!(accrued_yield_at(u64::MAX, g, FEE), Err(CoreError::Math));
        // Max principal, long time, but still representable: no panic either way.
        let g = growth_since_open(500, T0, T0 + 10 * 31_536_000, DEVNET_SPEEDUP).unwrap();
        let _ = accrued_yield_at(u64::MAX, g, FEE);
        // Pool totals at the limit.
        let mut t = PoolTotals::default();
        for _ in 0..4 {
            t.add_position(u64::MAX, T0, u16::MAX, FEE).unwrap();
        }
        assert!(t.earned_fee(T0 + i64::MAX / 2, u32::MAX).is_err());
        assert!(t.earned_fee(-1, DEVNET_SPEEDUP).is_err());
        let mut big = PoolTotals {
            principal: u128::MAX,
            fee_weight: 0,
            fee_weight_time: 0,
            realised_fee: 0,
            open_positions: 0,
        };
        assert_eq!(big.add_position(1, T0, 495, FEE), Err(CoreError::Math));
        big.principal = 0;
        big.fee_weight_time = u128::MAX;
        assert_eq!(
            big.add_position(2, i64::MAX, 495, FEE),
            Err(CoreError::Math)
        );
        assert_eq!(big.add_position(1, -1, 495, FEE), Err(CoreError::Math));
        assert_eq!(
            big.add_position(1, T0, 495, 5_001),
            Err(CoreError::InvalidBps)
        );
    }
}
