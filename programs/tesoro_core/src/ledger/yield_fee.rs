//! The Yield Fee at cash-out (ticket 31, founder 2026-10-22).
//!
//! Gemas are worth 100% of their yield. The Yield Fee is taken once, when yield leaves Tesoro:
//! a Redeem, the ready part of an Instant Redeem, the Treasury redeeming Gemas it bought, and the
//! owner's free yield at Unlock. Fee Gemas (Platform, Studio, Leaderboard classes) and prize Gemas
//! are exempt; so is everything Tesoro itself receives.

use super::book::wide::{mul_div_u128, Round};
use super::line_store::CLASS_GENERAL;
use super::{CoreError, CoreResult, Source, BPS, MAX_INSTANT_FEE_BPS, MAX_YIELD_FEE_BPS};

/// Where the shares of one cash-out go: `payout` to whoever cashes out, `fee` to the Treasury, of
/// which `pool` is owed to the Leaderboard Pool. `payout + fee` is what was redeemed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CashOut {
    pub payout: u128,
    pub fee: u128,
    pub pool: u128,
}

fn floor_bps(v: u128, bps: u128) -> CoreResult<u128> {
    mul_div_u128(v, bps, BPS, Round::Down).ok_or(CoreError::Math)
}

/// Splits `paid` redeemed shares (or units) with one floor (red-team #9): the payout is
/// `floor(paid * (1 - yield_fee))`, the fee takes the remainder, the Pool `floor(fee * pool_bps)`.
pub fn cash_out(paid: u128, yield_fee_bps: u16, pool_bps: u16) -> CoreResult<CashOut> {
    if yield_fee_bps > MAX_YIELD_FEE_BPS || u128::from(pool_bps) > BPS {
        return Err(CoreError::InvalidBps);
    }
    let keep = BPS
        .checked_sub(u128::from(yield_fee_bps))
        .ok_or(CoreError::Math)?;
    let payout = floor_bps(paid, keep)?;
    let fee = paid.checked_sub(payout).ok_or(CoreError::Math)?;
    let pool = floor_bps(fee, u128::from(pool_bps))?;
    Ok(CashOut { payout, fee, pool })
}

/// The Yield Fee terms of cashing out a line of `class` of `src`: fee classes (Platform, Studio,
/// Leaderboard) are exempt; General and Extension lines pay the Source's snapshot, whoever holds
/// them (the Treasury included).
pub fn exit_terms(src: &Source, class: u8) -> (u16, u16) {
    if class < CLASS_GENERAL {
        (0, 0)
    } else {
        (src.yield_fee_bps, src.pool_bps)
    }
}

/// What an Instant Redeem fill pays for Gemas worth `value` at fill: the Yield Fee and the Instant
/// Redeem Fee both come off, with one floor (1,000 Gemas worth $10 pay $6.00 at 20% and 25%).
pub fn instant_payout(value: u128, yield_fee_bps: u16, instant_fee_bps: u16) -> CoreResult<u128> {
    if yield_fee_bps > MAX_YIELD_FEE_BPS || instant_fee_bps > MAX_INSTANT_FEE_BPS {
        return Err(CoreError::InvalidBps);
    }
    let after_yield = BPS
        .checked_sub(u128::from(yield_fee_bps))
        .ok_or(CoreError::Math)?;
    let after_instant = BPS
        .checked_sub(u128::from(instant_fee_bps))
        .ok_or(CoreError::Math)?;
    let keep = after_yield
        .checked_mul(after_instant)
        .ok_or(CoreError::Math)?;
    mul_div_u128(value, keep, BPS * BPS, Round::Down).ok_or(CoreError::Math)
}

/// The Pool's share of the Instant Redeem Fee: always one fifth of it (founder, 2026-10-22), so the
/// Tesoro:Pool split stays 4:1 if the fee changes. Rounds toward Tesoro.
pub fn instant_pool_bps(instant_fee_bps: u16) -> u16 {
    instant_fee_bps / 5
}

/// The Treasury redeeming `paid` shares of Gemas it bought in Instant fills: not exempt (red-team
/// #4). The whole `paid` is the Treasury's; the Pool is owed its half of the Yield Fee plus its
/// fifth of the Instant fee on the after-fee value, both from these realised shares only.
pub fn treasury_cash_out(
    paid: u128,
    yield_fee_bps: u16,
    pool_bps: u16,
    instant_fee_bps: u16,
) -> CoreResult<CashOut> {
    if instant_fee_bps > MAX_INSTANT_FEE_BPS {
        return Err(CoreError::InvalidBps);
    }
    let c = cash_out(paid, yield_fee_bps, pool_bps)?;
    let instant = floor_bps(c.payout, u128::from(instant_pool_bps(instant_fee_bps)))?;
    Ok(CashOut {
        pool: c.pool.checked_add(instant).ok_or(CoreError::Math)?,
        ..c
    })
}

