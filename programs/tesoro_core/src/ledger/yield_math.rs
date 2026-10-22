//! Accrued Yield computed on the spot (ADR 0010): nothing here is recorded by a crank.
//!
//! * `growth_since_open` is the single place the network matters. Devnet:
//!   `1 + APY * (now - opened_at) * speedup / YEAR`. Mainnet will return
//!   `Staking Rate now / Staking Rate at open` through the same [`Growth`] ratio.
//! * `Accrued Yield = Principal * (growth - 1)`, gross: the Yield Fee is taken at cash-out
//!   (ticket 31, `ledger::yield_fee`), never from yield as it accrues.
//! * Debt and redeemable are derived from the Accrued Yield counted toward a Source, so they
//!   equal what the stored `Source.yield_units` would have been after a crank.

use super::*;

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

/// Accrued Yield of one Position, source-asset units: `Principal * (growth - 1)` floored. A growth
/// below 1 gives zero. All of it counts toward Debt and free yield (Gemas are 100% of the yield).
pub fn accrued_yield_at(principal: u64, growth: Growth) -> CoreResult<u64> {
    if growth.den == 0 {
        return Err(CoreError::Math);
    }
    to_u64(mul_div_floor(
        principal as u128,
        growth.num.saturating_sub(growth.den),
        growth.den,
    )?)
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

/// Debt and redeemable of `source` now. `net_accrued` is the Position's Accrued Yield and
/// `applied_before` the yield already consumed by earlier Sources of the Position (zero for
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

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    const MONTH_REAL: i64 = 600;
    const T0: i64 = 1_800_000_000;

    fn net_at(principal: u64, apy: u16, secs: i64) -> u64 {
        let g = growth_since_open(apy, T0, T0 + secs, DEVNET_SPEEDUP).unwrap();
        accrued_yield_at(principal, g).unwrap()
    }

    fn position_and_source(principal: u64, apy: u16, months: u8) -> (Position, Source) {
        let mut p =
            Position::new([1; 32], SourceChain::Solana, [7; 32], 9, principal, apy).unwrap();
        let s = p.open_advance([2; 32], months, 150_000_000).unwrap();
        (p, s)
    }

    #[test]
    fn zero_at_open_and_before() {
        assert_eq!(net_at(10 * SOL, 500, 0), 0);
        let g = growth_since_open(500, T0, T0 - 100, DEVNET_SPEEDUP).unwrap();
        assert_eq!(accrued_yield_at(10 * SOL, g).unwrap(), 0);
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
            assert_eq!(net_at(p, apy, secs) as u128, expect);
        }
    }

    #[test]
    fn mid_horizon_and_one_month() {
        // 10 SOL at 4.95% for one sim month (600 s): 10e9 * 0.0495 / 12 = 41_250_000.
        // Gross: no Yield Fee is taken while yield accrues (ticket 31).
        assert_eq!(net_at(10 * SOL, 495, MONTH_REAL), 41_250_000);
        assert_eq!(net_at(10 * SOL, 495, MONTH_REAL / 2), 20_625_000);
    }

    #[test]
    fn accrued_yield_floors() {
        let g = Growth {
            num: 10_000 + 1,
            den: 10_000,
        };
        assert_eq!(accrued_yield_at(5_003, g).unwrap(), 0);
        let g = Growth { num: 3, den: 2 };
        assert_eq!(accrued_yield_at(11, g).unwrap(), 5);
    }

    #[test]
    fn falling_rate_gives_zero() {
        let g = Growth { num: 9, den: 10 };
        assert_eq!(accrued_yield_at(1_000, g).unwrap(), 0);
        assert_eq!(
            accrued_yield_at(1, Growth { num: 1, den: 0 }),
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
                let at = net_at(principal, apy, horizon);
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
                let before = net_at(principal, apy, horizon - MONTH_REAL / 2);
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
        let now = source_now(&s, long, 0).unwrap();
        assert_eq!(now.debt(), 0);
        assert_eq!(now.source.yield_units, s.units_to_repay_total().unwrap());
        assert_eq!(now.free_units + now.source.yield_units, long);
        assert!(now.free_units > 0);
    }

    #[test]
    fn matches_crank_apply_yield() {
        let (mut p, mut s) = position_and_source(10 * SOL, 495, 6);
        for (i, secs) in [60i64, 900, 2_000, 3_600, 9_000].into_iter().enumerate() {
            let a = net_at(10 * SOL, 495, secs);
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
    fn overflow_returns_errors_never_panics() {
        // Long elapsed time, huge speedup.
        let huge = growth_since_open(u16::MAX, 0, i64::MAX, u32::MAX).unwrap();
        assert_eq!(accrued_yield_at(u64::MAX, huge), Err(CoreError::Math));
        // Gross does not fit in u64.
        let g = growth_since_open(u16::MAX, 0, 4_000_000_000, 1_000_000).unwrap();
        assert_eq!(accrued_yield_at(u64::MAX, g), Err(CoreError::Math));
        // Max principal, long time, but still representable: no panic either way.
        let g = growth_since_open(500, T0, T0 + 10 * 31_536_000, DEVNET_SPEEDUP).unwrap();
        let _ = accrued_yield_at(u64::MAX, g);
    }
}
