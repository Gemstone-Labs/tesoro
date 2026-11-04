use super::*;
use crate::ledger::lifecycle::Terms;

/// Railcar's terms: Platform 2%, Studio 3% (Tesoro's own, a senior class).
fn terms(platform_bps: u16, studio_bps: u16) -> Terms {
    Terms {
        platform_bps,
        studio_bps,
        studio_owner: None,
        studio_priority: true,
    }
}

const LB: u16 = 100;

#[test]
fn the_worked_example_pays_to_the_gema() {
    // Ana refunded 350 of 500; Dee, Ben, Cy placed 60/25/15; Eve aboard at Impact.
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 350, &terms(200, 300), LB).unwrap();
    assert_eq!(p.fees.iter().sum::<u64>(), 129);
    assert_eq!(p.fees, [44, 64, 21]);
    assert_eq!(p.forfeited, 650);
    assert_eq!(&p.won[..3], &[313, 130, 78]);
    assert!(p.won[3..].iter().all(|w| *w == 0));
    assert!(!p.fees_capped);
}

#[test]
fn without_the_early_jump_the_rounding_gema_goes_to_first_place() {
    // P 2,500, fees 150, 850 to share: 510 / 212.5 / 127.5 floored, the 1 left to first place.
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 0, &terms(200, 300), LB).unwrap();
    assert_eq!(p.fees, [50, 75, 25]);
    assert_eq!(&p.won[..3], &[511, 212, 127]);
}

#[test]
fn two_places_split_seventy_thirty() {
    // Ana refunded 350; Dee and Ben placed; Cy and Eve aboard: F = 1,150, fees 129, 1,021 to share.
    let p = plan_payout(500, 5, &[7000, 3000], 350, &terms(200, 300), LB).unwrap();
    assert_eq!(p.fees, [44, 64, 21]);
    assert_eq!(p.forfeited, 1_150);
    assert_eq!(&p.won[..2], &[715, 306]);
}

#[test]
fn one_place_takes_everything_after_fees() {
    let p = plan_payout(500, 5, &[10_000], 350, &terms(200, 300), LB).unwrap();
    assert_eq!(p.forfeited, 1_650);
    assert_eq!(p.won[0], 1_650 - 129);
}

#[test]
fn head_to_head_in_this_shape_gives_todays_numbers() {
    // winner 100%, loser nothing: fees 6% of both entries, all from the loser
    let p = plan_payout(500, 2, &[10_000], 0, &terms(200, 300), LB).unwrap();
    assert_eq!((p.fees, p.won[0]), ([20, 30, 10], 440));
    let p = plan_payout(1_000, 2, &[10_000], 0, &terms(200, 300), LB).unwrap();
    assert_eq!((p.fees, p.won[0]), ([40, 60, 20], 880));
}

#[test]
fn fees_are_capped_at_the_forfeits_platform_first() {
    // 44% fees; two early refunds of 400: P 1,700 asks 748, but only 200 is forfeited.
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 800, &terms(4_000, 300), LB).unwrap();
    assert_eq!(p.forfeited, 200);
    assert_eq!(p.fees, [200, 0, 0]);
    assert_eq!(&p.won[..3], &[0, 0, 0]);
    assert!(p.fees_capped);
}

#[test]
fn a_cap_shortens_the_later_fee_classes_first() {
    // 30% fees on P 1,800 = 540 (Platform 432, Studio 54, Leaderboard 54); forfeited 300
    let p = plan_payout(500, 5, &[6000, 2500, 1500], 700, &terms(2_400, 300), 300).unwrap();
    assert_eq!(p.forfeited, 300);
    assert_eq!(p.fees, [300, 0, 0]);
    let p = plan_payout(500, 5, &[10_000], 1_500, &terms(2_400, 300), 300).unwrap();
    // P 1,000: Platform 240, Studio 30, Leaderboard 30; forfeited 500, nothing capped
    assert_eq!((p.fees, p.fees_capped, p.won[0]), ([240, 30, 30], false, 200));
    let p = plan_payout(500, 5, &[10_000], 1_740, &terms(2_400, 300), 300).unwrap();
    // P 760: total 228 = Platform 184 + Studio 22 + Leaderboard 22; forfeited 260
    assert_eq!((p.fees, p.fees_capped, p.won[0]), ([184, 22, 22], false, 32));
    let p = plan_payout(500, 5, &[10_000], 1_790, &terms(2_400, 300), 300).unwrap();
    // P 710: Platform 171, Studio 21, Leaderboard 21 (total 213); forfeited 210: Leaderboard cut to 18
    assert_eq!((p.fees, p.fees_capped, p.won[0]), ([171, 21, 18], true, 0));
}

#[test]
fn nothing_forfeited_means_no_fee() {
    // three unplaced seats each refunded in full
    let p = plan_payout(500, 5, &[6000, 4000], 1_500, &terms(200, 300), LB).unwrap();
    assert_eq!((p.forfeited, p.fees), (0, [0, 0, 0]));
    assert_eq!(&p.won[..2], &[0, 0]);
}

#[test]
fn a_result_that_does_not_fit_the_car_is_refused() {
    assert_eq!(
        plan_payout(500, 2, &[5000, 3000, 2000], 0, &terms(200, 300), LB).unwrap_err(),
        SeatError::BadResult
    );
    // refunds above what the unplaced seats put in
    assert_eq!(
        plan_payout(500, 5, &[10_000], 2_001, &terms(200, 300), LB).unwrap_err(),
        SeatError::BadResult
    );
    assert_eq!(
        plan_payout(500, 5, &[10_000], 0, &terms(4_900, 300), LB).unwrap_err(),
        SeatError::FeeTooHigh
    );
}