/// Routing Gemas through a Studio Fee (exempt) costs Platform + Leaderboard of the pot and saves the
/// Yield Fee on the Studio share: it never pays while `yield_fee * max_studio < platform +
/// leaderboard` (founder 2026-10-22; at launch 20% x 10% = 2% < 3%).
pub fn studio_exemption_safe(
    yield_fee_bps: u16,
    platform_bps: u16,
    leaderboard_bps: u16,
    max_studio_bps: u16,
) -> bool {
    u128::from(yield_fee_bps) * u128::from(max_studio_bps)
        < (u128::from(platform_bps) + u128::from(leaderboard_bps)) * BPS
}

#[cfg(test)]
mod tests {
    use super::*;

    const YF: u16 = 2_000;
    const POOL: u16 = 5_000;

    #[test]
    fn a_redeem_pays_eighty_percent_and_splits_the_fee_with_the_pool() {
        let c = cash_out(1_000, YF, POOL).unwrap();
        assert_eq!((c.payout, c.fee, c.pool), (800, 200, 100));
    }

    #[test]
    fn one_floor_on_the_payout_the_fee_takes_the_remainder() {
        // 7 * 0.8 = 5.6: the holder gets 5, the fee is the other 2, the Pool floor(1.0) = 1.
        let c = cash_out(7, YF, POOL).unwrap();
        assert_eq!((c.payout, c.fee, c.pool), (5, 2, 1));
        let one = cash_out(1, YF, POOL).unwrap();
        assert_eq!((one.payout, one.fee, one.pool), (0, 1, 0));
    }

    #[test]
    fn an_exempt_exit_pays_everything() {
        let c = cash_out(1_000, 0, POOL).unwrap();
        assert_eq!((c.payout, c.fee, c.pool), (1_000, 0, 0));
    }

    #[test]
    fn rates_above_the_caps_are_refused() {
        assert_eq!(cash_out(1, 5_001, POOL), Err(CoreError::InvalidBps));
        assert_eq!(cash_out(1, YF, 10_001), Err(CoreError::InvalidBps));
        assert_eq!(instant_payout(1, YF, 5_001), Err(CoreError::InvalidBps));
    }

    #[test]
    fn instant_pays_sixty_percent_of_face_with_one_floor() {
        // 1,000 Gemas worth $10: $8.00 if you wait, $6.00 now.
        assert_eq!(instant_payout(1_000, YF, 2_500).unwrap(), 600);
        // 7 * 0.6 = 4.2 -> 4. Two chained floors would give floor(floor(5.6) * 0.75) = 3.
        assert_eq!(instant_payout(7, YF, 2_500).unwrap(), 4);
    }

    #[test]
    fn the_treasury_redeeming_bought_gemas_owes_the_pool_its_fee_half_and_a_fifth_of_the_instant_fee(
    ) {
        // Founder example: $8.00 after the Yield Fee; the Pool gets $1.00 of the fee and $0.40 (5 of
        // the 25 points) of the Instant fee.
        let c = treasury_cash_out(1_000, YF, POOL, 2_500).unwrap();
        assert_eq!((c.payout, c.fee, c.pool), (800, 200, 140));
        // Always one fifth (founder): 4 points at 20%, 6 at 30%.
        assert_eq!(treasury_cash_out(1_000, YF, POOL, 2_000).unwrap().pool, 132);
        assert_eq!(treasury_cash_out(1_000, YF, POOL, 3_000).unwrap().pool, 148);
    }

    #[test]
    fn the_pool_part_of_the_instant_fee_rounds_toward_tesoro() {
        // 7 Gemas' worth: after the Yield Fee 5; one fifth of 25% of 5 = 0.25 -> 0. Fee 2, Pool 1.
        assert_eq!(treasury_cash_out(7, YF, POOL, 2_500).unwrap().pool, 1);
    }

    #[test]
    fn the_studio_exemption_never_pays_for_laundering_at_launch_rates() {
        // Routing Gemas through a Studio fee costs Platform + Leaderboard of the pot and saves the
        // Yield Fee on the Studio share: safe while yield_fee * max_studio < platform + leaderboard.
        assert!(studio_exemption_safe(YF, 200, 100, 1_000));
        assert!(!studio_exemption_safe(YF, 100, 50, 1_000));
        assert!(!studio_exemption_safe(YF, 150, 50, 1_000));
    }
}
